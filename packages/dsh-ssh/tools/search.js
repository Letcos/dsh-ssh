// @dsh-ssh/dsh-ssh — search tools (glob/grep) extracted from tools.js via mechanical slice
// Provides searchErrorFor + buildSearchCaps + createGlobTool/createGrepTool for buildRoutedToolDefinitions.
// Plain JS/ESM, no build step.
import { defineTool } from '@deepseek-ai/dsh-tools';
import { routeByCwd, resolveRemotePath } from '../src/router.js';
import { SshError } from '../src/ssh-core.js';
import {
  GLOB_MAX_RESULTS, GREP_MAX_LINE_BYTES, GREP_MAX_MATCHES, RAW_OUTPUT_MAX_BYTES, SEARCH_META_MAX_BYTES,
  SEARCH_TIMEOUT_MS, SearchError,
  buildRemoteGlobCommand, buildRemoteGrepCommand, formatRetainedGrep, globCardPage, globSearchMeta,
  grepSearchMeta, parseGlobArgs, parseGlobOutput, parseGrepArgs, parseGrepOutput,
  presentGlobCall, presentGlobResult, presentGrepCall, presentGrepResult, renderGlobPaths,
  retainGrepMatches, rgGlobToRegExp, toWorkdirRelative,
} from '../src/search.js';
function toolErrorText(err, hostId, extra) {
  const stage = err && err.stage ? ' (' + err.stage + ')' : '';
  const msg = err && err.message ? err.message : String(err);
  return '[@dsh-ssh/dsh-ssh] host ' + hostId + stage + ': ' + msg + (extra ? ' [' + extra + ']' : '');
}

export function searchErrorFor(err, hostId, toolName, cmd) {
  if (err instanceof SearchError) return err;
  if (err instanceof SshError || (err && err.name === 'SshError')) {
    if (err.stage === 'exec-timeout') return new SearchError(toolName + ' search timed out on remote (host ' + hostId + '): ' + err.message, 'SEARCH_ABORTED');
    if (err.stage === 'exec-output-overflow') return new SearchError(toolName + ' search produced too much output (host ' + hostId + '); narrow pattern, path, or include', 'SEARCH_RAW_OUTPUT_OVERFLOW');
    return new Error(toolErrorText(err, hostId, 'command: ' + cmd));
  }
  return new Error(toolErrorText(err, hostId, 'command: ' + cmd));
}

// searchCaps verbatim from tools.js:532-540 wrapped as factory
export function buildSearchCaps(config = {}) {
  return {
    sampleOverCapGlobResults: config.sampleOverCapGlobResults ?? false,
    maxResults: config.globMaxResults ?? GLOB_MAX_RESULTS,
    maxMatches: config.grepMaxMatches ?? GREP_MAX_MATCHES,
    maxLineBytes: config.grepMaxLineBytes ?? GREP_MAX_LINE_BYTES,
    maxMetaBytes: config.searchMetaMaxBytes ?? SEARCH_META_MAX_BYTES,
    rawOutputMaxBytes: config.searchRawOutputMaxBytes ?? RAW_OUTPUT_MAX_BYTES,
    timeoutMs: config.searchTimeoutMs ?? SEARCH_TIMEOUT_MS,
  };
}
export function createGlobTool({ ctx, searchCaps, delegateLocal, acquireRemote, abortIfSignalled }) {
  return defineTool({
    name: 'glob',
    description: `Find files whose paths match a glob pattern. Returns matching file paths — never directories — including hidden and ignored files (VCS metadata directories are excluded). Up to ${searchCaps.maxResults} paths come back in modification-time order; a larger result keeps the first ${searchCaps.maxResults} in modification-time order and says so (remote workspaces cannot spill the complete list; narrow the pattern or path to see more). This tool does not enumerate directory entries.`,
    parameters: {
      pattern: { type: 'string', required: true, description: 'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a separator to anchor the depth.' },
      path: { type: 'string', description: 'Directory to search in. Defaults to the session workspace; a relative path resolves against it.' },
    },
    timeoutMs: searchCaps.timeoutMs,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        root: { type: 'string', required: true },
        paths: { type: 'array', required: true, items: { type: 'string' } },
      } },
      render: (_args, value) => [{ type: 'text', text: renderGlobPaths(value.paths, searchCaps.maxResults) }],
      presentationMeta: (_args, value) => {
        const page = globCardPage(value.paths, searchCaps.maxResults);
        return globSearchMeta(page, value.paths.length, searchCaps.maxMetaBytes);
      },
    },
    async execute(args, exec) {
      const input = parseGlobArgs(args);
      const cwd = exec.agent?.session?.header?.cwd;
      const route = routeByCwd(cwd);
      if (route.kind === 'local') return delegateLocal('glob', args, exec);
      abortIfSignalled(exec);
      const { pool, conn } = await acquireRemote(ctx, route.hostId);
      const root = input.path === undefined ? route.remoteCwd : resolveRemotePath(input.path, route.remoteCwd, cwd);
      const cmd = buildRemoteGlobCommand(root, input.pattern);
      const matcher = rgGlobToRegExp(input.pattern);
      try {
        const r = await conn.exec(cmd, { timeoutMs: searchCaps.timeoutMs, maxStdoutBytes: searchCaps.rawOutputMaxBytes });
        if (r.code !== 0) throw new SearchError('glob search failed on remote (exit ' + r.code + ', host ' + route.hostId + ')' + (r.stderr.trim() ? ': ' + r.stderr.trim().slice(0, 400) : ''), 'SEARCH_FAILED');
        const paths = [];
        for (const entry of parseGlobOutput(r.stdout)) {
          const display = toWorkdirRelative(entry.path, route.remoteCwd);
          if (matcher.test(display)) paths.push(display);
        }
        return { root: input.path === undefined ? '.' : toWorkdirRelative(root, route.remoteCwd), paths };
      } catch (err) {
        throw searchErrorFor(err, route.hostId, 'glob', cmd);
      } finally {
        pool.release();
      }
    },
    presentCall: presentGlobCall,
    presentResult: presentGlobResult,
  });
}

export function createGrepTool({ ctx, searchCaps, delegateLocal, acquireRemote, abortIfSignalled }) {
  return defineTool({
    name: 'grep',
    description: `Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file. Returns the first ${searchCaps.maxMatches} matches inline; a capped result keeps the head inline and says so (remote workspaces cannot save the complete match list; narrow pattern, path, or include to see more). Use read on a matched file for surrounding context.`,
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regular expression to search for (ripgrep syntax).' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the session workspace; a relative path resolves against it.' },
      include: { type: 'string', description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.' },
    },
    timeoutMs: searchCaps.timeoutMs,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { matches: {
        type: 'array', required: true, items: {
          type: 'object', additionalProperties: false, properties: {
            path: { type: 'string', required: true },
            lineNumber: { type: 'integer', required: true },
            line: { type: 'string', required: true },
          },
        },
      } } },
      render: (_args, value) => [{ type: 'text', text: formatRetainedGrep(retainGrepMatches(value.matches, searchCaps.maxMatches, searchCaps.maxLineBytes)) }],
      presentationMeta: (_args, value) => grepSearchMeta(retainGrepMatches(value.matches, searchCaps.maxMatches, searchCaps.maxLineBytes), searchCaps.maxMetaBytes),
    },
    async execute(args, exec) {
      const input = parseGrepArgs(args);
      const cwd = exec.agent?.session?.header?.cwd;
      const route = routeByCwd(cwd);
      if (route.kind === 'local') return delegateLocal('grep', args, exec);
      abortIfSignalled(exec);
      const { pool, conn } = await acquireRemote(ctx, route.hostId);
      const root = input.path === undefined ? route.remoteCwd : resolveRemotePath(input.path, route.remoteCwd, cwd);
      const cmd = buildRemoteGrepCommand(root, input.pattern, input.include);
      try {
        const r = await conn.exec(cmd, { timeoutMs: searchCaps.timeoutMs, maxStdoutBytes: searchCaps.rawOutputMaxBytes });
        if (r.code === 2) {
          const stderr = r.stderr.trim();
          if (/invalid|error|usage/i.test(stderr)) throw new SearchError('grep pattern rejected by remote grep (host ' + route.hostId + '): ' + stderr.slice(0, 400), 'SEARCH_INVALID_PATTERN');
          throw new SearchError('grep search failed on remote (exit 2, host ' + route.hostId + '): ' + stderr.slice(0, 400), 'SEARCH_FAILED');
        }
        if (r.code !== 0 && r.code !== 1) throw new SearchError('grep search failed on remote (exit ' + r.code + ', host ' + route.hostId + ')' + (r.stderr.trim() ? ': ' + r.stderr.trim().slice(0, 400) : ''), 'SEARCH_FAILED');
        const matches = [];
        for (const match of parseGrepOutput(r.stdout)) {
          matches.push({ path: toWorkdirRelative(match.path, route.remoteCwd), lineNumber: match.lineNumber, line: match.line });
        }
        return { matches };
      } catch (err) {
        throw searchErrorFor(err, route.hostId, 'grep', cmd);
      } finally {
        pool.release();
      }
    },
    presentCall: presentGrepCall,
    presentResult: presentGrepResult,
  });
}


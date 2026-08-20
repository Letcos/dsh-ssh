// @dsh-ssh/dsh-ssh — remote same-named tools: bash / read / write / edit / read_image plus cwd routing;
// glob / grep are also defined here, so seven same-named tools in total.
// Exports registerRoutedTools (the registration entry reused by the agent/created hook) and apply(ctx)
// (the local-delegation registration helper, used only by tests and verify scripts).
//
// Routing: exec.agent.session.header.cwd being a placeholder path (~/.dsh/remote/<hostId>/<enc>) → remote
// (SSH); otherwise local → delegate to the host's globally registered same-named tool via
// ctx.tools.get(name).execute(args, exec) (byte-for-byte identical, hard constraint 4). The official tool
// packages (dsh-tool-bash/dsh-tool-fs) do not export a reusable execute function (only
// Config/apply/inject/name), but they are already globally registered in the host composition
// (@deepseek-ai/dsh-base/cordis.patch.yml) — we reuse their registered definitions.
//
// Remote branches:
//   bash       → ctx.sshPool.acquire(hostCfg) → conn.exec(cmd, {cwd, timeoutMs}) → official-shaped ShellRunResult
//   read       → sftp.stat + readText (size-capped) → local buildWindow → official-shaped {path,offset,lines,totalLines}
//   write      → sftp.writeFileAtomic (temp file + rename) → official-shaped {path,operation,before,after}
//   edit       → sftp readText → local applyLiteralEdit semantics → writeFileAtomic write-back (single round trip)
//   read_image → sftp.readBytes (capped) → ctx.attachments.saveImage → official-shaped {path,image}
//   glob       → remote find (conservative -name filter + mtime sort) → local rgGlobToRegExp exact filter → official-shaped {root,paths}
//   grep       → remote grep -rInHE (-I binary / hidden exclusion / include brace expansion / timeout) → official-shaped {matches:[{path,lineNumber,line}]}
// Errors are uniformly converted to a message carrying hostId/stage/remote command/exit code/output tail — never silent.
import { defineTool } from '@deepseek-ai/dsh-tools';
import { FsError } from '@deepseek-ai/dsh-fs';
import { parseExitStatus } from '@deepseek-ai/dsh-shell';
import { ESCALATION_TARGETS, approveEscalation, escalationHintMarker, sandboxDenialMarker, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox';
import { structuredPatch } from 'diff';
import { basename, extname } from 'node:path';
import { routeByCwd, resolveRemotePath } from './src/router.js';
import { mutationDenialMode, sandboxDenialError } from './src/policy.js';
import { SshError } from './src/ssh-core.js';
import { createRemoteBashJobHooks, defaultRemoteJobDir, killForegroundTree } from './src/remote-jobs.js';
import {
  GLOB_MAX_RESULTS, GREP_MAX_LINE_BYTES, GREP_MAX_MATCHES, RAW_OUTPUT_MAX_BYTES, SEARCH_META_MAX_BYTES,
  SEARCH_TIMEOUT_MS, SearchError,
  buildRemoteGlobCommand, buildRemoteGrepCommand, formatRetainedGrep, globCardPage, globSearchMeta,
  grepSearchMeta, parseGlobArgs, parseGlobOutput, parseGrepArgs, parseGrepOutput,
  presentGlobCall, presentGlobResult, presentGrepCall, presentGrepResult, renderGlobPaths,
  retainGrepMatches, rgGlobToRegExp, toWorkdirRelative,
} from './src/search.js';
import { readHostsDoc } from './src/settings.js';

export const name = '@dsh-ssh/dsh-ssh-tools';
// shell/fs are injected to read sandboxMode, matching how the official tools advertise
// sandbox_permissions/justification (official tool-bash injects 'shell', tool-fs injects 'fs').
export const inject = ['tools', 'shell', 'fs'];

// ── read capacity defaults, matching official tool-fs (dsh-tool-fs/lib/index.js) ──
const READ_LIMIT = 2e3;
const READ_MAX_LINE_LENGTH = 2e3;
const READ_MAX_BYTES = 50 * 1024;
const STREAM_MIN_SIZE = 10 * 1024 * 1024;
// Remote read/edit per-file size cap (local read streams unbounded; remote pulls the whole file, so
// memory must be protected — documented limitation)
const REMOTE_MAX_FILE_BYTES = 10 * 1024 * 1024;
const REMOTE_EXEC_DEFAULT_TIMEOUT = 60_000;

// ═══════════════════════════════════════════════════════════════════════════
// bash render / description (verbatim from dsh-tool-bash/lib/index.js)
// ═══════════════════════════════════════════════════════════════════════════
function streamText(output) {
  if (!output.truncated) return output.text;
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? "(unavailable)"}]`;
}

function renderResult(result, escalationModes = []) {
  const out = streamText(result.stdout);
  const err = streamText(result.stderr);
  let body = out;
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith("\n")) body += "\n";
    body += `[stderr]\n${err}`;
  }
  if (body.length === 0) body = "(no output)";
  const markers = [];
  if (result.sandbox?.denied) {
    markers.push(sandboxDenialMarker(result.sandbox.mode));
    if (escalationModes.length > 0) markers.push(escalationHintMarker("command"));
  }
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`);
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`);
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`);
  if (markers.length === 0) return body;
  if (!body.endsWith("\n")) body += "\n";
  return body + markers.join("\n");
}

function bashDescription(backgroundEnabled, escalationModes) {
  const background = backgroundEnabled
    ? "Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`."
    : "Background execution is not available; long-running commands must finish within the timeout.";
  const base = `Execute a bash command (\`bash -c\`) and return its stdout/stderr. Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — pass \`workdir\` instead of using \`cd\`. Non-zero exits are reported as \`[exit code: N]\`. Current harness environment facts are exposed through managed \`$DSH_*\` variables; inspect them when needed. Commands may run under a file sandbox; a blocked file operation is reported as \`[sandbox: file access denied under <mode> mode]\` — a policy denial, not a bug in the command; do not retry another way. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. ` + background + ' In a remote (SSH) workspace there is no sandbox runner on the remote host, so the file-policy write boundary is not enforced per-file there: under read-only the remote command is refused outright, and under workspace-write it runs with the remote user\'s full privileges.';
  if (escalationModes.length === 0) return base;
  return base + " Attempting a command the sandbox may deny is safe and expected: run it and read the marker rather than assuming the denial. When a command is denied and a wider mode would let it succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. Do not detour through chat to ask permission first — the approval prompt raised by that retry is how the user consents. If the session states approval prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. Never escalate speculatively: ground the request in a real denial — normally the one this command just hit; escalating up front is fine only when this session already denied the same access. A rejected escalation is final for that command — stop and explain, never work around it — but it does not forbid attempting or escalating other commands later.";
}

function validateBashArgs(args) {
  if (args.command.trim().length === 0) throw new Error("invalid command: expected a non-empty string");
  if (args.description.trim().length === 0) throw new Error("invalid description: expected a non-empty string");
  if (args.timeoutMs !== void 0 && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`);
}

function presentBashCall(args) {
  if (args.run_in_background === true) return {
    card: "generic", title: args.command, kind: "execute", rawInput: args.command,
    content: [{ type: "text", text: args.description }],
  };
  return {
    card: "terminal", title: args.command, description: args.description,
    ...args.workdir !== void 0 ? { cwd: args.workdir } : {},
  };
}

function presentBashResult(args, result) {
  const block = result.content.length === 1 ? result.content[0] : void 0;
  if (block === void 0 || block.type !== "text") return void 0;
  const raw = block.text;
  if (typeof args === "object" && args !== null && args.run_in_background === true || result.isError) {
    return { card: "generic", content: [{ type: "text", text: `\`\`\`console\n${raw.replace(/\n+$/, "")}\n\`\`\`` }] };
  }
  const { body, ...exit } = parseExitStatus(raw);
  return { card: "terminal", output: body, ...exit };
}

const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: "string", required: true, const: "background" },
  jobId: { type: "string", required: true },
};

function canonicalBashResult(result) {
  const output = (stream) => ({
    text: stream.text, truncated: stream.truncated,
    ...stream.spillPath !== void 0 ? { spillPath: stream.spillPath } : {},
  });
  return {
    exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
    aborted: result.aborted, timeoutMs: result.timeoutMs,
    stdout: output(result.stdout), stderr: output(result.stderr),
    ...result.sandbox !== void 0 ? { sandbox: { mode: result.sandbox.mode, denied: result.sandbox.denied, ...result.sandbox.enforcement !== void 0 ? { enforcement: result.sandbox.enforcement } : {}, ...result.sandbox.runnerFailed !== void 0 ? { runnerFailed: result.sandbox.runnerFailed } : {} } } : {},
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// read window (verbatim from dsh-tool-fs/lib/index.js buildWindow/formatReadOutput)
// ═══════════════════════════════════════════════════════════════════════════
function truncateLine(line, maxLineLength) {
  return line.length > maxLineLength ? `${line.substring(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)` : line;
}
function lineByteSize(line, currentLineCount) {
  return Buffer.byteLength(line, "utf8") + (currentLineCount > 0 ? 1 : 0);
}
function consumeLine(acc, rawLine, request) {
  acc.totalLines += 1;
  if (acc.truncatedByBytes || acc.totalLines < request.offset || acc.lines.length >= request.limit) return;
  const text = truncateLine(rawLine, request.maxLineLength);
  const bytes = lineByteSize(text, acc.lines.length);
  if (acc.outputBytes + bytes > request.maxBytes) { acc.truncatedByBytes = true; return; }
  acc.outputBytes += bytes;
  acc.lines.push({ number: acc.totalLines, text });
}
function stripCarriageReturn(line) { return line.endsWith("\r") ? line.slice(0, -1) : line; }
function finish(acc, request, displayPath) {
  if (!acc.truncatedByBytes && request.offset > acc.totalLines && !(acc.totalLines === 0 && request.offset === 1)) {
    throw new FsError(`offset ${request.offset} is out of range for "${displayPath}" (${acc.totalLines} lines)`, "FS_NOT_FOUND");
  }
  return { lines: acc.lines, totalLines: acc.totalLines, truncatedByBytes: acc.truncatedByBytes };
}
async function buildWindow(chunks, request, displayPath) {
  const acc = { lines: [], totalLines: 0, outputBytes: 0, truncatedByBytes: false };
  const lineBufferCap = request.maxLineLength + 1;
  let lineBuffer = "";
  function appendToLineBuffer(segment) {
    if (lineBuffer.length >= lineBufferCap) return;
    lineBuffer += segment;
    if (lineBuffer.length > lineBufferCap) lineBuffer = lineBuffer.slice(0, lineBufferCap);
  }
  function flushLine() { consumeLine(acc, stripCarriageReturn(lineBuffer), request); lineBuffer = ""; }
  for await (const chunk of chunks) {
    let startPos = 0; let newlinePos;
    while ((newlinePos = chunk.indexOf("\n", startPos)) !== -1) {
      appendToLineBuffer(chunk.slice(startPos, newlinePos));
      flushLine();
      startPos = newlinePos + 1;
    }
    appendToLineBuffer(chunk.slice(startPos));
  }
  if (lineBuffer.length > 0) flushLine();
  return finish(acc, request, displayPath);
}
function formatReadOutput(displayPath, outcome) {
  const endLine = outcome.lines.at(-1)?.number ?? Math.max(0, outcome.offset - 1);
  let footer;
  if (outcome.truncatedByBytes) footer = `(Output capped. Showing lines ${outcome.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`;
  else if (endLine < outcome.totalLines) footer = `(Showing lines ${outcome.offset}-${endLine} of ${outcome.totalLines}. Use offset=${endLine + 1} to continue.)`;
  else footer = `(End of file - total ${outcome.totalLines} lines)`;
  return `<path>${displayPath}</path>\n<type>file</type>\n<content>\n${outcome.lines.length > 0 ? `${outcome.lines.map((line) => `${line.number}: ${line.text}`).join("\n")}\n\n${footer}` : footer}\n</content>`;
}
const LANG_BY_EXTENSION = {
  ts: "ts", tsx: "tsx", mts: "ts", cts: "ts", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
  json: "json", jsonc: "json", py: "py", rb: "rb", go: "go", rs: "rs", java: "java", c: "c",
  h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cxx: "cpp", cs: "cs", kt: "kotlin", swift: "swift",
  php: "php", sh: "sh", bash: "sh", zsh: "sh", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
  md: "md", markdown: "md", mdx: "mdx", html: "html", htm: "html", css: "css", scss: "scss",
  less: "less", sql: "sql", xml: "xml", lua: "lua",
};
function langFromPath(path) {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return void 0;
  const ext = base.slice(dot + 1).toLowerCase();
  return Object.hasOwn(LANG_BY_EXTENSION, ext) ? LANG_BY_EXTENSION[ext] : void 0;
}
function isFileTextLine(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { number, text } = value;
  return typeof number === "number" && Number.isInteger(number) && number >= 1 && typeof text === "string";
}
function readMetaFromMeta(meta) {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return void 0;
  const { path, offset, lines, totalLines, lang } = meta;
  if (typeof path !== "string" || typeof totalLines !== "number" || typeof offset !== "number") return void 0;
  if (!Number.isInteger(offset) || offset < 1) return void 0;
  if (!Number.isInteger(totalLines) || totalLines < 0) return void 0;
  if (!Array.isArray(lines) || !lines.every(isFileTextLine)) return void 0;
  if (lang !== void 0 && typeof lang !== "string") return void 0;
  let previous = offset - 1;
  for (const { number } of lines) { if (number <= previous || number > totalLines) return void 0; previous = number; }
  return { path, offset, lines, totalLines, ...lang === void 0 ? {} : { lang } };
}
function parsePositiveInteger(value, name) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
function parseReadArgs(args, maxLimit) {
  if (args.file_path.trim().length === 0) throw new Error("file_path must be a non-empty string");
  const offset = args.offset === void 0 ? 1 : parsePositiveInteger(args.offset, "offset");
  const limit = args.limit === void 0 ? maxLimit : parsePositiveInteger(args.limit, "limit");
  if (limit > maxLimit) throw new Error(`limit must be less than or equal to ${maxLimit}`);
  return { filePath: args.file_path, offset, limit };
}

// ═══════════════════════════════════════════════════════════════════════════
// write / edit format and diff (verbatim from dsh-tool-fs/lib/index.js)
// ═══════════════════════════════════════════════════════════════════════════
function parseWriteArgs(args) {
  if (args.file_path.trim().length === 0) throw new Error("file_path must be a non-empty string");
  return { filePath: args.file_path, content: args.content };
}
function formatWriteOutput(displayPath, outcome) {
  return `<path>${displayPath}</path>\n<type>file</type>\n<content>\n${outcome.operation === "create" ? "Created" : "Updated"} file\n</content>`;
}
function parseEditArgs(args) {
  if (args.file_path.trim().length === 0) throw new Error("file_path must be a non-empty string");
  if (args.old_string.length === 0) throw new Error("old_string must be a non-empty string");
  if (args.old_string === args.new_string) throw new Error("old_string and new_string must differ");
  return { filePath: args.file_path, oldString: args.old_string, newString: args.new_string, replaceAll: args.replace_all ?? false };
}
function formatEditOutput(displayPath, replaceAll) {
  return replaceAll
    ? `The file ${displayPath} has been updated. All occurrences were successfully replaced.`
    : `The file ${displayPath} has been updated successfully.`;
}
function computeHunkDiffs(path, before, after) {
  const patch = structuredPatch("", "", before, after, void 0, void 0, { context: 3 });
  const diffs = [];
  for (const hunk of patch.hunks) {
    const oldLines = []; const newLines = [];
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue;
      const text = line.slice(1);
      if (line.startsWith("-")) oldLines.push(text);
      else if (line.startsWith("+")) newLines.push(text);
      else { oldLines.push(text); newLines.push(text); }
    }
    diffs.push({ path, oldText: oldLines.length > 0 ? oldLines.join("\n") : null, newText: newLines.join("\n") });
  }
  return diffs;
}
function isFileDiff(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { path, oldText, newText } = value;
  return typeof path === "string" && (oldText === null || typeof oldText === "string") && typeof newText === "string";
}
function diffsFromMeta(meta) {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return void 0;
  const diffs = meta.diffs;
  if (!Array.isArray(diffs) || diffs.length === 0 || !diffs.every(isFileDiff)) return void 0;
  return diffs;
}

// ═══════════════════════════════════════════════════════════════════════════
// edit semantics (applyLiteralEdit aligned with dsh-fs-local fsio: LF-normalized matching, uniqueness/ambiguity)
// ═══════════════════════════════════════════════════════════════════════════
function normalizeLineEndings(content) { return content.replace(/\r\n/g, "\n"); }
function restoreLineEndings(content, lineEndings) {
  if (lineEndings === "CRLF") return content.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  return content;
}
function applyLiteralEdit(content, oldString, newString, replaceAll, displayPath) {
  const text = normalizeLineEndings(content);
  const search = normalizeLineEndings(oldString);
  const replacement = normalizeLineEndings(newString);
  const offsets = [];
  let offset = 0;
  while (true) {
    const match = text.indexOf(search, offset);
    if (match < 0) break;
    offsets.push(match);
    offset = match + search.length;
  }
  if (offsets.length === 0) throw new FsError(`cannot edit "${displayPath}": old_string not found`, "FS_EDIT_NOT_FOUND");
  if (offsets.length > 1 && !replaceAll) throw new FsError(`cannot edit "${displayPath}": old_string appears ${offsets.length} times (set replace_all to true to replace all)`, "FS_AMBIGUOUS_EDIT");
  let result = ""; let cursor = 0;
  const targets = replaceAll ? offsets : offsets.slice(0, 1);
  for (const m of targets) { result += text.slice(cursor, m) + replacement; cursor = m + search.length; }
  result += text.slice(cursor);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// read_image (verbatim from dsh-tool-fs/lib/index.js)
// ═══════════════════════════════════════════════════════════════════════════
const IMAGE_EXTENSIONS = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
};
function imageMediaTypeForPath(filePath) { return IMAGE_EXTENSIONS[extname(filePath).toLowerCase()]; }
function imageRefFromValue(image) {
  return {
    attachmentId: image.attachmentId, mediaType: image.mediaType, bytes: image.bytes,
    width: image.width, height: image.height,
    ...image.name === void 0 ? {} : { name: image.name },
  };
}
function formatImageReadOutput(displayPath, image) {
  return `<path>${displayPath}</path>\n<type>image</type>\n<content>\n${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes\n</content>`;
}
function imageReadContent(value) {
  return [
    { type: "text", text: formatImageReadOutput(value.path, value.image) },
    { type: "image", attachment: imageRefFromValue(value.image) },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// Routing / remote execution helpers
// ═══════════════════════════════════════════════════════════════════════════
function getHostConfig(ctx, hostId) {
  let hosts = {};
  try {
    const settings = ctx.get('settings');
    if (settings && typeof settings.get === 'function') {
      hosts = readHostsDoc((ns) => settings.get(ns)).hosts;
    }
  } catch { hosts = {}; }
  const host = hosts[hostId];
  if (!host || typeof host !== 'object') {
    throw new Error(`remote host "${hostId}" is not configured in dsh-ssh-hosts — add it in Settings → SSH hosts, or the workspace placeholder refers to a removed host`);
  }
  return { ...host, id: hostId };
}

async function acquireRemote(ctx, hostId) {
  const pool = ctx.get('sshPool');
  if (!pool || typeof pool.acquire !== 'function') {
    throw new Error('sshPool service unavailable — is the @dsh-ssh/dsh-ssh host plugin (bundle) loaded? (tools need the bundle patch row "@dsh-ssh/dsh-ssh")');
  }
  const cfg = getHostConfig(ctx, hostId);
  const conn = await pool.acquire(cfg);
  return { pool, conn, cfg };
}

// Remote bash background jobs: integrate with the official jobs contract (ctx.get('jobs').start) and
// return {kind:'background', jobId}. run() builds the job hooks with createRemoteBashJobHooks;
// readOutput/done/cancel reuse the acquired conn. Note: the connection is a host-level reused instance
// (pool.release only wakes a waiter, it does not close the connection), so exec/sftp stays safe for the
// job's lifetime.
async function startRemoteBackground(ctx, exec, args, route) {
  const jobs = ctx.get('jobs');
  if (jobs === void 0 || typeof jobs.start !== 'function') {
    throw new Error('[@dsh-ssh/dsh-ssh] background jobs unavailable: the jobs service (dsh-jobs) is not mounted in this composition; load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs');
  }
  abortIfSignalled(exec);
  const { pool, conn } = await acquireRemote(ctx, route.hostId);
  try {
    const jobId = jobs.start({
      kind: 'bash',
      label: args.command, // matches official tool-bash: label is the command itself
      ...exec.agent ? { owner: exec.agent } : {},
      run: () => createRemoteBashJobHooks({
        conn,
        cmd: args.command,
        cwd: route.remoteCwd,
        hostId: route.hostId,
        jobDir: defaultRemoteJobDir(route.hostId),
      }),
    });
    return { kind: 'background', jobId };
  } finally {
    pool.release();
  }
}

function toolErrorText(err, hostId, extra) {
  const stage = err && err.stage ? ' (' + err.stage + ')' : '';
  const msg = err && err.message ? err.message : String(err);
  return '[@dsh-ssh/dsh-ssh] host ' + hostId + stage + ': ' + msg + (extra ? ' [' + extra + ']' : '');
}

function abortIfSignalled(exec) {
  if (exec && exec.signal && exec.signal.aborted) {
    const e = new Error('tool call aborted');
    e.name = 'AbortError';
    throw e;
  }
}

// ── Remote sandbox permissions (fence at the tool layer; mirrors official resolvePolicy/approveEscalation) ──
// Session effective mode = ctx.sandboxPolicy.resolve({session}).mode (session-level override beats the
// deployment default); falls back to the fs/shell sandboxMode capability facts; when none exist (no sandbox
// backend), treat as danger-full-access.
function resolveRemoteSandboxMode(ctx, exec) {
  const policy = ctx.get('sandboxPolicy');
  if (policy && typeof policy.resolve === 'function') {
    const resolved = policy.resolve(exec && exec.agent ? { session: exec.agent.session } : {});
    if (resolved && typeof resolved.mode === 'string') return resolved.mode;
  }
  const fsMode = ctx.get('fs')?.sandboxMode;
  if (fsMode !== undefined) return fsMode;
  const shellMode = ctx.get('shell')?.sandboxMode;
  if (shellMode !== undefined) return shellMode;
  return 'danger-full-access';
}

// Resolve the mutation "effective interception mode" (read-only | workspace-write | danger-full-access).
// The effective mode always comes from resolveRemoteSandboxMode and is independent of escalationModes —
// even when the remote-routing context (remoteRouting) disables escalation, the three-mode denial semantics
// in policy.js are preserved as-is.
// escalationModes only control the "escalation lever": approval (approveEscalation) runs only when >0 and
// the model explicitly passed sandbox_permissions; at 0, remote escalation is meaningless (approval can only
// relax the local executor, not the remote path) — bail with the official-shaped "unavailable" message
// (mirroring dsh-tool-fs resolvePolicy / dsh-tool-bash approveBashEscalation: "sandbox_permissions is not
// available in this composition"). The official path also errors under danger-full-access (approveEscalation's
// "not strictly wider"), so only the schema exposure is adjusted here, not the behavior.
async function resolveRemoteEffectiveMode(ctx, exec, args, toolName, escalationModes, subject) {
  validateEscalationArgs(args.sandbox_permissions, args.justification);
  const standingMode = resolveRemoteSandboxMode(ctx, exec);
  if (args.sandbox_permissions === void 0 || args.justification === void 0) return standingMode;
  if (escalationModes.length === 0) {
    const capability = subject === 'command' ? 'executor' : 'filesystem';
    throw new Error(`sandbox_permissions is not available in this composition (no sandboxing ${capability} to escalate)`);
  }
  return approveEscalation(
    {
      requestedMode: args.sandbox_permissions,
      effectiveMode: standingMode,
      justification: args.justification,
      subject,
    },
    {
      approver: ctx.get('approval'),
      agent: exec.agent,
      callId: exec.callId,
      toolName,
      signal: exec.signal,
    },
  );
}

// write/edit fence: when mode is non-null, judge with mutationDenialMode and throw the official-shaped
// denial error on reject.
function assertRemoteWritable(mode, resolvedRemotePath, remoteCwd) {
  if (mode === null) return;
  const denied = mutationDenialMode(mode, resolvedRemotePath, remoteCwd);
  if (denied !== null) throw sandboxDenialError(denied, 'operation');
}

// Remote search errors → official SearchError taxonomy (timeout → SEARCH_ABORTED / output overflow →
// SEARCH_RAW_OUTPUT_OVERFLOW); connection errors keep the hostId/stage/remote-command message.
function searchErrorFor(err, hostId, toolName, cmd) {
  if (err instanceof SearchError) return err;
  if (err instanceof SshError || (err && err.name === 'SshError')) {
    if (err.stage === 'exec-timeout') return new SearchError(toolName + ' search timed out on remote (host ' + hostId + '): ' + err.message, 'SEARCH_ABORTED');
    if (err.stage === 'exec-output-overflow') return new SearchError(toolName + ' search produced too much output (host ' + hostId + '); narrow pattern, path, or include', 'SEARCH_RAW_OUTPUT_OVERFLOW');
    return new Error(toolErrorText(err, hostId, 'command: ' + cmd));
  }
  return new Error(toolErrorText(err, hostId, 'command: ' + cmd));
}

// Read remote UTF-8 text (with a size cap + binary rejection); returns { text }.
async function readRemoteText(fs, remotePath, maxBytes) {
  const st = await fs.stat(remotePath);
  if (st === undefined) throw new FsError(`cannot read "${remotePath}": not found`, 'FS_NOT_FOUND');
  if (st.type !== 'file') throw new FsError(`cannot read "${remotePath}": not a regular file`, 'FS_NOT_REGULAR_FILE');
  if (st.size !== undefined && st.size > maxBytes) throw new FsError(`cannot read "${remotePath}": file too large (${st.size} bytes > ${maxBytes} limit)`, 'FS_TOO_LARGE');
  const bytes = await fs.readBytes(remotePath);
  if (bytes.length > maxBytes) throw new FsError(`cannot read "${remotePath}": file too large (> ${maxBytes} bytes)`, 'FS_TOO_LARGE');
  if (bytes.includes(0)) throw new FsError(`cannot read "${remotePath}": not a UTF-8 text file (contains NUL bytes)`, 'FS_NOT_TEXT');
  return { text: bytes.toString('utf8') };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool definition construction + registration (the reusable form for preset-independent routing).
// buildRoutedToolDefinitions(ctx, config): pure construction of the seven tool defs (no registration).
// registerRoutedTools(agentCtx, names, config): registers each named def on agentCtx.tools.
//   - apply(ctx) (remoteRouting=false, local-delegation mode) registers all seven, for tests/verify scripts;
//   - the agent/created hook in index.js registers on the agent's own scope (shadowing preset official tools).
// ═══════════════════════════════════════════════════════════════════════════
export const ROUTED_TOOL_NAMES = ['bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep'];
// Marker for routed tools (a non-enumerable Symbol set on each def at registration; for debug/verify: a
// tool in the agent's view carrying this marker is a routed implementation).
export const ROUTED_TOOL_MARKER = Symbol('@dsh-ssh/dsh-ssh/routed-tool');

function buildRoutedToolDefinitions(ctx, config = {}) {
  const caps = {
    limit: config.readLimit ?? READ_LIMIT,
    maxLineLength: config.readMaxLineLength ?? READ_MAX_LINE_LENGTH,
    maxBytes: config.readMaxBytes ?? READ_MAX_BYTES,
    streamMinSize: config.readStreamMinSize ?? STREAM_MIN_SIZE,
  };
  const remoteMaxFileBytes = config.remoteMaxFileBytes ?? REMOTE_MAX_FILE_BYTES;
  const backgroundEnabled = config.enableRunInBackground ?? true;
  // remoteRouting=true marks a "pure remote routing" registration (agent/created hook, only serves
  // remote-cwd sessions/subagents): the remote has no local sandbox runner, so escalation (approval only
  // relaxes the local executor) is meaningless for remote paths → escalationModes is always empty and
  // sandbox_permissions/justification never enter the schema — matching official behavior, which writes
  // those two fields only when escalationModes.length > 0 (dsh-tool-fs/lib/index.js L617/L771,
  // dsh-tool-bash/lib/index.js L285).
  // Default false: remoteRouting=false is the local-delegation mode (now used only by apply() for
  // tests/verify), keeping local escalation semantics identical to official.
  const remoteRouting = config.remoteRouting === true;
  const bashEscalationModes = remoteRouting ? [] : (ctx.get('shell')?.sandboxMode === undefined ? [] : ESCALATION_TARGETS);
  const fsEscalationModes = remoteRouting ? [] : (ctx.get('fs')?.sandboxMode === undefined ? [] : ESCALATION_TARGETS);
  const searchCaps = {
    sampleOverCapGlobResults: config.sampleOverCapGlobResults ?? false,
    maxResults: config.globMaxResults ?? GLOB_MAX_RESULTS,
    maxMatches: config.grepMaxMatches ?? GREP_MAX_MATCHES,
    maxLineBytes: config.grepMaxLineBytes ?? GREP_MAX_LINE_BYTES,
    maxMetaBytes: config.searchMetaMaxBytes ?? SEARCH_META_MAX_BYTES,
    rawOutputMaxBytes: config.searchRawOutputMaxBytes ?? RAW_OUTPUT_MAX_BYTES,
    timeoutMs: config.searchTimeoutMs ?? SEARCH_TIMEOUT_MS,
  };

  // Local branch: delegate to the official same-named tool registered in the host composition
  // (byte-for-byte identical). If missing (e.g. tool-bash disabled on win32) → a clear error.
  function delegateLocal(toolName, args, exec) {
    const official = ctx.tools.get(toolName);
    if (official === undefined) {
      throw new Error(`tool "${toolName}" is unavailable locally: the official @deepseek-ai/dsh-tool-* implementation is not registered in this composition`);
    }
    return official.execute(args, exec);
  }

  // ── bash ──────────────────────────────────────────────────────────────
  return {
  bash: defineTool({
    name: 'bash',
    description: bashDescription(backgroundEnabled, bashEscalationModes),
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to execute.' },
      description: { type: 'string', required: true, description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status"; "npm install" → "Install package dependencies".' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.' },
      workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.' },
      ...backgroundEnabled ? { run_in_background: { type: 'boolean', description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.' } } : {},
      ...bashEscalationModes.length > 0 ? {
        sandbox_permissions: { type: 'string', enum: [...bashEscalationModes], description: 'The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.' },
        justification: { type: 'string', description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.' },
      } : {},
    },
    output: {
      schema: { oneOf: [
        { type: 'object', additionalProperties: false, properties: BACKGROUND_OUTPUT_PROPERTIES },
        { type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', required: true, const: 'foreground' },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean', required: true },
          aborted: { type: 'boolean', required: true },
          timeoutMs: { type: 'number', required: true },
          stdout: { type: 'object', additionalProperties: false, required: true, properties: { text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true }, spillPath: { type: 'string' } } },
          stderr: { type: 'object', additionalProperties: false, required: true, properties: { text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true }, spillPath: { type: 'string' } } },
          sandbox: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', required: true }, denied: { type: 'boolean', required: true }, enforcement: { type: 'string' }, runnerFailed: { type: 'boolean' } } },
        } },
      ] },
      render: (_args, value) => [{ type: 'text', text: value.kind === 'background' ? `started background job ${value.jobId}` : renderResult(value, bashEscalationModes) }],
    },
    async execute(args, exec) {
      validateBashArgs(args);
      const cwd = exec.agent?.session?.header?.cwd;
      const route = routeByCwd(cwd);
      if (route.kind === 'local') return delegateLocal('bash', args, exec);
      abortIfSignalled(exec);
      const mode = await resolveRemoteEffectiveMode(ctx, exec, args, 'bash', bashEscalationModes, 'command');
      const timeoutMs = args.timeoutMs ?? REMOTE_EXEC_DEFAULT_TIMEOUT;
      if (mode === 'read-only') {
        // The remote has no sandbox runner, so writes inside a command cannot be blocked per-file; letting
        // any command run under read-only would defeat that mode → fail closed and reject the whole command
        // with the official-shaped denial result (sandbox.denied); renderResult appends the marker + hint.
        return { kind: 'foreground', exitCode: null, signal: null, timedOut: false, aborted: false, timeoutMs, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, sandbox: { mode: 'read-only', denied: true } };
      }
      if (args.run_in_background === true) {
        if (!backgroundEnabled) throw new Error("run_in_background is disabled for this deployment (enableRunInBackground: false)");
        return startRemoteBackground(ctx, exec, args, route);
      }
      const { pool, conn } = await acquireRemote(ctx, route.hostId);
      try {
        const r = await conn.exec(args.command, { cwd: route.remoteCwd, timeoutMs });
        return {
          kind: 'foreground',
          exitCode: r.code === -1 ? null : r.code,
          signal: r.signal ?? null,
          timedOut: false, aborted: false, timeoutMs,
          stdout: { text: r.stdout, truncated: false },
          stderr: { text: r.stderr, truncated: false },
        };
      } catch (err) {
        if (err instanceof SshError && err.stage === 'exec-timeout') {
          // After a foreground timeout, best-effort cleanup of the residual remote process tree (silent on
          // failure); the connection is still reused, so the kill can be sent directly.
          await killForegroundTree(conn, args.command, route.remoteCwd);
          return { kind: 'foreground', exitCode: null, signal: null, timedOut: true, aborted: false, timeoutMs, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } };
        }
        throw new Error(toolErrorText(err, route.hostId, 'command: ' + args.command));
      } finally {
        pool.release();
      }
    },
    presentCall: presentBashCall,
    presentResult: presentBashResult,
  }),

  // ── read ──────────────────────────────────────────────────────────────
  read: defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to read, resolved by the filesystem backend.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${caps.limit}.` },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true },
        offset: { type: 'integer', required: true },
        lines: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { number: { type: 'integer', required: true }, text: { type: 'string', required: true } } } },
        totalLines: { type: 'integer', required: true },
      } },
      render: (args, value) => {
        const input = parseReadArgs(args, caps.limit);
        const endLine = value.lines.at(-1)?.number ?? Math.max(0, value.offset - 1);
        const truncatedByBytes = value.lines.length < input.limit && endLine < value.totalLines;
        return [{ type: 'text', text: formatReadOutput(value.path, { offset: value.offset, lines: value.lines, totalLines: value.totalLines, ...truncatedByBytes ? { truncatedByBytes: true } : {} }) }];
      },
      presentationMeta: (_args, value) => {
        const lang = langFromPath(value.path);
        return { path: value.path, offset: value.offset, lines: value.lines.map(({ number, text }) => ({ number, text })), totalLines: value.totalLines, ...lang === void 0 ? {} : { lang } };
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseReadArgs(args, caps.limit);
      const cwd = exec.agent?.session?.header?.cwd;
      const route = routeByCwd(cwd);
      if (route.kind === 'local') return delegateLocal('read', args, exec);
      abortIfSignalled(exec);
      const { pool, conn } = await acquireRemote(ctx, route.hostId);
      try {
        const fs = await conn.fs();
        const remotePath = resolveRemotePath(input.filePath, route.remoteCwd, cwd);
        const { text } = await readRemoteText(fs, remotePath, remoteMaxFileBytes);
        const window = await buildWindow([text], { offset: input.offset, limit: input.limit, maxLineLength: caps.maxLineLength, maxBytes: caps.maxBytes }, remotePath);
        return { path: remotePath, offset: input.offset, lines: window.lines, totalLines: window.totalLines };
      } catch (err) {
        if (err instanceof FsError) throw err;
        throw new Error(toolErrorText(err, route.hostId));
      } finally {
        pool.release();
      }
    },
    presentResult(_args, result) {
      if (result.isError) return void 0;
      const meta = readMetaFromMeta(result.meta);
      if (meta === void 0) return void 0;
      const only = result.content.length === 1 ? result.content[0] : void 0;
      const text = only?.type === 'text' ? only.text : void 0;
      if (text === void 0) return void 0;
      const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1];
      if (body === void 0) return void 0;
      return { card: 'read', path: meta.path, offset: meta.offset, lines: meta.lines, totalLines: meta.totalLines, ...meta.lang === void 0 ? {} : { lang: meta.lang }, content: [{ type: 'text', text: body }] };
    },
    presentCall(args) {
      const { offset, limit } = args;
      const window = limit !== void 0 && limit > 0 ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})` : offset !== void 0 ? ` (from line ${offset})` : '';
      return { card: 'generic', title: `Read ${args.file_path}${window}`, kind: 'read', locations: [{ path: args.file_path, line: offset ?? 1 }] };
    },
  }),

  // ── write ─────────────────────────────────────────────────────────────
  write: defineTool({
    name: 'write',
    description: 'Create or fully replace a UTF-8 text file.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to write, resolved by the filesystem backend.' },
      content: { type: 'string', required: true, description: 'Full UTF-8 text content to write.' },
      ...fsEscalationModes.length > 0 ? {
        sandbox_permissions: { type: 'string', enum: [...fsEscalationModes], description: 'The wider sandbox mode this file operation needs. Only valid as a one-shot retry of an operation the sandbox just denied; requires justification and user approval.' },
        justification: { type: 'string', description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact file operation needs the wider access.' },
      } : {},
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true },
        operation: { type: 'string', required: true, enum: ['create', 'update'] },
        before: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
        after: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: formatWriteOutput(value.path, value) }],
      presentationMeta: (args, value) => ({ diffs: value.before === null ? [] : computeHunkDiffs(args.file_path, value.before, value.after).map(({ path, oldText, newText }) => ({ path, oldText, newText })) }),
    },
    async execute(args, exec) {
      const input = parseWriteArgs(args);
      const cwd = exec.agent?.session?.header?.cwd;
      const route = routeByCwd(cwd);
      if (route.kind === 'local') return delegateLocal('write', args, exec);
      abortIfSignalled(exec);
      const mode = await resolveRemoteEffectiveMode(ctx, exec, args, 'write', fsEscalationModes, 'operation');
      const remotePath = resolveRemotePath(input.filePath, route.remoteCwd, cwd);
      assertRemoteWritable(mode, remotePath, route.remoteCwd);
      const { pool, conn } = await acquireRemote(ctx, route.hostId);
      try {
        const fs = await conn.fs();
        const st = await fs.stat(remotePath);
        if (st !== undefined && st.type !== 'file') throw new FsError(`cannot write "${remotePath}": not a regular file`, 'FS_NOT_REGULAR_FILE');
        const existed = st !== undefined;
        // Context-diff basis: return before only for readable text; binary / oversized / missing → null
        // (same as official writeText).
        let before = null;
        if (existed && (st.size === undefined || st.size <= remoteMaxFileBytes)) {
          const bytes = await fs.readBytes(remotePath);
          if (!bytes.includes(0)) before = normalizeLineEndings(bytes.toString('utf8'));
        }
        await fs.writeFileAtomic(remotePath, Buffer.from(input.content, 'utf8'));
        return { path: remotePath, operation: existed ? 'update' : 'create', before, after: normalizeLineEndings(input.content) };
      } catch (err) {
        if (err instanceof FsError) throw err;
        throw new Error(toolErrorText(err, route.hostId));
      } finally {
        pool.release();
      }
    },
    presentCall(args) {
      return { card: 'diff', title: `Write ${args.file_path}`, diffs: [{ path: args.file_path, oldText: null, newText: args.content }], locations: [{ path: args.file_path }] };
    },
    presentResult(args, result) {
      if (result.isError) return void 0;
      const diffs = diffsFromMeta(result.meta) ?? [{ path: args.file_path, oldText: null, newText: args.content }];
      return { card: 'diff', title: `Write ${args.file_path}`, diffs };
    },
  }),

  // ── edit ──────────────────────────────────────────────────────────────
  edit: defineTool({
    name: 'edit',
    description: 'Edit an existing UTF-8 text file by replacing literal text.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit, resolved by the filesystem backend.' },
      old_string: { type: 'string', required: true, description: 'Literal text to replace. Must match exactly.' },
      new_string: { type: 'string', required: true, description: 'Literal replacement text. Use an empty string to delete the match.' },
      replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
      ...fsEscalationModes.length > 0 ? {
        sandbox_permissions: { type: 'string', enum: [...fsEscalationModes], description: 'The wider sandbox mode this file operation needs. Only valid as a one-shot retry of an operation the sandbox just denied; requires justification and user approval.' },
        justification: { type: 'string', description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact file operation needs the wider access.' },
      } : {},
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true },
        before: { type: 'string', required: true },
        after: { type: 'string', required: true },
      } },
      render: (args, value) => [{ type: 'text', text: formatEditOutput(value.path, args.replace_all ?? false) }],
      presentationMeta: (args, value) => ({ diffs: computeHunkDiffs(args.file_path, value.before, value.after).map(({ path, oldText, newText }) => ({ path, oldText, newText })) }),
    },
    async execute(args, exec) {
      const input = parseEditArgs(args);
      const cwd = exec.agent?.session?.header?.cwd;
      const route = routeByCwd(cwd);
      if (route.kind === 'local') return delegateLocal('edit', args, exec);
      abortIfSignalled(exec);
      const mode = await resolveRemoteEffectiveMode(ctx, exec, args, 'edit', fsEscalationModes, 'operation');
      const remotePath = resolveRemotePath(input.filePath, route.remoteCwd, cwd);
      assertRemoteWritable(mode, remotePath, route.remoteCwd);
      const { pool, conn } = await acquireRemote(ctx, route.hostId);
      try {
        const fs = await conn.fs();
        const { text } = await readRemoteText(fs, remotePath, remoteMaxFileBytes);
        const lineEndings = text.includes('\r\n') ? 'CRLF' : 'LF';
        const after = restoreLineEndings(applyLiteralEdit(text, input.oldString, input.newString, input.replaceAll, remotePath), lineEndings);
        await fs.writeFileAtomic(remotePath, Buffer.from(after, 'utf8'));
        return { path: remotePath, before: normalizeLineEndings(text), after: normalizeLineEndings(after) };
      } catch (err) {
        if (err instanceof FsError) throw err;
        throw new Error(toolErrorText(err, route.hostId));
      } finally {
        pool.release();
      }
    },
    presentCall(args) {
      return { card: 'diff', title: `Edit ${args.file_path}`, diffs: [{ path: args.file_path, oldText: args.old_string || null, newText: args.new_string }], locations: [{ path: args.file_path }] };
    },
    presentResult(args, result) {
      if (result.isError) return void 0;
      const diffs = diffsFromMeta(result.meta);
      if (diffs === void 0) return void 0;
      return { card: 'diff', title: `Edit ${args.file_path}`, diffs };
    },
  }),

  // ── read_image ────────────────────────────────────────────────────────
  read_image: defineTool({
    name: 'read_image',
    description: 'Read a PNG/JPEG/WebP/GIF file and return the image itself. Requires the current model to accept image input.',
    parameters: { file_path: { type: 'string', required: true, description: 'Path to the image file, resolved by the filesystem backend.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true },
        image: { type: 'object', additionalProperties: false, required: true, properties: {
          attachmentId: { type: 'string', required: true },
          mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
          bytes: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          name: { type: 'string' },
        } },
      } },
      render: (_args, value) => imageReadContent(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string');
      const mediaType = imageMediaTypeForPath(args.file_path);
      if (mediaType === void 0) throw new Error(`cannot read "${args.file_path}": read_image only accepts PNG/JPEG/WebP/GIF paths`);
      const cwd = exec.agent?.session?.header?.cwd;
      const route = routeByCwd(cwd);
      if (route.kind === 'local') return delegateLocal('read_image', args, exec);
      abortIfSignalled(exec);
      const attachments = ctx.get('attachments');
      if (attachments === void 0) throw new Error(`cannot read "${args.file_path}" as an image: no attachment service is mounted`);
      if (!attachments.imageLimits.mediaTypes.includes(mediaType)) throw new Error(`cannot read "${args.file_path}": ${mediaType} images are not accepted by this deployment`);
      const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes);
      const { pool, conn } = await acquireRemote(ctx, route.hostId);
      try {
        const fs = await conn.fs();
        const remotePath = resolveRemotePath(args.file_path, route.remoteCwd, cwd);
        const st = await fs.stat(remotePath);
        if (st === undefined) throw new FsError(`cannot read "${remotePath}": not found`, 'FS_NOT_FOUND');
        if (st.type !== 'file') throw new FsError(`cannot read "${remotePath}": not a regular file`, 'FS_NOT_REGULAR_FILE');
        if (st.size !== undefined && st.size > byteCap) throw new FsError(`cannot read "${remotePath}": image too large (${st.size} bytes > ${byteCap} limit)`, 'FS_TOO_LARGE');
        const data = await fs.readBytes(remotePath);
        if (data.length > byteCap) throw new FsError(`cannot read "${remotePath}": image too large (> ${byteCap} bytes)`, 'FS_TOO_LARGE');
        const ref = await attachments.saveImage({ data, mediaType, name: basename(remotePath) });
        return { path: remotePath, image: { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, ...ref.name === void 0 ? {} : { name: ref.name } } };
      } catch (err) {
        if (err instanceof FsError) throw err;
        throw new Error(toolErrorText(err, route.hostId));
      } finally {
        pool.release();
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Read image ${args.file_path}`, kind: 'read', locations: [{ path: args.file_path }] };
    },
  }),

  // ── glob ──────────────────────────────────────────────────────────────
  glob: defineTool({
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
  }),

  // ── grep ──────────────────────────────────────────────────────────────
  grep: defineTool({
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
  }),

  };
}

/**
 * Register the named routed tools on agentCtx.tools. names must be a subset of ROUTED_TOOL_NAMES; an unknown
 * name throws (the caller converges the list). Returns the registered names.
 */
export function registerRoutedTools(agentCtx, names, config = {}) {
  const defs = buildRoutedToolDefinitions(agentCtx, config);
  const registered = [];
  for (const name of names) {
    const def = defs[name];
    if (def === undefined) {
      throw new Error('[@dsh-ssh/dsh-ssh] unknown routed tool name "' + name + '" (expected one of: ' + ROUTED_TOOL_NAMES.join('/') + ')');
    }
    Object.defineProperty(def, ROUTED_TOOL_MARKER, { value: true }); // mark routed tool (non-enumerable)
    agentCtx.tools.register(def);
    registered.push(name);
  }
  return { names: registered };
}

// apply(ctx): registers all seven same-named routed tools on ctx (remoteRouting=false, local-delegation
// mode). Production routing goes through the agent/created hook in index.js via registerRoutedTools with
// remoteRouting=true; this apply() is only a registration helper for tests and verify scripts.
export function apply(ctx, config = {}) {
  registerRoutedTools(ctx, ROUTED_TOOL_NAMES, config);
  ctx.logger?.info('[@dsh-ssh/dsh-ssh] tools registered: bash/read/write/edit/read_image/glob/grep');
}
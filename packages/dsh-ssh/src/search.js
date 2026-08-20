// @dsh-ssh/dsh-ssh — remote glob/grep reimplementation, pure-function layer.
// Plain ESM; depends only on node:path + ./ssh-core.js's shellQuoteSingle.
// Translates rg semantics to remote commands and back: glob→RegExp / glob→find -name,
// Rust regex→ERE, remote command construction, output parsing, and official-shaped
// retain/render/present projections. All pure, so unit-testable.
//
// rg semantics ↔ remote command mapping:
//   glob (rg --files --glob=P --no-ignore --hidden, VCS dirs excluded) → remote find:
//     - files only, no directories       → find -type f
//     - hidden files included (rg --hidden) → find lists hidden by default (no exclusion)
//     - VCS dirs skipped (.git/.svn/.hg/.bzr/.jj/.sl) → find \( -type d \( VCS names \) -prune \)
//     - '/'-less pattern matches basename at any depth → find -name <basename glob>
//       (a conservative superset; the local exact filter re-checks)
//     - mtime ascending (rg --sort=modified) → GNU find -printf '%T@\t%p\n' | sort -n;
//       BSD/macOS find lacks -printf → probe-fail fallback to -print (find walk order,
//       documented difference)
//     - glob matches relative to the session cwd (not the search root) → local
//       rgGlobToRegExp does the exact filter
//   grep (rg --json --regexp=P; default skip hidden/binary, read .gitignore) → remote grep -rInHE:
//     - skip hidden dirs                 → --exclude-dir='.*' (--exclude/--include combined
//                                          break each other on GNU/BSD, see below)
//     - skip binary files                → -I
//     - line numbers + path              → -n -H; parse path:line:content locally
//     - .gitignore rules                 → unsupported (remote grep has no ignore-file concept;
//                                          rg reads them by default)
//     - include glob (basename only)     → --include=<glob> (braces expanded into several --include)
//     - regex dialect: Rust regex ↔ POSIX ERE → translateRustRegexToEre (\d→[0-9] etc.,
//       a lossless bridge); the rest goes to grep -E, and errors (exit 2) →
//       SEARCH_INVALID_PATTERN. ERE lacks lookaround/backrefs.
//   Differences that cannot be fully aligned (all explicitly documented, never a silent
//   wrong result): .gitignore not read, no mtime ordering on BSD find, best-effort grep
//   output parsing when paths contain ':', '/' in include rejected, filenames containing
//   newlines/NUL unsupported, symlinks not followed (rg also doesn't follow dir links; a
//   symlink to a file is searched by rg but skipped by find -type f / grep -r).
import { posix } from 'node:path';
import { shellQuoteSingle } from './ssh-core.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants (mirroring official dsh-tool-fs-search defaults)
// ═══════════════════════════════════════════════════════════════════════════
export const GLOB_MAX_RESULTS = 100;          // 官方 globMaxResults
export const GREP_MAX_MATCHES = 250;          // 官方 grepMaxMatches
export const GREP_MAX_LINE_BYTES = 2000;      // 官方 grepMaxLineBytes
export const SEARCH_META_MAX_BYTES = 65536;   // 官方 searchMetaMaxBytes
export const RAW_OUTPUT_MAX_BYTES = 2e7;      // 官方 rawOutputMaxBytes(20MB)
export const SEARCH_TIMEOUT_MS = 3e4;         // 官方 timeoutMs(30s)
export const GLOB_VCS_EXCLUDES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];

// Official SearchError taxonomy (the registry exposes {name, code} on isError results).
export class SearchError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// rg glob → JS RegExp (local exact filter; globset semantics: '/'-less matches
// basename, ** crosses segments, {a,b} alternation, char classes, case-sensitive;
// matched against the session-cwd-relative display path, matching rg's behavior)
// ═══════════════════════════════════════════════════════════════════════════
function escapeRegexChar(c) {
  return /[\^$.*+?()[]{}|]/.test(c) ? '\\' + c : c;
}

// Char class: leading '!' or '^' → '^'; backslash escaped; else verbatim (most chars are literal inside a class).
function translateClass(str, i) {
  const start = i;
  i += 1; // skip '['
  let content = '';
  let closed = false;
  for (; i < str.length; i++) {
    const c = str[i];
    if (c === ']') { closed = true; break; }
    if (c === '\\') { content += '\\\\'; continue; }
    content += c;
  }
  if (!closed) return { src: escapeRegexChar('['), next: start + 1 }; // unclosed → literal '['
  if (content.startsWith('!')) content = '^' + content.slice(1);
  else if (content.startsWith('^')) content = '^' + content.slice(1);
  return { src: '[' + content + ']', next: i + 1 };
}

// Brace alternation (supports nesting, \{ escaping); returns { src, next }. altFn translates each alternative.
function translateBraces(str, i, altFn) {
  const close = findMatchingBrace(str, i);
  if (close === -1) return { src: escapeRegexChar('{'), next: i + 1 };
  const alts = splitTopLevel(str.slice(i + 1, close), ',');
  const parts = alts.map((a) => altFn(a));
  return { src: '(?:' + parts.join('|') + ')', next: close + 1 };
}

function findMatchingBrace(str, open) {
  let depth = 0;
  for (let j = open; j < str.length; j++) {
    const c = str[j];
    if (c === '\\') { j += 1; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return j; }
  }
  return -1;
}

function splitTopLevel(str, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (let j = 0; j < str.length; j++) {
    const c = str[j];
    if (c === '\\') { cur += c + (str[j + 1] ?? ''); j += 1; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') depth = Math.max(0, depth - 1);
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// Single-segment translation (basename or path segment; in a '/'-less context ** ≡ *).
function translateSegment(str) {
  let out = '';
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (c === '*') { out += '[^/]*'; i += str[i + 1] === '*' ? 2 : 1; }
    else if (c === '?') { out += '[^/]'; i += 1; }
    else if (c === '[') { const r = translateClass(str, i); out += r.src; i = r.next; }
    else if (c === '{') { const r = translateBraces(str, i, translateSegment); out += r.src; i = r.next; }
    else if (c === '\\') { out += escapeRegexChar(str[i + 1] ?? '\\'); i += 2; }
    else { out += escapeRegexChar(c); i += 1; }
  }
  return out;
}

// Full-path translation: ** as a complete path component (between segments) →
// (?:[^/]+/)* / trailing .*; otherwise treat as single-segment *.
function translatePath(str) {
  let out = '';
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (c === '*') {
      if (str[i + 1] === '*') {
        const fullComponent = (i === 0 || str[i - 1] === '/') && (str[i + 2] === '/' || i + 2 === str.length);
        if (fullComponent && str[i + 2] === '/') { out += '(?:[^/]+/)*'; i += 3; }
        else if (fullComponent) { out += '.*'; i += 2; }
        else { out += '[^/]*'; i += 2; }
      } else { out += '[^/]*'; i += 1; }
    }
    else if (c === '?') { out += '[^/]'; i += 1; }
    else if (c === '[') { const r = translateClass(str, i); out += r.src; i = r.next; }
    else if (c === '{') { const r = translateBraces(str, i, translatePath); out += r.src; i = r.next; }
    else if (c === '\\') { out += escapeRegexChar(str[i + 1] ?? '\\'); i += 2; }
    else if (c === '/') { out += '/'; i += 1; }
    else { out += escapeRegexChar(c); i += 1; }
  }
  return out;
}

export function rgGlobToRegExpSource(pattern) {
  return pattern.includes('/') ? '^' + translatePath(pattern) + '$' : '^(?:.*/)?' + translateSegment(pattern) + '$';
}
export function rgGlobToRegExp(pattern) {
  return new RegExp(rgGlobToRegExpSource(pattern));
}

// ═══════════════════════════════════════════════════════════════════════════
// glob: find command construction (conservative superset filter + mtime; the local re-filter does the exact match)
// ═══════════════════════════════════════════════════════════════════════════
// The basename segment of the pattern (after the last '/') with braces expanded →
// find -name candidates; too complex (>16 items) returns null (will enumerate all).
// find -name is a conservative superset: any file matching the full pattern has a
// basename matching this segment (a '/'-less pattern is exactly the segment).
export function globBasenameForFind(pattern) {
  let base = pattern.includes('/') ? pattern.slice(pattern.lastIndexOf('/') + 1) : pattern;
  if (base === '' || base === '**') base = '*';
  return expandBraceGlobs(base.replace(/\*\*/g, '*'));
}

export function expandBraceGlobs(str, cap = 16) {
  const open = findUnescapedChar(str, '{');
  if (open === -1) return [str];
  const close = findMatchingBrace(str, open);
  if (close === -1) return [str]; // unclosed → literal
  const alts = splitTopLevel(str.slice(open + 1, close), ',');
  if (alts.length > cap) return null;
  const suffixExp = expandBraceGlobs(str.slice(close + 1), cap);
  if (suffixExp === null) return null;
  const out = [];
  for (const a of alts) for (const s of suffixExp) out.push(str.slice(0, open) + a + s);
  return out;
}

function findUnescapedChar(str, ch) {
  for (let i = 0; i < str.length; i++) {
    if (str[i] === ch && (i === 0 || str[i - 1] !== '\\')) return i;
  }
  return -1;
}

function findNameExpr(nameGlobs) {
  if (nameGlobs === null || nameGlobs.length === 0) return '';
  if (nameGlobs.length === 1) return '-name ' + shellQuoteSingle(nameGlobs[0]);
  return '\\( ' + nameGlobs.map((g) => '-name ' + shellQuoteSingle(g)).join(' -o ') + ' \\)';
}

function vcsPruneExpr() {
  const names = GLOB_VCS_EXCLUDES.map((n) => '-name ' + n).join(' -o ');
  return '\\( -type d \\( ' + names + ' \\) -prune \\)';
}

// Returns a single remote shell command (given a cd prefix via buildRemoteCommand).
// GNU find (with -printf) emits 'mtime<TAB>path' sorted by mtime ascending; BSD/macOS
// probe-fail fallback uses -print (find walk order).
export function buildRemoteGlobCommand(root, pattern) {
  const nameExpr = findNameExpr(globBasenameForFind(pattern));
  const filePart = '-type f' + (nameExpr ? ' ' + nameExpr : '');
  const base = 'find ' + shellQuoteSingle(root) + ' ' + vcsPruneExpr() + ' -o ' + filePart;
  const printfBranch = base + " -printf '%T@\\t%p\\n' | LC_ALL=C sort -n";
  const plainBranch = base + ' -print';
  const probe = 'find ' + shellQuoteSingle(root) + " -prune -printf '' >/dev/null 2>&1";
  return 'if ' + probe + '; then ' + printfBranch + '; else ' + plainBranch + '; fi';
}

export function parseGlobOutput(text) {
  const entries = [];
  for (const line of String(text).split('\n')) {
    if (line.length === 0) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) { entries.push({ mtime: null, path: line }); continue; }
    const mtime = Number(line.slice(0, tab));
    entries.push({ mtime: Number.isFinite(mtime) ? mtime : null, path: line.slice(tab + 1) });
  }
  return entries;
}

// ═══════════════════════════════════════════════════════════════════════════
// grep: command construction + regex dialect bridge
// ═══════════════════════════════════════════════════════════════════════════
// Rust regex → POSIX ERE lossless bridge (only equivalent-class substitutions); the
// rest goes to grep -E, and unsupported constructs error via grep's exit 2.
export function translateRustRegexToEre(pattern) {
  return String(pattern)
    .replace(/\\d/g, '[0-9]')
    .replace(/\\D/g, '[^0-9]')
    .replace(/\\w/g, '[A-Za-z0-9_]')
    .replace(/\\W/g, '[^A-Za-z0-9_]')
    .replace(/\\s/g, '[[:space:]]')
    .replace(/\\S/g, '[^[:space:]]');
}

// include glob → --include args (basename semantics only; braces expanded; **→*; '/' rejected).
export function translateIncludeForGrep(include) {
  if (include.includes('/')) {
    throw new SearchError("grep include globs containing '/' are not supported on remote workspaces (remote grep --include matches basenames only); use the path argument or a basename glob like '*.ts'", 'SEARCH_FAILED');
  }
  const globs = expandBraceGlobs(include.replace(/\*\*/g, '*'));
  if (globs === null) throw new SearchError('grep include has too many brace alternates; simplify the glob', 'SEARCH_FAILED');
  return globs.map((g) => '--include=' + shellQuoteSingle(g)).join(' ');
}

// root is a remote absolute path (remoteCwd or a resolved path argument).
export function buildRemoteGrepCommand(root, pattern, include) {
  if (pattern.includes('\n')) throw new SearchError('grep patterns containing newlines are not supported on remote workspaces', 'SEARCH_INVALID_PATTERN');
  if (pattern.includes('\u0000')) throw new SearchError('grep patterns containing NUL bytes are not supported on remote workspaces', 'SEARCH_INVALID_PATTERN');
  // --exclude/--include combined break each other on both GNU and BSD grep:
  //   GNU 3.7: --exclude='.*' neither excludes hidden files nor keeps --include
  //            working (b.log gets wrongly searched);
  //   BSD: using --exclude together with --include fails the same way.
  // Decision: keep only --exclude-dir='.*' (both reliably skip hidden directories);
  // hidden FILES will be matched — rg skips hidden files by default, a documented difference.
  let extra = " --exclude-dir='.*'";
  if (include !== undefined) extra += ' ' + translateIncludeForGrep(include);
  return 'grep -rInHE' + extra + ' -e ' + shellQuoteSingle(translateRustRegexToEre(pattern)) + ' ' + shellQuoteSingle(root);
}

// Output line 'path:line:content' (grep -H -n). Paths containing ':' are split on the
// first ':digit:' (best-effort, documented).
export function parseGrepOutput(text) {
  const matches = [];
  for (const line of String(text).split('\n')) {
    if (line.length === 0) continue;
    const m = /^(.+?):(\d+):([\s\S]*)$/.exec(line);
    if (!m) continue;
    matches.push({ path: m[1], lineNumber: Number(m[2]), line: m[3] });
  }
  return matches;
}

// ═══════════════════════════════════════════════════════════════════════════
// Display path (mirrors official toWorkdirRelative; remote absolute path → session-cwd-relative)
// ═══════════════════════════════════════════════════════════════════════════
export function toWorkdirRelative(p, workdir) {
  if (!posix.isAbsolute(p)) return p;
  const rel = posix.relative(workdir, p);
  if (rel.length === 0) return '.';
  if (rel === '..' || rel.startsWith('../')) return p;
  return rel;
}

// ═══════════════════════════════════════════════════════════════════════════
// retain/render/present (mirrors the official shape: text and meta share the same retained, for consistency)
// ═══════════════════════════════════════════════════════════════════════════
export function previewLine(line, maxBytes) {
  const buf = Buffer.from(line, 'utf8');
  if (buf.length <= maxBytes) return line;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1; // keep UTF-8 boundary
  return buf.subarray(0, end).toString('utf8') + ' (line truncated)';
}

export function retainGrepMatches(matches, maxMatches, maxLineBytes) {
  const items = matches.slice(0, maxMatches).map((m) => ({ ...m, line: previewLine(m.line, maxLineBytes) }));
  return { items, kept: items.length, seen: matches.length, truncated: matches.length > maxMatches };
}

function matchNoun(count) { return count === 1 ? 'match' : 'matches'; }

export function groupMatchesByFile(matches) {
  const byFile = new Map();
  for (const match of matches) {
    const entry = { lineNumber: match.lineNumber, line: match.line };
    const group = byFile.get(match.path);
    if (group !== void 0) group.push(entry);
    else byFile.set(match.path, [entry]);
  }
  return Array.from(byFile, ([p, fileMatches]) => ({ path: p, matches: fileMatches }));
}

export function formatGrepMatches(matches) {
  const byFile = new Map();
  for (const match of matches) {
    const group = byFile.get(match.path);
    if (group !== void 0) group.push(match);
    else byFile.set(match.path, [match]);
  }
  const sections = [];
  for (const [p, group] of byFile) sections.push(p + '\n' + group.map((m) => 'Line ' + m.lineNumber + ': ' + m.line).join('\n'));
  return sections.join('\n\n');
}

// Remote calls never write spill (no spillStore handoff) → spillRef is always
// undefined; the footer states that nothing was saved.
export function formatGrepOutput(retained, spillRef) {
  const header = retained.truncated
    ? 'Found ' + retained.kept + ' of ' + retained.seen + ' matches'
    : 'Found ' + retained.seen + ' ' + matchNoun(retained.seen);
  const body = formatGrepMatches(retained.items);
  if (!retained.truncated) return header + '\n\n' + body;
  return header + '\n\n' + body + '\n\n(' + (spillRef !== void 0
    ? 'Full grep result stored at: ' + spillRef.locator + '. ' + spillRef.retrievalHint
    : 'The complete result could not be saved; narrow pattern, path, or include to see more.') + ')';
}

export function formatRetainedGrep(retained) {
  if (retained.seen === 0) return 'No matches found';
  return formatGrepOutput(retained, undefined);
}

export function formatGlobPage(items, seen, spillRef, basis) {
  const body = items.join('\n');
  const recovery = spillRef !== void 0
    ? 'Full sorted result stored at: ' + spillRef.locator + '. ' + spillRef.retrievalHint
    : 'The complete result could not be saved; narrow pattern or path to see more.';
  return body + '\n\n(Showing ' + items.length + ' of ' + seen + ' paths' + basis + ' ' + recovery + ')';
}

// sampleOverCapGlobResults=false (matches the upstream standard preset) → on overflow, take the mtime head.
export function renderGlobPaths(paths, maxResults) {
  if (paths.length === 0) return 'No files found';
  if (paths.length <= maxResults) return paths.join('\n');
  return formatGlobPage(paths.slice(0, maxResults), paths.length, undefined, '.');
}

export function globCardPage(paths, maxResults) {
  if (paths.length <= maxResults) return { items: paths, truncated: false };
  return { items: paths.slice(0, maxResults), truncated: true };
}

function metaBytes(meta) { return Buffer.byteLength(JSON.stringify(meta), 'utf8'); }

export function capMetaBytes(meta, maxMetaBytes) {
  if (metaBytes(meta) <= maxMetaBytes) return meta;
  if (meta.shape === 'matches') {
    const files = [...meta.files];
    while (files.length > 1 && metaBytes({ ...meta, files, truncated: true }) > maxMetaBytes) files.pop();
    return { ...meta, files, truncated: true };
  }
  const paths = [...meta.paths];
  while (paths.length > 1 && metaBytes({ ...meta, paths, truncated: true }) > maxMetaBytes) paths.pop();
  return { ...meta, paths, truncated: true };
}

export function grepSearchMeta(retained, maxMetaBytes) {
  return capMetaBytes({ shape: 'matches', files: groupMatchesByFile(retained.items), truncated: retained.truncated, total: retained.seen }, maxMetaBytes);
}

export function globSearchMeta(page, total, maxMetaBytes) {
  return capMetaBytes({ shape: 'paths', paths: page.items, truncated: page.truncated, total }, maxMetaBytes);
}

function isSearchLineMatch(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { lineNumber, line } = value;
  return typeof lineNumber === 'number' && typeof line === 'string';
}
function isSearchFileMatches(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { path, matches } = value;
  return typeof path === 'string' && Array.isArray(matches) && matches.every(isSearchLineMatch);
}
export function searchViewFromMeta(meta) {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return void 0;
  const record = meta;
  const { truncated, total } = record;
  if (typeof truncated !== 'boolean' || typeof total !== 'number') return void 0;
  if (record.shape === 'matches') {
    const { files } = record;
    if (!Array.isArray(files) || !files.every(isSearchFileMatches)) return void 0;
    return { card: 'search', shape: 'matches', files, truncated, total };
  }
  if (record.shape === 'paths') {
    const { paths } = record;
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) return void 0;
    return { card: 'search', shape: 'paths', paths, truncated, total };
  }
  return void 0;
}

export function presentGlobCall(args) {
  const where = args.path !== void 0 ? ' in ' + args.path : '';
  return { card: 'generic', title: 'Glob ' + args.pattern + where, kind: 'search', rawInput: args.pattern };
}
export function presentGlobResult(_args, result) {
  if (result.isError) return void 0;
  const view = searchViewFromMeta(result.meta);
  if (view === void 0 || view.shape !== 'paths') return void 0;
  return view;
}
export function presentGrepCall(args) {
  const where = args.path !== void 0 ? ' in ' + args.path : '';
  const filter = args.include !== void 0 ? ' (' + args.include + ')' : '';
  return { card: 'generic', title: 'Grep ' + args.pattern + where + filter, kind: 'search', rawInput: args.pattern };
}
export function presentGrepResult(_args, result) {
  if (result.isError) return void 0;
  const view = searchViewFromMeta(result.meta);
  if (view === void 0 || view.shape !== 'matches') return void 0;
  return view;
}

// ═══════════════════════════════════════════════════════════════════════════
// Argument validation (mirroring official parseGlobArgs / parseGrepArgs + validateInclude)
// ═══════════════════════════════════════════════════════════════════════════
export function parseGlobArgs(args) {
  if (args.pattern.trim().length === 0) throw new Error('pattern must be a non-empty string');
  if (args.path !== void 0 && args.path.trim().length === 0) throw new Error('path must be a non-empty string when given');
  return { pattern: args.pattern, ...args.path !== void 0 ? { path: args.path } : {} };
}

function validateInclude(include) {
  if (include.trim().length === 0) throw new Error('include must be a non-empty glob when given');
  if (include.startsWith('!')) throw new Error('include must be a positive glob filter; negated patterns ("!…") are not supported');
  let braceDepth = 0;
  for (const char of include) {
    if (char === '{') braceDepth += 1;
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (char === ',' && braceDepth === 0) throw new Error('include must be one glob, not a comma-separated list (use {a,b} alternation instead)');
  }
}

export function parseGrepArgs(args) {
  if (args.pattern.length === 0) throw new Error('pattern must be a non-empty string');
  if (args.path !== void 0 && args.path.trim().length === 0) throw new Error('path must be a non-empty string when given');
  if (args.include !== void 0) validateInclude(args.include);
  return {
    pattern: args.pattern,
    ...args.path !== void 0 ? { path: args.path } : {},
    ...args.include !== void 0 ? { include: args.include } : {},
  };
}

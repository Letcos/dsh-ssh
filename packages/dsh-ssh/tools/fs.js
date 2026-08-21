// @dsh-ssh/dsh-ssh — fs tools (read/write/edit/read_image) extracted from tools.js via mechanical slice
// Provides buildFsCaps + createReadTool/createWriteTool/createEditTool/createReadImageTool
// Plain JS/ESM, no build step.
import { defineTool } from '@deepseek-ai/dsh-tools';
import { FsError } from '@deepseek-ai/dsh-fs';
import { structuredPatch } from 'diff';
import { basename, extname } from 'node:path';
import { routeByCwd, resolveRemotePath } from '../src/router.js';
import { mutationDenialMode, sandboxDenialError } from '../src/policy.js';

export const READ_LIMIT = 2e3;
export const READ_MAX_LINE_LENGTH = 2e3;
export const READ_MAX_BYTES = 50 * 1024;
export const STREAM_MIN_SIZE = 10 * 1024 * 1024;
export const REMOTE_MAX_FILE_BYTES = 10 * 1024 * 1024;

// local error formatter (mirrors tools.js toolErrorText; duplicated to keep fs domain self-contained)
function toolErrorText(err, hostId, extra) {
  const stage = err && err.stage ? ' (' + err.stage + ')' : '';
  const msg = err && err.message ? err.message : String(err);
  return '[@dsh-ssh/dsh-ssh] host ' + hostId + stage + ': ' + msg + (extra ? ' [' + extra + ']' : '');
}

export function buildFsCaps(config = {}) {
  return {
    limit: config.readLimit ?? READ_LIMIT,
    maxLineLength: config.readMaxLineLength ?? READ_MAX_LINE_LENGTH,
    maxBytes: config.readMaxBytes ?? READ_MAX_BYTES,
    streamMinSize: config.readStreamMinSize ?? STREAM_MIN_SIZE,
    remoteMaxFileBytes: config.remoteMaxFileBytes ?? REMOTE_MAX_FILE_BYTES,
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
// fs-private remote helpers (moved from tools.js; only fs domain uses them)
// ═══════════════════════════════════════════════════════════════════════════
function assertRemoteWritable(mode, resolvedRemotePath, remoteCwd) {
  if (mode === null) return;
  const denied = mutationDenialMode(mode, resolvedRemotePath, remoteCwd);
  if (denied !== null) throw sandboxDenialError(denied, 'operation');
}
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

// ── read ──────────────────────────────────────────────────────────────
export function createReadTool({ ctx, fsCaps, delegateLocal, acquireRemote, abortIfSignalled }) {
  return defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to read, resolved by the filesystem backend.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${fsCaps.limit}.` },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true },
        offset: { type: 'integer', required: true },
        lines: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { number: { type: 'integer', required: true }, text: { type: 'string', required: true } } } },
        totalLines: { type: 'integer', required: true },
      } },
      render: (args, value) => {
        const input = parseReadArgs(args, fsCaps.limit);
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
      const input = parseReadArgs(args, fsCaps.limit);
      const cwd = exec.agent?.session?.header?.cwd;
      const route = routeByCwd(cwd);
      if (route.kind === 'local') return delegateLocal('read', args, exec);
      abortIfSignalled(exec);
      const { pool, conn } = await acquireRemote(ctx, route.hostId);
      try {
        const fs = await conn.fs();
        const remotePath = resolveRemotePath(input.filePath, route.remoteCwd, cwd);
        const { text } = await readRemoteText(fs, remotePath, fsCaps.remoteMaxFileBytes);
        const window = await buildWindow([text], { offset: input.offset, limit: input.limit, maxLineLength: fsCaps.maxLineLength, maxBytes: fsCaps.maxBytes }, remotePath);
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
  });
}

// ── write ─────────────────────────────────────────────────────────────
export function createWriteTool({ ctx, fsCaps, fsEscalationModes, delegateLocal, acquireRemote, abortIfSignalled, resolveRemoteEffectiveMode }) {
  return defineTool({
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
        let before = null;
        if (existed && (st.size === undefined || st.size <= fsCaps.remoteMaxFileBytes)) {
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
  });
}

// ── edit ──────────────────────────────────────────────────────────────
export function createEditTool({ ctx, fsCaps, fsEscalationModes, delegateLocal, acquireRemote, abortIfSignalled, resolveRemoteEffectiveMode }) {
  return defineTool({
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
        const { text } = await readRemoteText(fs, remotePath, fsCaps.remoteMaxFileBytes);
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
  });
}

// ── read_image ────────────────────────────────────────────────────────
export function createReadImageTool({ ctx, delegateLocal, acquireRemote, abortIfSignalled }) {
  return defineTool({
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
  });
}

// Re-export helpers for reporting / test inspection (keep these symbols visible)
export {
  truncateLine,
  lineByteSize,
  consumeLine,
  stripCarriageReturn,
  finish,
  buildWindow,
  formatReadOutput,
  LANG_BY_EXTENSION,
  langFromPath,
  isFileTextLine,
  readMetaFromMeta,
  parsePositiveInteger,
  parseReadArgs,
  parseWriteArgs,
  formatWriteOutput,
  parseEditArgs,
  formatEditOutput,
  computeHunkDiffs,
  isFileDiff,
  diffsFromMeta,
  normalizeLineEndings,
  restoreLineEndings,
  applyLiteralEdit,
  IMAGE_EXTENSIONS,
  imageMediaTypeForPath,
  imageRefFromValue,
  formatImageReadOutput,
  imageReadContent,
  assertRemoteWritable,
  readRemoteText,
};

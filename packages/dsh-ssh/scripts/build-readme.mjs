#!/usr/bin/env node
// Build npm package README from repository root README.md.
// Deterministic transforms + header injection; plain ESM, no new deps.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADER = '<!-- AUTO-GENERATED from /README.md by scripts/build-readme.mjs — do not edit manually -->';

function parseGitHubUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let url = raw.trim();
  if (url.startsWith('git+')) url = url.slice(4);
  if (url.endsWith('.git')) url = url.slice(0, -4);
  // git@github.com:owner/repo
  let m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\/)?$/);
  if (m) return { owner: m[1], repo: m[2] };
  m = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
  return null;
}

function getGitHubBase(repoRoot) {
  // 1) git remote
  try {
    const out = execSync('git remote get-url origin', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const parsed = parseGitHubUrl(out);
    if (parsed) return parsed;
  } catch {}
  // 2) root package.json repository
  for (const rel of ['package.json', 'packages/dsh-ssh/package.json']) {
    try {
      const p = path.join(repoRoot, rel);
      if (!existsSync(p)) continue;
      const pkg = JSON.parse(readFileSync(p, 'utf8'));
      const repoField = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
      if (repoField) {
        const parsed = parseGitHubUrl(repoField);
        if (parsed) return parsed;
      }
    } catch {}
  }
  // 3) default
  return { owner: 'dsh-ssh', repo: 'dsh-ssh' };
}

function build() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '../../..');
  const srcPath = path.join(repoRoot, 'README.md');
  const destPath = path.join(repoRoot, 'packages/dsh-ssh/README.md');

  if (!existsSync(srcPath)) {
    console.error(`[build-readme] source not found: ${srcPath}`);
    process.exit(1);
  }

  const raw = readFileSync(srcPath, 'utf8');
  const { owner, repo } = getGitHubBase(repoRoot);
  const githubBase = `https://github.com/${owner}/${repo}`;
  const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/main`;

  let content = raw;

  // Remove existing header if source ever contains it (idempotent)
  if (content.startsWith(HEADER)) {
    content = content.slice(HEADER.length).replace(/^\s*\n/, '');
  }

  // 1) docs/images/... -> raw.githubusercontent.com/.../main/docs/images/...
  // HTML src="docs/images/..." and markdown ](docs/images/...) / (docs/images/...)
  content = content.replaceAll('src="docs/images/', `src="${rawBase}/docs/images/`);
  content = content.replaceAll("src='docs/images/", `src='${rawBase}/docs/images/`);
  content = content.replaceAll('src="./docs/images/', `src="${rawBase}/docs/images/`);
  content = content.replaceAll("src='./docs/images/", `src='${rawBase}/docs/images/`);
  content = content.replaceAll('](docs/images/', `](${rawBase}/docs/images/`);
  content = content.replaceAll('(docs/images/', `(${rawBase}/docs/images/`);
  content = content.replaceAll('](./docs/images/', `(${rawBase}/docs/images/`);
  // Generic fallback: any remaining bare docs/images/ that is not already absolute
  // covers edge forms like "docs/images/" inside plain URLs; guard with negative lookbehind
  // if the running Node supports it, otherwise fall back to no-op (explicit cases already cover expected inputs)
  try {
    const re = new RegExp(`(?<!https://raw\\.githubusercontent\\.com/[^/]+/[^/]+/main/)docs/images/`, 'g');
    content = content.replace(re, `${rawBase}/docs/images/`);
    // The above keeps scheme; re-apply only for remaining bare occurrences.
    // Simpler deterministic fallback for any left bare occurrence preceded by " or ' or ( or space or >
    content = content.replace(/(["'\(\s>])docs\/images\//g, `$1${rawBase}/docs/images/`);
  } catch {
    // Node < 18 lookbehind unsupported: rely on explicit replaces only
  }

  // 2) ./LICENSE -> github blob
  content = content.replaceAll('./LICENSE', `${githubBase}/blob/main/LICENSE`);
  // Also handle bare (LICENSE) if ever used without ./
  content = content.replaceAll('(LICENSE)', `(${githubBase}/blob/main/LICENSE)`);

  // 3) [English](README.en.md) -> absolute (also handle ./README.en.md)
  content = content.replaceAll('(README.en.md)', `(${githubBase}/blob/main/README.en.md)`);
  content = content.replaceAll('(./README.en.md)', `(${githubBase}/blob/main/README.en.md)`);
  // Defensive: also handle quoted README links
  content = content.replaceAll('"README.en.md"', `"${githubBase}/blob/main/README.en.md"`);
  content = content.replaceAll("'README.en.md'", `'${githubBase}/blob/main/README.en.md'`);

  // 4) ./CONTRIBUTING.md -> absolute (also without ./)
  content = content.replaceAll('./CONTRIBUTING.md', `${githubBase}/blob/main/CONTRIBUTING.md`);
  content = content.replaceAll('(CONTRIBUTING.md)', `(${githubBase}/blob/main/CONTRIBUTING.md)`);
  // Also handle AGENTS.md relative links for completeness (navigation added in README)
  content = content.replaceAll('./AGENTS.md', `${githubBase}/blob/main/AGENTS.md`);
  content = content.replaceAll('(AGENTS.md)', `(${githubBase}/blob/main/AGENTS.md)`);

  // Inject header
  const out = `${HEADER}\n\n${content.replace(/^\n+/, '')}`;
  // Ensure dest ends with newline
  const finalOut = out.endsWith('\n') ? out : out + '\n';
  writeFileSync(destPath, finalOut, 'utf8');
  console.log(`[build-readme] ${srcPath} -> ${destPath}`);
  console.log(`[build-readme] githubBase=${githubBase} rawBase=${rawBase}`);
}

build();

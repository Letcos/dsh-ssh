# dsh-ssh

[中文](README.md) | English

[![npm version](https://img.shields.io/npm/v/@dsh-ssh/dsh-ssh)](https://www.npmjs.com/package/@dsh-ssh/dsh-ssh)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Run your DeepSeek Harness workspace on any remote machine over SSH — right from the DSH settings page. Configure a host, pick one of its directories as a workspace, and every bash / file / search tool call runs on that machine instead of your own.

<p align="center">
  <img src="docs/images/dsh-ssh-settings.png" alt="Configure SSH hosts in settings" width="720"><br>
  <em>Add SSH hosts in the settings page</em>
</p>
<p align="center">
  <img src="docs/images/dsh-ssh-workspace.png" alt="Browse a remote directory and adopt it as workspace" width="720"><br>
  <em>Browse a remote directory and pick it as the workspace</em>
</p>

> **Why dsh-ssh**
>
> Built entirely on DSH's official public contract for third-party plugins — purely additive, zero changes to DSH core, and zero installation on the remote (it only needs a plain `sshd`). Remove it and DSH is exactly as it was. Your local workspaces behave byte-for-byte identically to before.

## Table of Contents

- [Features](#features)
- [Install](#install)
- [Quickstart (30 seconds)](#quickstart-30-seconds)
- [What runs where](#what-runs-where)
- [Compatibility](#compatibility)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Development](#development)
- [License](#license)

## Features

- **SSH hosts in Settings**: add / edit / delete hosts (host, port, user, key or password) right in the DSH settings page, with a one-click connection test.
- **Remote directories as workspaces**: browse the remote directory tree when creating a workspace and pick any folder. Local and remote workspaces coexist; switch the running machine any time.
- **Seven tools run remotely**: `bash`, `read`, `write`, `edit`, `read_image`, `glob`, and `grep` all execute on the remote machine — same names, same arguments, no model-visible difference.
- **Trust on first use (TOFU)**: the first connection to an unknown host shows a fingerprint confirmation; the host key is then verified on every later connection.
- **Background tasks work remotely**: `run_in_background` with the full `job_list` / `job_output` / `job_kill` chain all run on the remote.
- **Sandbox enforced remotely**: all three sandbox modes apply on the remote host exactly as they do locally.
- **Robust by default**: known-hosts verification, automatic reconnect, atomic writes (temp file + rename), and a pooled `ssh2` connection for exec + SFTP.
- **Credentials write-only**: passwords are stored through DSH's settings secret mechanism; private keys are referenced by local path.

## Install

```bash
dsh plugin --profile web add @dsh-ssh/dsh-ssh
```
If pnpm reports `ERR_PNPM_ADDING_TO_ROOT`, append `-w` (profile dirs are pnpm workspace roots and pnpm 11 requires the flag).

pnpm 11 blocks the build scripts of `ssh2` and its optional native accelerator `cpu-features`, so the install may end with `ERR_PNPM_IGNORED_BUILDS` (listing `cpu-features`, `ssh2`). Neither needs to build — `cpu-features` is only an optional native crypto accelerator and falls back to pure JS when skipped. Unblock, then reinstall: run `pnpm approve-builds` in the profile directory and choose to skip both, or edit the profile's `pnpm-workspace.yaml` to add `allowBuilds: { cpu-features: false, ssh2: false }`.

Restart DSH, then open the settings page and add your first host.

## Quickstart (30 seconds)

1. **Add a host** — Settings → SSH Hosts → add host, enter host / port / user / auth, hit *Test connection*.
2. **Trust the key** — the first connection shows a fingerprint confirmation (TOFU). Confirm to trust it.
3. **Create a remote workspace** — new conversation → create / switch workspace → browse the remote directory → pick a folder.
4. **Done** — tools are automatically routed over SSH while the workspace is remote. Nothing else to configure; the standard preset works as-is.

## What runs where

In a remote workspace, only the seven routed tools execute on the remote host:

| Capability | Runs on |
|---|---|
| `bash`, `read`, `write`, `edit`, `read_image`, `glob`, `grep` | **Remote machine (over SSH)** |
| skill tools, MCP tools, and all other host tools | **Your local machine** |

## Compatibility

| Dimension | Status |
|---|---|
| Remote OS | Ubuntu ✅ · macOS ✅ (tested against real hosts) |
| Authentication | Key-based ✅ · Password ✅ |
| Remote needs | Plain `sshd` only — no agent, service, or kernel module |
| Windows remote | Not supported (Linux / macOS only) |
| Preset | Any preset, including the standard one — independent of presets |

> **Requirements**: Node ≥ 22 · pnpm 11.21.0 · DSH peerDependencies (`@deepseek-ai/cordis@^4.0.1`, `@deepseek-ai/dsh-*@^0.1.1-rc.2`, `@deepseek-ai/schemastery@^3.18.1` — see `packages/dsh-ssh/package.json`)

## Known limitations

- No ProxyJump / multi-hop — direct single-hop connections only.
- Remote `grep` uses GNU grep; ignore rules differ slightly from `rg`.
- If SFTP is disabled on the remote, file operations automatically fall back to `exec` + base64 (works, but slower).
- Windows remote hosts are not supported.

## Troubleshooting

- **Cannot connect / Test connection fails**: check host / port / user, firewall for port 22, whether `sshd` is running, and auth (key path / password); the Settings → *Test connection* does a real handshake + `echo`, and errors include hostId and remote output.
- **Fingerprint mismatch / TOFU verification fails**: the first connection shows a fingerprint popup (TOFU) and writes to `known_hosts` once confirmed; `host key changed` means the remote was reinstalled or a MITM risk — verify and then remove the stale `known_hosts` entry or re-trust.
- **Private key permission error (UNPROTECTED PRIVATE KEY)**: OpenSSH requires `600`/`400` (no group/other read); fix file permissions and path (avoid spaces or CJK characters), and ensure DSH can read it.
- **SFTP disabled → falls back to exec + base64 (slower)**: if the remote disables SFTP, file ops still work via exec-channel base64 (ExecFs) but large / batch ops are noticeably slower — expected degradation; enable the SFTP subsystem in `sshd_config` to restore speed.
- **Placeholder directory (`~/.dsh/remote/<hostId>/...`)**: a remote workspace is just a local placeholder (plain workspace record, `workspaceRegistry` does `realpath` check); it holds no business data but must exist and must not be a symlink — do not delete/move it manually, switch via DSH workspace management.
- **How to collect logs**: tool failures include hostId, the exact remote command, exit code and tail output; combine with `~/.dsh/settings.yaml` (`dsh-ssh-hosts`), DSH console logs, and remote `sshd` logs (`/var/log/auth.log` or `journalctl -u sshd`) and attach sanitized info when filing an issue.

## FAQ

**Does this affect my local workspaces?**
No. The plugin is purely additive — local paths still go through DSH's own host implementation, byte-for-byte unchanged.

**Are background tasks supported?**
Yes. `run_in_background` and the whole `job_list` / `job_output` / `job_kill` chain execute on the remote machine.

**Are my credentials safe?**
Passwords are stored write-only through DSH's secret mechanism; private keys are referenced by local path and never copied. Unknown hosts are vetted by a TOFU fingerprint confirmation before anything is trusted.

**Do I need a special preset?**
No. Tool routing is independent of presets and works with the standard preset.

**How do I uninstall?**
```bash
dsh plugin --profile web remove @dsh-ssh/dsh-ssh
```
DSH is fully restored — no trace left behind.

## Development

This repository is a pnpm workspace; developer-oriented documentation lives in the root [CONTRIBUTING.md](./CONTRIBUTING.md). See [CONTRIBUTING.md](./CONTRIBUTING.md) for the package layout, tests, and live verification scripts.

> **Navigation**: Agent entry → [AGENTS.md](./AGENTS.md) · Developer handbook → [CONTRIBUTING.md](./CONTRIBUTING.md)

## License

[MIT](./LICENSE)

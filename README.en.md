# dsh-ssh

[中文](README.md) | English

[![npm version](https://img.shields.io/npm/v/@dsh-ssh/dsh-ssh)](https://www.npmjs.com/package/@dsh-ssh/dsh-ssh)
[![license](https://img.shields.io/npm/l/@dsh-ssh/dsh-ssh)](./LICENSE)

Run your DeepSeek Harness workspace on any remote machine over SSH — right from the DSH settings page. Configure a host, pick one of its directories as a workspace, and every bash / file / search tool call runs on that machine instead of your own.

<!-- TODO: screenshot -->

> **Why dsh-ssh**
>
> Built entirely on DSH's official public contract for third-party plugins — purely additive, zero changes to DSH core, and zero installation on the remote (it only needs a plain `sshd`). Remove it and DSH is exactly as it was. Your local workspaces behave byte-for-byte identically to before.

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
dsh plugin add @dsh-ssh/dsh-ssh
```

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
| Authentication | Key-based ✅ |
| Remote needs | Plain `sshd` only — no agent, service, or kernel module |
| Windows remote | Not supported (Linux / macOS only) |
| Preset | Any preset, including the standard one — independent of presets |

## Known limitations

- `~/.ssh/config` is not parsed — fill in hosts explicitly in the settings page.
- No ProxyJump / multi-hop — direct single-hop connections only.
- Remote `grep` uses GNU grep; ignore rules differ slightly from `rg`.
- If SFTP is disabled on the remote, file operations automatically fall back to `exec` + base64 (works, but slower).
- Windows remote hosts are not supported.

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
dsh plugin remove @dsh-ssh/dsh-ssh
```
DSH is fully restored — no trace left behind.

## Development

This repository is a pnpm workspace; developer-oriented documentation lives in `packages/dsh-ssh/`. See [packages/dsh-ssh/README.md](./packages/dsh-ssh/README.md) for the package layout, tests, and live verification scripts.

## License

[MIT](./LICENSE)

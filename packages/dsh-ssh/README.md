<!-- AUTO-GENERATED from /README.md by scripts/build-readme.mjs — do not edit manually -->

# dsh-ssh

中文 | [English](https://github.com/dsh-ssh/dsh-ssh/blob/main/README.en.md)

[![npm version](https://img.shields.io/npm/v/@dsh-ssh/dsh-ssh)](https://www.npmjs.com/package/@dsh-ssh/dsh-ssh)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/dsh-ssh/dsh-ssh/blob/main/LICENSE)

通过 SSH 把 DeepSeek Harness 的工作区放到任意一台远端机器上 —— 直接在 DSH 设置页里配置主机、把它某个目录选成工作区，之后所有 bash / 文件 / 搜索工具调用都在那台机器上执行，而不是在你本机。

<p align="center">
  <img src="https://raw.githubusercontent.com/dsh-ssh/dsh-ssh/main/docs/images/dsh-ssh-settings.png" alt="设置页配置 SSH 主机" width="720"><br>
  <em>设置页里添加 SSH 主机</em>
</p>
<p align="center">
  <img src="https://raw.githubusercontent.com/dsh-ssh/dsh-ssh/main/docs/images/dsh-ssh-workspace.png" alt="浏览远端目录并选为工作区" width="720"><br>
  <em>浏览远端目录，选为工作区</em>
</p>

> **为什么选它**
>
> 完全基于 DSH 面向第三方插件的官方公开契约构建 —— 纯附加、不改 DSH core 一行、远端零安装（只需要一个普通 `sshd`）。卸载后 DSH 恢复原样；本地工作区行为与之前逐字节一致。

## 目录

- [功能](#功能)
- [安装](#安装)
- [快速上手（30 秒）](#快速上手30-秒)
- [什么在哪侧执行](#什么在哪侧执行)
- [兼容性](#兼容性)
- [已知限制](#已知限制)
- [故障排查](#故障排查)
- [FAQ](#faq)
- [开发](#开发)
- [License](#license)

## 功能

- **设置页 SSH 主机**：直接在 DSH 设置页增 / 删 / 改主机（host / port / user / 密钥或口令），一键测试连接。
- **远端目录即工作区**：创建工作区时浏览远端目录树，任意选一个文件夹；本地 / 远端工作区共存，随时切换运行机器。
- **七工具远端执行**：`bash`、`read`、`write`、`edit`、`read_image`、`glob`、`grep` 全在远端执行 —— 同名同参，对模型无感。
- **首次信任（TOFU）**：首次连接未知主机会弹出指纹确认，之后每次连接都会校验主机密钥。
- **后台任务远端化**：`run_in_background` 连同 `job_list` / `job_output` / `job_kill` 整条链路都在远端执行。
- **Sandbox 远端同样生效**：三种 sandbox 模式在远端与本地行为一致。
- **默认健壮**：known_hosts 校验、断线自动重连、原子写入（临时文件 + rename）、`ssh2` 连接池（exec + SFTP 复用）。
- **凭据只写存储**：口令经 DSH settings 的 secret 机制只写保存；私钥按本地路径引用。

## 安装

```bash
dsh plugin --profile web add @dsh-ssh/dsh-ssh
```
若 pnpm 报 `ERR_PNPM_ADDING_TO_ROOT`，在命令末尾加 `-w`（profile 目录是 pnpm workspace 根，pnpm 11 需要显式允许）。

pnpm 11 会拦截 `ssh2` 及其可选原生加速依赖 `cpu-features` 的构建脚本，安装可能以 `ERR_PNPM_IGNORED_BUILDS`（列出 `cpu-features`、`ssh2`）收尾。二者都**无需构建**——`cpu-features` 仅是可选的原生加密加速，跳过即自动回退纯 JS 实现，功能不变。解除拦截后重新安装：在 profile 目录执行 `pnpm approve-builds` 把两个包都选为跳过，或编辑 profile 的 `pnpm-workspace.yaml` 加入 `allowBuilds: { cpu-features: false, ssh2: false }`。

重启 DSH，在设置页添加你的第一台主机。

## 快速上手（30 秒）

1. **添加主机** —— 设置页 → SSH 主机 → 添加主机，填 host / port / user / 认证方式，点测试连接。
2. **信任密钥** —— 首次连接会弹指纹确认（TOFU），确认即信任。
3. **创建远端工作区** —— 新会话 → 创建 / 切换工作区 → 浏览远端目录 → 选一个文件夹。
4. **完成** —— 工作区为远端时，工具自动经 SSH 路由到远端执行，其余无需配置；standard preset 即可。

## 什么在哪侧执行

在远端工作区中，只有下面七个路由工具落在远端主机上：

| 能力 | 执行位置 |
|---|---|
| `bash`、`read`、`write`、`edit`、`read_image`、`glob`、`grep` | **远端机器（经 SSH）** |
| skill 工具、MCP 工具及其它宿主工具 | **你的本地机器** |

## 兼容性

| 维度 | 状态 |
|---|---|
| 远端系统 | Ubuntu ✅ · macOS ✅（真机实测） |
| 认证 | 密钥 ✅ · 口令 ✅ |
| 远端依赖 | 仅需普通 `sshd`，无需 agent / 服务 / 内核模块 |
| Windows 远端 | 不支持（仅 Linux / macOS） |
| Preset | 任意 preset 均可，含 standard；与 preset 无关 |

> **版本要求**：Node ≥ 22 · pnpm 11.21.0 · DSH peerDependencies（`@deepseek-ai/cordis@^4.0.1`、`@deepseek-ai/dsh-*@^0.1.1-rc.2`、`@deepseek-ai/schemastery@^3.18.1`，详见 `packages/dsh-ssh/package.json`）

## 已知限制

- 不支持 ProxyJump / 多跳 —— 仅单跳直连。
- 远端 `grep` 基于 GNU grep，忽略规则与 `rg` 略有差异。
- 远端禁用 SFTP 时，文件操作自动降级为 `exec` + base64（可用但更慢）。
- 不支持 Windows 远端。

## 故障排查

- **连不上主机 / 测试连接失败**：检查 host / port / user 是否正确、22 端口是否放行、远端 `sshd` 是否运行、认证（密钥路径/口令）是否有效；设置页「测试连接」会执行真实握手 + `echo`，错误信息含 hostId 与远端输出，便于定位。
- **指纹不匹配 / TOFU 校验失败**：首次连接会弹窗显示主机指纹（TOFU），确认后写入 `known_hosts`；若提示 `host key changed` 或指纹不匹配，说明远端重装或存在中间人风险，请核实后删除对应 `known_hosts` 条目或重新信任。
- **私钥权限错误（UNPROTECTED PRIVATE KEY）**：OpenSSH 要求私钥权限为 `600`/`400`，组/其他用户不可读写，否则直接拒绝；请检查文件权限与路径（避免含空格或中文），确保 DSH 能读取。
- **SFTP 被禁时自动降级为 exec + base64（变慢）**：远端若禁用 SFTP，文件操作仍可用但降级为 `exec` 通道 base64 传输（ExecFs），大文件/批量操作会明显变慢，属预期降级；如需恢复速度请在远端 `sshd_config` 启用 SFTP 子系统。
- **占位目录说明（`~/.dsh/remote/<hostId>/...`）**：远端工作区在本地仅为占位目录（普通 workspace 记录，`workspaceRegistry` 会 `realpath` 校验），不含业务数据但必须真实存在且不能为符号链接；请勿手动删除或移动，需切换请走 DSH 工作区管理。
- **如何收集日志**：工具失败会返回带 hostId、远端命令原文、退出码与输出尾部的明确错误；配合 `~/.dsh/settings.yaml` 中 `dsh-ssh-hosts` 配置、DSH 控制台日志与远端 `sshd` 日志（`/var/log/auth.log` 或 `journalctl -u sshd`）可快速定位，提 issue 时请脱敏后附上。

## FAQ

**会影响我的本地工作区吗？**
不会。插件是纯附加的 —— 本地路径仍走 DSH 宿主自身实现，逐字节不变。

**支持后台任务吗？**
支持。`run_in_background` 与 `job_list` / `job_output` / `job_kill` 整条链路都在远端执行。

**凭据安全吗？**
口令经 DSH secret 机制只写存储；私钥按本地路径引用、从不复制。未知主机在信任前都会先经 TOFU 指纹确认把关。

**需要专用 preset 吗？**
不需要。工具路由与 preset 无关，standard preset 即可。

**如何卸载？**
```bash
dsh plugin --profile web remove @dsh-ssh/dsh-ssh
```
DSH 完全复原，不留痕迹。

## 开发

本仓库是 pnpm workspace；面向开发者的文档在根 [CONTRIBUTING.md](https://github.com/dsh-ssh/dsh-ssh/blob/main/CONTRIBUTING.md)。包结构、测试与真机验证脚本见 [CONTRIBUTING.md](https://github.com/dsh-ssh/dsh-ssh/blob/main/CONTRIBUTING.md)。

> **导航**：Agent 入口见 [AGENTS.md](https://github.com/dsh-ssh/dsh-ssh/blob/main/AGENTS.md) · 开发者手册见 [CONTRIBUTING.md](https://github.com/dsh-ssh/dsh-ssh/blob/main/CONTRIBUTING.md)

## License

[MIT](https://github.com/dsh-ssh/dsh-ssh/blob/main/LICENSE)

# Agent Note: 同名工具 + glob/grep 远端重实现
Status: implemented

> **演进说明**：本 note 原含 `preset standard-ssh` 相关内容，已于 2026-08-20 随 `implemented/simplification/2026-08-20-remove-standard-ssh-preset.md` 拆分归档至 `archived/2025-08-16-preset-standard-ssh.md`（preset 已移除，代码中无 `standard-ssh`）。当前仅保留仍存在的实现。

## Problem
- 让远端工作区里的 bash/read/write/edit/read_image/glob/grep 语义与本地一致，本地路径行为逐字节不变；glob/grep 不能复用本地 rg（远端无 rg）。

## Decision
- **同名工具按 cwd 路由（当前形态）**：7 个工具（bash/read/write/edit/read_image/glob/grep）与官方同名，路由键 = 会话 `cwd`（`exec.agent?.session?.header?.cwd`）。本地路径（不在占位前缀 `~/.dsh/remote/<hostId>/...` 下）→ `ctx.tools.get(name)` 无 scope 委托 host 全局官方实现（逐字节一致，零重实现）；远端占位路径 → 解码回远端绝对路径走 SSH（exec/SFTP）。工具注册经 `host` 插件监听 `agent/created` 钩子在远端占位 cwd 会话的 `agent` scope 遮蔽官方工具实现（详见 `implemented/feature/2026-08-19-preset-independent-tool-routing.md`），不再依赖 `standard-ssh` preset（已移除，见 `archived/2025-08-16-preset-standard-ssh.md`）。
- 路径编码 = base64url（无补位单段、可逆、hostId 校验避免穿越；解码须回读为 `/` 开头绝对路径）。
- **glob/grep 远端重实现**（对齐 rg 语义）：`glob` = `find -type f` + VCS prune + `-printf %T@` 按 mtime 排序 + 本地 `globToRegExp` 精确过滤（pattern 匹配对象 = 会话 cwd 相对路径）；`grep` = `grep -n -H -I` + `--exclude-dir='.*'` + 行号/路径解析 + 二进制跳过；超时 30s → `SEARCH_ABORTED`；原始输出 20MB 上限。超出 glob/grep 结果上限（100/250）取 mtime 头 + 页脚说明不落盘。
- 文档化差异（不静默错误）：`.gitignore` 不读、隐藏文件被搜到、BSD `find` 无 mtime 排序、`include` 含 `/` 拒绝、符号链接不跟随等。

## Alternatives considered
- 每个文件操作拼 shell（TRAMP 式）：转义面大、无标准 rename/stat 语义、原子写难 → 主路径 SFTP（见 SFTP fallback note）。
- preset 复制方案：曾用 `agentPresets.copy('standard','standard-ssh')` 单行工具注册，方案⑤落地后冗余已移除（见 `archived/2025-08-16-preset-standard-ssh.md`）。

## Consequences
- 本地委托无递归风险（`dsh-tools` `get(name)` 省略 scope = 全局视图，取到官方实现）。
- OpenSSH 基础 SFTP rename 拒绝覆盖已存在目标（无 `posix-rename` 扩展）→ `writeFileAtomic` 用临时文件 + `rename` 失败后 `unlink` + 重试（等价值语义）。
- `readBytes` 流水线读需「发出请求时推进 offset」+ 先 `stat` 拿 size 判定完成（回调已收字节 >= size），否则并发读乱序 EOF 丢数据（坑在案）。

## 出处
- `archived/a-series-log.md` A.5（M3b 五工具路由）、A.6（M3c glob/grep 语义对照）。
- `archived/2025-08-16-preset-standard-ssh.md`（preset 已移除归档，含原 A.4）。
- `dsh-tools@lib/index.js:2755/2872` 注册与全局视图；`dsh-tool-bash/-fs/-fs-search` 契约；本仓库 `src/router.js`、`src/search.js`、`tools.js`。

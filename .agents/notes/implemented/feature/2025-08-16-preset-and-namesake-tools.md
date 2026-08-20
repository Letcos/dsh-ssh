# Agent Note: standard-ssh preset 与同名六工具 + glob/grep 远端重实现
Status: implemented

## Problem
- 让远端工作区里的 bash/read/write/edit/read_image/glob/grep 语义与本地一致,本地路径行为逐字节不变;glob/grep 不能复用本地 rg(远端无 rg)。

## Decision
- **preset = agentPresets.copy('standard','standard-ssh') 复制官方 preset + 工具行整体换成单行 `- id: tool-ssh / name: 'dsh-ssh/tools' / config: {}`**(dsh-tool-fs 一行注册 read/write/edit/read_image 是官方既有模式;同名工具在同一 scope 重复注册抛错,故收敛为单行;import 走包 exports 子路径 `./tools`)。preset 行要求服务行在 isolate 组,工具行不需要。
- **同名工具按 cwd 路由**:6 个工具与官方同名;路由键 = 会话 cwd(`exec.agent?.session?.header?.cwd`)。本地路径(不在占位前缀下)→ `ctx.tools.get(name)` 无 scope 委托 host 全局官方实现(逐字节一致,零重实现);远端占位路径(`~/.dsh/remote/<hostId>/...`)→ 解码回远端绝对路径走 SSH(exec/SFTP)。
- 路径编码 = base64url(无补位单段、可逆、hostId 校验避免穿越;解码须回读为 '/' 开头绝对路径)。
- **glob/grep 远端重实现**(对齐 rg 语义):glob=`find -type f` + VCS prune + `-printf %T@` 按 mtime 排序 + 本地 globToRegExp 精确过滤(pattern 匹配对象=会话 cwd 相对路径);grep=`grep -n -H -I` + `--exclude-dir='.*'` + 行号/路径解析 + 二进制跳过;超时 30s → SEARCH_ABORTED;原始输出 20MB 上限。超出 glob/grep 结果上限(100/250)取 mtime 头 + 页脚说明不落盘。
- 文档化差异(不静默错误):.gitignore 不读、隐藏文件被搜到、BSD find 无 mtime 排序、include 含 '/' 拒绝、符号链接不跟随等。

## Alternatives considered
- 每个文件操作拼 shell(TRAMP 式):转义面大、无标准 rename/stat/语义、原子写难 → 主路径 SFTP(见 SFTP desc fallback note)。

## Consequences
- 本地委托无递归风险(dsh-tools get(name) 省略 scope=全局视图,取到官方实现)。
- OpenSSH 基础 SFTP rename 拒绝覆盖已存在目标(无 posix-rename 扩展)→ writeFileAtomic 用临时文件 + rename 失败后 unlink+重试(等价值语义)。
- readBytes 流水线读需「发出请求时推进 offset」+ 先 stat 拿 size 判定完成(回调理已收字节>=size),否则并发读乱序 EOF 丢数据(坑在案)。

## 出处
- archived/a-series-log.md A.4(M3a preset 产物)、A.5(M3b 五工具路由)、A.6(M3c glob/grep 语义对照)。
- dsh-tools@lib/index.js:2755/2872 注册与全局视图;dsh-tool-bash/-fs/-fs-search 契约;dsh-agent-presets copy/discovery;本仓库 src/router.js、src/search.js、tools.js。

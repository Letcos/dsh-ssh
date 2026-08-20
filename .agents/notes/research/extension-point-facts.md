# 扩展点事实核查(主编代理一手验证)

> 本文件由主编代理在等待调研子代理期间独立验证, 与 dsh-official-reference.md(调研子代理产出)互为交叉验证。所有条目注明出处。日期: 2025-08-16。

## 1. agent preset

- `copy(from: string, id: string, name?: string): Promise<void>` — 出处: 源码 @deepseek-ai/dsh-agent-presets/lib/types/index.d.ts L228。语义: "Create a locally authored preset by copying an existing one whole"; 复制后不会自动 mount, 需要会话选择该 preset。
- standard preset 原文: 本地 checkout `config/agent-presets/standard/agent.cordis.yml`。待替换的三行:
  - `tool-bash` → `@deepseek-ai/dsh-tool-bash`(win32 禁用)
  - `tool-fs` → `@deepseek-ai/dsh-tool-fs`
  - `tool-fs-search` → `@deepseek-ai/dsh-tool-fs-search`(config: sampleOverCapGlobResults: false)
- 重要机制(preset 文件头注释): preset 行必须位于带 `isolate` realm 的 group 内, 否则 dsh-agent-presets 在 mount 时拒绝; tool-* 行注册进 host 的 tools registry、不提供服务本身; `tool-jobs`/skill/plan-mode 等行按需保留。
- preset 目录发现: "受信任根目录 + 用户创作根目录"(见 capability-seams 文档 ctx.agentPresets 行)。

## 2. 工具注册(extension-cookbook 官方文档)

- 工具在 `ctx.tools` 上注册: `ctx.tools.register()`(可接收原始 JSON Schema ToolDefinition), 第一方推荐 `defineTool` 类型化辅助函数(真源: adding-a-tool 指南)。
- 钩子链: `tools/pre-execute`(返回类型化决策: 允许/拒绝/ask)、`tools/execute`(包装核心分发, 可替换 exec.signal/委托执行——**这正是我们"同名工具路由"可借用的钩子, 但注意: 钩子是全局的, 与按 cwd 路由的工具实现是两条路**)、`tools/result`(不可变权威结果)、`tools/post-execute`(变换结果)。
- 沙箱: `dsh-bash-sandbox` 通过 `ctx.sandbox` 后端; 能力级拒绝用 tools/pre-execute。

## 3. bundle / publish(develop/basic/publish 官方文档)

- 组合包(bundle) = 附带配置层的 npm 包, `dsh.bundle` manifest 声明 patch 文件; profile = $DSH_HOME/profiles/<name> 下带 `dsh.profile` manifest 的目录。二者互斥, 无包同时是两者。
- 包模板: `{name, version, type:"module", main, files:[...patch], dsh:{bundle:{patch:"./cordis.patch.yml"}}}`。
- 开发期可用 `--patch overlay` 直接加载本地插件(不用先 install) — M1 可优先用此路径快速验证。
- **M1 验收链已实测(2025-08-16, 主编代理, 用 /tmp 探针包 + 隔离 profile dssh-dev)**: ① `dsh plugin --profile dssh-dev add <本地路径>` → pnpm 以 link: 依赖安装并**自动把包名追加进 dsh.profile.bundles**; ② `dsh --profile dssh-dev --dump-config` → 组合整棵 profile 树并退出(exit 0), 输出可见 `# == <包名>` 段与 insert 行; ③ `dsh plugin --profile dssh-dev remove <包名>` → 干净卸载, bundles 恢复。注意: `dsh plugin` 子命令即转发 pnpm; add 本地路径无构建授权问题。
- 实测模板(本仓库 bundle 包): 带 `dsh.client: {platform:"web", inject:["@deepseek-ai/dsh-client-ui-primitives"]}` 与 peerDependencies(@deepseek-ai/cordis ^4、dsh-tools、dsh-jobs、dsh-subagent、dsh-client-ui-primitives、schemastery ^3) — 出处: 本仓库 packages/dsh-ssh/package.json 的 dsh.client 声明。

## 4. UI 槽与通信(源码验证)

- 工作区目录流程槽(精确名字): `conversation.hero.workspace.directoryFlow` 与 `sidebar.workspaces.directoryFlow` — 出处: @deepseek-ai/dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts L48-62; 相关 Props 类型 WorkspaceBrowserProps/WorkspacePickerProps 使用 PropsRenderSlots<...directoryFlow> + DirectoryPickingHooks。
- settings UI: `settings.section` 槽存在 — 出处: @deepseek-ai/dsh-settings(lib/index.js、lib/types/index.js)。
- settings 子系统(官方文档): namespace + schemastery schema 驱动表单; base/user 分层("用户已覆盖"标注); `describe({redactSecrets:true})` 剥除 role('secret') 字段并枚举其 {path,set} slot 供只写输入框 — **SSH 口令/私钥的存储方案应走这条**。
- Typert: TypertRemoteService 存在于 @deepseek-ai/dsh-cordis-host-runner 与 dsh-host-plugin-inventory; 协议包 @deepseek-ai/dsh-typert-protocol 导出 TypertRemoteRegistry/TypertLookupRegistry/TypertGatewayBinding 等(源码 lib/types/index.d.ts)。
- 目录选择器: @deepseek-ai/dsh-host-directory-picker-browse 导出 BrowseDirectoryPicker(extends DirectoryPicker), ListingCandidate/fullyQualified/raceAbort 等辅助。

## 5. AGENTS.md 约定(官方确认)

- extension-cookbook 文档明确: 系统提示词可配置性 = `ctx.systemPrompt.section()`, 其中 "AGENTS.md(根目录) 一个读取该文件的 section 提供方"。即根目录 AGENTS.md(本仓库为 agents.md, 大小写不敏感文件系统下同一文件)会被自动注入系统提示词。

## 6.5 开发环境事实(2025-08-16 主编探测)

- 本机 sshd 未开启(macOS Remote Login 关闭; 22 端口不通, 仅 ssh-agent 在运行)。
- **主测试远端(用户提供)**: ubuntu@203.0.113.10:22(公钥认证 OK; Ubuntu Linux x86_64, 5.15 内核; **exec + SFTP 均可用**)——M2/M3 的主验证目标。
- 次测试远端: haowu@203.0.113.10:16611(公钥认证 OK; Darwin arm64; exec 可用, SFTP 未开)——用于 exec-only 场景验证。
- **远端 SFTP 未开启**: sshd_config 中 `#Subsystem sftp /usr/libexec/sftp-server` 被注释(/usr/libexec/sftp-server 二进制存在)——exec 通道正常可用, M2 不受影响; M3 文件工具(SFTP 主路径)前需用户在远端取消注释并重启 sshd。
- 探测用的 known_hosts 隔离在 /tmp/dssh-test-known_hosts(不污染用户 ~/.ssh/known_hosts)。
- ssh2 npm 最新版 = 1.17.0(engines node>=10.16; 依赖仅 asn1 + bcrypt-pbkdf)——与可行性报告选型一致。

## 6.5.5 部署时间线

- 2025-08-16: 经用户确认, dsh-ssh 已安装进真实 web profile(bundles = [dsh-base, dsh-web-app, dsh-ssh]); web dump-config 确认 dsh-ssh 行(maxConnections: 4)进入组合。运行中的 GUI 需重启 + 刷新页面后生效。回滚: dsh plugin --profile web remove dsh-ssh。

## 6.6 客户端(client half)契约(M2b 预研, 2025-08-16 主编核对)

- 客户端插件行: bundle 包声明 dsh.client:{platform:'web', inject:['@deepseek-ai/dsh-client-ui-primitives']} + exports['./client'] → 客户端产物 client.js 被 web 以 /plugins/<id>/client.js 加载。
- client.js 形态(官方 client 插件契约): `window.__ModuleLoader__.load({ id, factory(require){...} })`; require('react') + require('@deepseek-ai/dsh-client-ui-primitives')(MarkdownText/Toast/DisclosureRow/各种 Icon)。
- settings.section 槽契约(@deepseek-ai/dsh-client-ui-settings@lib/types/client/contract/slots.d.ts): kind 'list', scope 'root', owner SettingsSectionOwnerProps; 注册项选项 {id(section key, 支持 only 过滤), order(导航位置), label(注册方本地化文案; locale 变化时需重新注册以刷新)}; 渲染在设置页内容列。另有 settings.plugins.tab(kind list, 注册在插件设置分区内, 选项 {id,order,label})。
- 提示: 客户端代码的运行时验证需要 web 应用重建; M2b 阶段以静态自检 + 模式一致性为准, 真机 UI 验证推迟到安装进 web profile + 重建 GUI 后(发布阶段)。
- **DSH_HOME 环境变量覆盖已实测(2025-08-16)**: `DSH_HOME=/tmp/<dir> dsh ...` 将 profiles/ 等全部用户数据重定向到指定目录(出处: lib/profile-boot 注释"may be set by the test or launcher after import"; 实测: 隔离目录内 initProfile + plugin add + dump-config 全链路成功)。**M3 起的 preset/settings/工作区实验一律用一次性 DSH_HOME, 不污染真实 ~/.dsh(GUI 正在使用)**。

## 6. 结论差异核对(与前期可行性报告对比)

- 报告中的槽名、copy API、bundle 机制、Typert 通道全部与源码/文档一致 ✅。
- 补充: tools/pre-execute / tools/execute 钩子是另一个可行入口(备用方案 B: 不换 preset, 用 execute 钩子拦截并路由 — 但会影响所有会话且需全局判断, 与"本地行为逐字节不变"约束冲突风险更高, 暂不采用; 仍记录备查)。
- 补充: 开发期可用 --patch overlay 快速加载, 不必先 dsh plugin add(加速 M1)。

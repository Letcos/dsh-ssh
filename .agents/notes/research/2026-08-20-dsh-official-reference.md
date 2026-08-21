# DSH 官方扩展点与开发规范速查(dsh-ssh 调研笔记)

> 调研对象: 官方文档站点(VitePress, 根 locale 简体中文, 2026-08 抓取) + 本地 DSH 安装(只读) <dsh-checkout> (版本 0.1.0-rc.6; 调研后上游已发布 rc.7) + GitHub 仓库 deepseek-ai/deepseek-harness(master 分支)。
> 约定: 「源码核对过」= 在本地 checkout 包内 grep/read 到确切声明, 出处写 包名@lib/... ; 「仅文档」= 只出现在官方站点/仓库文档, 未在本地包内核对。

## 一、文档页索引(前缀 https://deepseek-harness.github.io/deepseek-harness)

| 页面路径 | 标题 | 与 dsh-ssh 相关要点 |
|---|---|---|
| /develop/basic/ | 第一个插件 | 插件=导出 name+apply(ctx) 的模块; 注册是效果自动清理; inject 声明依赖; 三种形态(函数/对象/类) |
| /develop/basic/tool | 开发一个工具 | defineTool({name,description,parameters,output:{schema,render},execute}); ctx.tools.register |
| /develop/basic/config | 插件配置 | 导出 Config 接口+同名 Schemastery schema; 配置错误要响亮; HMR 触发热替换 |
| /develop/basic/publish | 打包与安装插件 | bundle(package.json 的 dsh.bundle) vs profile(dsh.profile); dsh plugin add; 层顺序与覆盖规则 |
| /develop/framework/ | 插件与生命周期 | Fiber 状态机 PENDING→LOADING→ACTIVE; 自动清理; ctx.plugin/dispose; HMR |
| /develop/framework/service | 服务与依赖 | Service 基类 super(ctx,name); inject; isolate 组隔离(同一个服务多实例) |
| /develop/framework/events | 事件系统 | emit/bail/serial/waterfall(必须调 next()); 命名 namespace/action; session/event 持久化 |
| /reference/capability-seams | 能力 Seams 与核心服务 | 全 ctx 服务总表(角色/包/实现/消费方): shell/fs/subprocess/settings/credentials/workspaceRegistry/directoryPicker/typert/jobs 等 |
| /reference/agent-lifecycle | Agent 轮次与步骤生命周期 | session/event(可回放) vs agent/*(实时); agent/pre-step 与 agent/request-error |
| /reference/tool-execution-pipeline | 工具执行流水线 | pre-execute→单调 guard→execute→post-execute→finalizeContent→result; fs/* 先读后编辑 |
| /reference/cordis-primer | Cordis 入门 | 5 核心概念; 分发模式表; waterfall 语义; Loader 的 !!js(cordis-plugin-include) |
| /reference/cookbook/adding-a-package | 实操:添加 workspace 包 | 仓库内建包清单(对 dsh-ssh 仅参考); 命名规范表 Provider/Executor/Backend/Handle... |
| /reference/cookbook/adding-a-tool | 工具编写参考 | execute 规则; output 规范值; presentCall/Result 卡片(generic/terminal/diff/read/search/web); ctx.jobs.start 后台; Code Mode 自动可达 |
| /reference/cookbook/extension-cookbook | 实操:扩展插件形态 | 权限门禁(tools/pre-execute); UI 插件(session/event+followup); 产品功能→机制映射表 |
| /reference/subsystems/settings | 用户设置 | settingsNamespace 注册; 分层解析(default→base→user); describe/update/replace/mutate; settings/updated |
| /reference/subsystems/credentials | 用户凭据 | CredentialRef(环境变量名); resolve/describe/set/unset; 按操作解析不缓存 |
| /reference/subsystems/typert | Typert 远程调用 | InvocationDescriptor; ctx.typert 注册表; ctx.typertGateway.invoke; 客户端 ctx.remote.$mount/$on |
| /reference/subsystems/client-modules | Client 模块 | dsh.client manifest + exports[./client] + window.__DSH_BOOT__ 图; /plugins/<id>/client.js |
| /reference/subsystems/workspace | 工作区 | Workspace 实体; ctx.workspaceRegistry.create(path) realpath 规范化、拒绝不存在路径; attachSession 校验 header cwd |
| /reference/subsystems/shell | Bash 执行器 | ctx.shell 的 resolve→spec→run/start; ShellRunResult; 文档明示「沙箱、远程或 PowerShell 执行器可以替换 bash-local」 |
| /reference/subsystems/subprocess | 子进程 | ctx.subprocess 的 spawn/spec 完全显式; SubprocessHandle terminate(SIGTERM→grace→KILL)/waitForExit; 进程树范围 |
| /reference/subsystems/filesystem | 文件系统 | ctx.fs 的 FileSystem resolve/stat/readText/writeText/editText/...; FsTarget 不透明; 文档明示 remote backend 可返回远端 URI |
| /reference/subsystems/tools | 工具 | ToolDefinition 各字段; ValueSchemaSpec/ParameterSchemaSpec DSL; guard()/restrict(); UI 卡片词汇 |
| /reference/subsystems/subagent | 子代理 | subagents seam + 提供方列表(spawn/fork/acp/codex/claude-code/dsh-sdk); tool-subagent 消费方 |
| /reference/subsystems/workflow | 工作流 | workflowEngine seam + worker-thread 引擎 + tool-workflow; WorkflowStartRequest/meta/result |
| /reference/subsystems/skills | Skills | ctx.skills 注册表; SkillProvider list/get; 本地发现优先级(project-dsh 最高) |

## 二、扩展点速查(能力 / 官方机制与出处 / dsh-ssh 如何用 / 验证状态)

| 能力 | 官方机制与出处 | dsh-ssh 如何用 | 验证 |
|---|---|---|---|
| 工具注册 | ctx.tools.register(defineTool({...})); @deepseek-ai/dsh-tools@lib/types/schema.d.ts:defineTool、lib/types/index.d.ts:ToolRuntime.register; 用法示例 dsh-tool-bash@lib/index.js:259 | 新包内注册同名工具 bash/read/write/edit/read_image/glob/grep, 按会话 cwd 路由 | 源码核对过 |
| 工具流水线钩子 | tools/pre-execute|execute|post-execute|result(waterfall); guard()/restrict(); @deepseek-ai/dsh-tools@lib/types/index.d.ts | 可选: 用 pre-execute 对远端路径做 allow/deny 策略 | 源码核对过 |
| agent preset | AgentPresets.copy(from,id,name?); ctx.agentPresets; 用户根 USER_PRESET_DIR=.agent-presets(dsh-agent-presets@lib/index.js:160); 标准 preset 原文 config/agent-presets/standard/agent.cordis.yml(tool-bash/tool-fs/tool-fs-search 三行) | 新建 preset standard-ssh = copy(standard) + 替换三行工具声明; 会话选它即启用远端工具 | 源码核对过 |
| bundle 插件通道 | package.json 的 dsh:{bundle:{patch:./cordis.patch.yml}}; 契约见 @deepseek-ai/dsh 与官方 /develop/basic/publish(cordis.patch.yml 为 insert 行数组, 行按包名引用); dsh plugin 命令(dsh@lib/bin.js:96) | dsh-ssh 包声明 bundle patch, 经 dsh plugin --profile <name> add 安装 | 源码核对过 |
| settings 持久化 | settingsNamespace(); ctx.settings(provider): register/describe/get/update/replace/mutate; installSettingsSection; @deepseek-ai/dsh-settings@lib/types/index.d.ts | SSH 主机配置存自定义 namespace(host/port/user/认证), 工具层经 ctx.settings 读取 | 源码核对过 |
| settings UI 槽 | 'settings.section' 槽(kind single, scope root); @deepseek-ai/dsh-client-ui-settings@lib/types/client/contract/slots.d.ts:67 | 客户端 UI 行: 设置页新增 SSH 主机配置表单 | 源码核对过 |
| 工作区目录流程槽 | 'sidebar.workspaces.directoryFlow' + 'conversation.hero.workspace.directoryFlow'(kind single; owner 契约 open/busy/onPicked(path)/onCancel/onError; occupant 拥有从 open 到 picked path 全程); @deepseek-ai/dsh-client-ui-workspace@lib/types/client/contract/slots.d.ts | 客户端组件填充两槽: Typert 浏览远端目录 → onPicked(远端路径) → 宿主建占位目录 | 源码核对过 |
| Typert Host↔Client | TypertRemoteService 抽象类 + @Remote(exportName?)/@RemoteScope; bindTypertRemote; @deepseek-ai/dsh-typert-protocol@lib/types/index.d.ts; 另有 dsh-cordis-host-runner/dsh-host-plugin-inventory 复用 | 宿主 TypertRemoteService 提供远端目录浏览/路径校验; 客户端经 ctx.remote.$mount 调用 | 源码核对过 |
| client 模块注入 | package.json 的 dsh.client{platform:web,inject:[...]} + exports[./client]; dsh-client-modules 扫描组合 window.__DSH_BOOT__ | dsh-ssh 声明 dsh.client 并把客户端 bundle 行送进 Web | 源码核对过 |
| ctx.shell | ShellExecutor: resolve(request)→spec; run(spec)→ShellRunResult; start(spec)→ShellProcess; @deepseek-ai/dsh-shell@lib/types/index.d.ts; 文档: 远程执行器可替换 bash-local | 本地路径 → 原样委托宿主 ctx.shell(行为不变); 远端路径 → ssh2 exec | 源码核对过(签名)/文档(远程替换) |
| ctx.fs | FileSystem: resolve/processPath/fileUrl/stat/lstat/readText/streamText/readBytes/listDir/writeText/editText; FsTarget(targetKey 不透明+displayPath); FsErrorCode; @deepseek-ai/dsh-fs@lib/types/index.d.ts | 本地路径 → 委托宿主 ctx.fs; 远端路径 → SFTP(读/写/编辑/read_image 字节流) | 源码核对过 |
| ctx.subprocess | SubprocessRuntime: spawn(spec)→SubprocessHandle(terminate/waitForExit/collected); spawnTerminal; @deepseek-ai/dsh-subprocess@lib/types/index.d.ts | 本地路径 → 委托宿主; 远端 glob/grep 不用本地 rg, 远端 find/grep -rn 重实现 | 源码核对过 |
| 工作区注册表 | ctx.workspaceRegistry: create(path,title?) realpath 规范化、拒绝不存在路径; get/list/delete/status(); attachSession 校验 header cwd==workspace path; @deepseek-ai/dsh-workspace@lib/types/index.d.ts | 占位目录 ~/.dsh/remote/<hostId>/<path> 必须真实存在; 作为普通 workspace 记录, sessions/apiProxy 零改动 | 源码核对过 |
| 目录选择 seam | ctx.directoryPicker: DirectoryPicker.capability(); 浏览后端经浏览器侧填充目录流程槽(不通过协议发布); 见 capability-seams | 不替换(host 单例); 用目录流程槽做远端浏览入口 | 源码核对过 |
| 后台任务 | ctx.jobs seam + jobs-local; ctx.jobs.start({kind,label,owner,run}); tool-jobs 模型侧控制; 见 shell 子系统页与 capability-seams | 远端后台任务需远端化(nohup/tmux+轮询), 或文档化限制 | 仅文档(+capability-seams) |
| 事件系统 | ctx.on/emit/bail/serial/waterfall; waterfall 必须调 next(); 类型声明合并; 见 /develop/framework/events、cordis-primer | 插件内部通信/状态通知(如连接状态变化) | 仅文档 |
| 服务与隔离 | Service 基类 super(ctx,name); inject 依赖; isolate 组(cordis-plugin-group)多实例; 见 /develop/framework/service | dsh-ssh 自身服务(连接池)以插件服务形式暴露给工具层 | 仅文档 |

## 三、打包安装与发布要点

1. **bundle 三件套**(官方 /develop/basic/publish 契约; 形态见本仓库 packages/dsh-ssh): package.json(声明 dsh:{bundle:{patch:./cordis.patch.yml}}; 有客户端则加 dsh:{client:{platform:web,inject:[...]}} 与 exports[./client]) + cordis.patch.yml(patch 条目数组, 行按包名引用) + lib/(宿主半 index.js + 客户端半 client.js)。
2. **安装**: dsh plugin --profile <name> add <本地路径|npm 包|github:user/repo#sha> —— 在 profile 目录内转发给 pnpm; 首次自动初始化 profile(@deepseek-ai/dsh-base 为第一层), 有 dsh.bundle 声明的包追加进 dsh.profile.bundles。移除: dsh plugin --profile <name> remove <pkg>。
3. **层顺序**(后层胜出, 按 id 覆盖行时**整个 config 被替换**, 须重述全部键): 空根 → profile bundles(按列表顺序) → profile 自身 cordis.patch.yml → $DSH_HOME/cordis.patch.yml → 各 --patch overlay。→ dsh-ssh 若用 patch 改行必须整行重写; preset 方案是整文件所有权, 无此问题。
4. **git 安装要授权**: pnpm≥10 拒绝运行 git 依赖的 prepare 脚本; 需在 profile 的 pnpm-workspace.yaml 加 allowBuilds 条目(作者提供自包含 prepare 脚本)。免授权路线: 发布 npm 或交付 tarball(pnpm pack)。
5. **preset 发布**: 用户 preset 根为 $DSH_HOME/.agent-presets/; 用官方 authoring API ctx.agentPresets.copy('standard','standard-ssh',显示名) 复制, 然后编辑 agent.cordis.yml 替换 tool-bash/tool-fs/tool-fs-search 三行为我们包里的实现; preset.yml 提供显示名/描述/顺序。复制即加载可用(「Copy is the only authoring write」)。
6. **peer 依赖**: 参考包声明 @deepseek-ai/cordis 及所需 dsh 包为 peerDependencies, 经 $DSH_HOME/profiles/node_modules 回退解析; schemastery 放 dependencies。
7. **升级自适应**: core 零改动; 唯一维护点 = 上游 standard preset 更新后重新 copy + 三行替换(用 diff 脚本化); 当前版本 0.1.0-rc.6, 公共契约(tools.register/settings/slots/Typert/preset 加载器)均已核对存在。

## 四、DSH 官方 agent 协作规范

**已发现**(GitHub deepseek-ai/deepseek-harness, 默认分支 master; 本地 checkout 是发布产物, 不含这些文件):

- **根 AGENTS.md**(完整内容已存 /tmp/dsh-docs/AGENTS.md): 核心信条「everything is a plugin」; 仓库布局 vendor/ + packages/(core/api/typert/llm/shell/subprocess/fs/bundle/preset/...); 关键约定: 注册是效果(ctx.effect/ctx.on, 返回 disposer); **插件而非改循环**(新行为走文档化扩展点, 改 agent-loop 需更新 docs/architecture.md); 能力接缝 = Service Definition/Provider/Consumer 三件套; 包命名/角色命名规范表; 非平凡变更必须附 Agent Note; Agent Notes 归档即冻结; Model Experience 文档规范; 测试/快照/覆盖率门槛; pre-release 阶段不保兼容(升级自适应对 dsh-ssh 反而友好)。
- **.agents/**(仓库内): notes/(Agent Notes 目录) + skills/(dsh-pre-push-checks、dsh-doc-standards、dsh-prose-standard 等)。
- **docs/**: AGENTS.md(文档规范)、architecture.md、capability-seams、cordis-primer、cookbook/(adding-a-package、adding-a-tool 等)、defensive-patterns、glossary、testing 等; website/ 是 VitePress 投影。
- 对 dsh-ssh 的意义: 这些是给 DSH 仓库贡献者的规范, dsh-ssh 作为外部插件**不强制**; 可借鉴其命名规范与接缝理念, 并注意 Agent Note「归档即冻结」文化与我们 notes/research/ 的定位不同。

## 五、对 dsh-ssh 的注意事项与开放问题

1. **占位目录必须真实存在**: workspaceRegistry.create() 会 fs.realpath 并拒绝不存在路径; 占位路径避免用符号链接(realpath 会把它规范成目标), 直接用 ~/.dsh/remote/<hostId>/<path> 普通目录。
2. **会话 cwd**: 由 API 网关从所选工作区 path 解析并写入不可变 SessionHeader; 远端工作区 = 占位目录绝对路径, sessionPersistence/workspaceRegistry 零改动(与可行性结论一致, 已复核)。
3. **同名工具注册**: standard-ssh 是独立 preset(每个 preset 独立 realm/scope), 与 standard 不会同时挂载, 无注册冲突; 但 preset 行要求服务行位于 isolate 组内(见 standard/agent.cordis.yml 注释), 工具行不需要。
4. **目录流程槽语义**: occupant 拥有从 open 到 onPicked(path) 的完整交互(含「新建目录」); busy 期间禁用提交; onCancel/onError 必须处理 —— 远端浏览组件按此契约实现。
5. **settings 两半**: 宿主持久化走 dsh-settings namespace API(update/replace/mutate + expectedRevision 乐观并发); 客户端表单走 settings.section 槽。SSH 口令/私钥等机密建议走 credentials seam 或 settings 的 role(secret)(describe 时 redactSecrets)。
6. **fs seam 明示支持远端后端**(displayPath 可为 remote URI、targetKey 不透明、resolve 可往返): 说明接口设计本就容纳远端, 但换提供方需改 host 组合 → 仍走工具层替换(结论一致)。
7. **glob/grep 对齐**: 远端重实现需对齐 rg 语义(忽略规则/二进制/超时), 超时由 @deepseek-ai/dsh-tool-call-timeout-policy 强制执行(见 filesystem 文档)。
8. **后台任务**: ctx.jobs.start 登记在宿主进程; 远端长任务无共享进程树 → 远端 nohup/tmux + 轮询取回, 或明确文档化限制。
9. **~/.ssh/config**: 官方无解析服务; 自实现解析或文档化限制(列入 M5)。
10. **开放问题**: ① tool-jobs 远端化深度(M5 定); ② 占位目录↔远端路径路由判定(占位前缀识别 + 避免误判本地真实路径); ③ 多主机切换时占位目录生命周期/清理; ④ read_image 走 SFTP 字节流与本地 read_image 的差异; ⑤ standard preset 更新 diff 脚本的存放与触发方式。

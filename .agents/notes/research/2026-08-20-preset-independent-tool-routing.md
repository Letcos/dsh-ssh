# preset 无关的 SSH 工具路由方案可行性调研

> 纯调研, 不改任何代码/配置。结论均注明源码出处(本地 DSH checkout = <dsh-checkout>; 下简称「core」, 版本 0.1.0-rc.6, cordis 4.0.1)。
> 日期: 2026-08-19(子代理调研, 主 Agent 待复核)。

## 0. 一句话结论

**profile/home/--patch 层根本无法触达 preset 里的工具行; 而官方七工具的注册点又在 preset(agent 平面)而非 host 平面; 因此「全 preset 通吃」的可行路线只有两条: (a) 在每个 agent 自身 scope 上经 `agent/created` 钩子注册同名路由工具(遮蔽 preset 的官方工具, 本地路径委托 host 全局官方实现)——这是真正 preset 无关的方案; 或 (b) 动态生成 preset 变体(受 `copy` 无 write 语义限制, 需直接落盘)。「服务层替换」与「profile patch 换 name」两条路经源码证伪。**

---

## 1. 六问逐条

### Q1 cordis patch 的 id 级覆盖能力

**结论: patch 条目字段 = id/insert/name/config/group/disabled/inject/intercept/isolate + 任意键; 但 `name` 是「守卫」不是「可覆盖字段」——patch 不能把某行的实现类换成另一个模块。**

- patch 条目字段: `@deepseek-ai/cordis-plugin-include/src/index.ts` L145-156(`PatchOptions`: id/insert/name/config/group/disabled/inject/intercept/isolate + `[key:string]: any`)。
- **name 是守卫**: 同文件 L78 `const { id, insert, name, ...overrides } = patch` 把 name 单独拆出; L116-119 `if (name && name !== target.name) { warn('patch: name mismatch ... skipping'); continue }`。即 patch 里写 name 必须与目标行当前 name 一致, 否则整条跳过; name 不进 overrides, 不会被写入目标。
- 同一语义的 vendored 副本: `dsh-app-boot/lib/index.js` L57-106(`applyEntryPatches`), 尤其 L69 解构与 L96-99 的 name 守卫。
- config 合并语义: **整行替换, 无深合并**。`dsh-app-boot/README.zh.md` L60 "用户 patch 会替换匹配到的整个配置"; `applyEntryPatches` L100-103 `target[key] = value`(整体赋值)。所以 profile 覆盖某行 config 时必须重述所有想保留的字段(`dsh-base/README.zh.md` L21)。
- disabled 语义: `cordis-plugin-loader/src/config/entry.ts` L19(`disabled?: boolean|null`)、L84-98(disabled 沿父链传播, group 恒 enabled)、L104-108(支持 `!!js` 表达式求值)。
- id 级定位: `applyEntryPatches` L66-75 建 `entryMap`(含 group 嵌套); insert 可定向到某个 group 的 config 数组(L80-102)。

**含义**: 七工具的实现类(name)不能通过 profile/home patch 替换; 只能改 config / disabled / insert 新行。这是后面所有方案判断的基石。

### Q2 组合层叠顺序(以及 preset 层在哪)

**结论: 完整 host 栈 = bundle 层 → profile cordis.patch.yml → $DSH_HOME/cordis.patch.yml → --patch。preset 层(agent.cordis.yml)不在这条栈里, 它是每 preset 独立、无 patch 的 standing 子树。**

- 顺序出处: `core/lib/profile-boot-DG5t9aNs.js` L146-154(`allPatches` = `[bundlePatches, profile.patches, homePatches, overlays]`)、L156-198(`composeProfile` 用 `composeEntries([bundlePatches, profile.patches, homePatches, overlays])`)。
- 根配置是空列表: 同文件 L102-106(`PROFILE_ROOT_CONFIG` 内容为 `[]`, 全部由 patch 层叠加)。`composeEntries` 一次 `applyEntryPatches([], layers.flat())`: `dsh-app-boot/lib/index.js` L575-580。
- bundle 层 = `dsh.profile.bundles` 里每个包的 `cordis.patch.yml`(dsh-base 第一层): `dsh-app-boot/lib/index.js` L539-557(`loadProfile`)。
- profile 层: `$DSH_HOME/profiles/<name>/cordis.patch.yml`; home 层: `$DSH_HOME/cordis.patch.yml`, 后者优先级更高——`profile-boot-DG5t9aNs.js` L89-96(`homePatchPath`)、L159-160 注释 "machine-local ... outranks the per-profile layer"。
- --patch: L169(`patchFiles.flatMap(loadOverlayPatches)`)。
- **preset 层在哪**: 不在上述任何一层。preset 的 `agent.cordis.yml` 由 `dsh-agent-presets` 的 `mountPreset` 作为独立 `PresetTree extends Include` 挂载, config 只有 `{ path }`、**没有任何 patches**——`dsh-agent-presets/lib/index.js` L707-735(mountPreset, L709 `const config = { path: pathToFileURL(preset.path).href }`), L469-524(PresetTree, 无 patches); standing 挂载见 L1130-1159(`ensureStanding`)。
- 所以 **profile/home patch 只作用于 host 平面 root 树, 永远覆盖不到任意 preset 里的工具行**。这就是「profile patch 工具替换」方案不成立的直接原因。

### Q3 会话创建流程的 preset 解析 + 有无会话级 patch/overlay 注入点

**结论: preset 在会话创建时经 agent 工厂 `setup(agentCtx)` → `agentPresets.mount(agentCtx, id)` 物化(standing 子树 + scope 认父); 没有会话级 patch/overlay 注入点; 可用注入点只有 `setup(agentCtx)`(受信组合代码, 由 apiproxy 持有)、`agent/created`、`agent/session-start` 事件。**

- preset id 解析: `dsh-agent-presets/lib/index.js` L762-768(`resolveSessionPreset`: header.agentPreset 或最后一个 `agent-preset/selected` 事件)。
- 创建流程: `dsh-host-apiproxy/lib/index.js` L1783-1797(`composeAgent`: 会话建立前 `presets.resolve(presetId)`, 返回 `setup(agentCtx)` 回调), L1801-1807(agent factory 的 setup = `composeAgent(resolveSessionPreset(...))`)。
- 物化: `dsh-agent-presets/lib/index.js` L954-961(`AgentPresets.mount`: `ensureStanding` + `bindScopeParent(agentKey, standing.key)`)。
- **工具如何注册**: 七工具由 preset 的 `tool-bash`/`tool-fs`/`tool-fs-search` 行注册——`core/config/agent-presets/standard/agent.cordis.yml` L44-62。**dsh-base host 层也有同 id 行**(全局层, rosterless 回退)——`dsh-base/cordis.patch.yml` L210-230。作用域语义: "Scoped registrations shadow globals"——`dsh-tools/lib/index.js` L2550; 遮蔽解析 L2843-2869(`view`), 查找 L2879-2881(`get`, 不带 scope 即全局视图)。
- 子 agent 继承: `dsh-subagent/lib/index.js` L532/L571(`composedPreset` + `composeFrom`)。
- 注入点(仅这些): `dsh-agent/README.zh.md` L15/L51——`setup(agentCtx)` 是发布前唯一可异步组合的点(由会话创建代码持有, 第三方插件无法插入); `agent/created` 在 setup 之后、driver 启动之前同步发出; `agent/session-start` 是第一个不可 veto 的启动通知。

### Q4 官方七工具的服务调用面

**结论: 三工具完全经 `ctx.shell` / `ctx.fs` / `ctx.subprocess`, 无任何绕过服务直调 node API 的路径。注意 glob/grep 走的是 `ctx.subprocess`(spawn 打包的本地 `@vscode/ripgrep`), 而非 ctx.fs/ctx.shell。**

- **tool-bash**: inject `["tools","shell","systemPrompt","shellEnv"]`(`dsh-tool-bash/lib/index.js` L111-116); 执行 `ctx.shell.run(ctx.shell.resolve(...))` L429、后台 `ctx.shell.start` L419、`ctx.shellEnv.collect` L395; 其余 `ctx.get("jobs"/"approval"/"sandboxPolicy")`。仅 import `node:path`(L2, 纯字符串路径), 无 node:fs/child_process。
- **tool-fs**: inject `["tools","fs","systemPrompt"]`(`dsh-tool-fs/lib/index.js` L1173-1177); read→`ctx.fs.resolve/stat/streamText/readText`(L274-275、L419); write→`ctx.fs.resolve/writeText`(L656、L660); edit→`ctx.fs.resolve/editText`(L805、L809); read_image→`ctx.fs.resolve/stat/readBytes`(L1015-1017)+ `attachments.saveImage`(L1020)。仅 import `node:path`(L6)与 `diff`(L5), 无 node:fs。
- **tool-fs-search**: 头注释明确 "Both tools execute as ordinary foreground spawns through `ctx.subprocess` — never `ctx.shell`"(L8-27); `runRipgrep` L159-200 `ctx.subprocess.spawn({ argv: [rgPath, "--no-config", ...argv], cwd, stdio, graceMs, signal })`; rg 二进制路径 `import("@vscode/ripgrep").then(m => m.rgPath)` L120-123; spill `ctx.spillStore.saveText` L279-306; workdir = `exec.agent.session.header.cwd ?? process.cwd()` L161(仅路径回退, 非执行 API)。仅 import `node:path` + `@vscode/ripgrep` + `dsh-output-retention`, 无 node:fs/child_process。

### Q5 服务替换可行性

**结论: 理论上「可以」(host 平面 disable 官方 provider 行 + insert 自己的 provider 行, 提供同名服务), 但既不能经 patch 换 name 实现、也不满足「本地行为完全不变」、且盖不住 glob/grep。与既有笔记「透明替换 host 单例已排除」一致。**

- 服务注册: `FileSystem extends Service → super(ctx,"fs")`(`dsh-fs/lib/index.js` L58-60); shell/subprocess 同理(`dsh-shell`/`dsh-subprocess`)。provider = `dsh-fs-local`/`dsh-fs-sandbox`、`dsh-bash-local`/`dsh-bash-sandbox`、`dsh-subprocess-local`。重复注册同服务名抛错: `dsh-subprocess/lib/index.js` L52-55 "loading a second throws ... duplicate-service behavior"。
- patch 不能换 name(Q1), 故「同 id 不同 name」替换服务实现不成立; 只能 disable + insert(不同 id), 这是 `dsh-base/README.zh.md` L7 描述的 bash/pwsh 完整配方先例。
- 副作用(致命): 这些服务是 host 全局单例, 被大量非工具消费者使用——`ctx.fs` 被 settings-file/session-persistence-jsonl/attachment-local/workspace/skill-filesystem/spill/observation-policy 等消费; `ctx.subprocess` 被 bash/pwsh/search/MCP/code-runtime 等消费; 全局替换必然改变这些路径, 违反硬约束「本地工作区行为完全不变」。
- 且 glob/grep 走 `ctx.subprocess` + 打包的本地 `@vscode/ripgrep` 二进制(Q4), subprocess 层替换无法干净远端化(本地 rg 路径/语义 vs 远端 find/grep), 仍需工具层重实现。

### Q6 agentPresets API 全貌

**结论: 有 list/read/copy/remove/resolve/mount/recompose/standingKeyFor/composeFrom/composedPreset/serviceFor + defaultId/roots/authorable; 无 write、无 watch。copy 是唯一创作写入(整目录复制, 不接收组合文本)。发现 unmemoized(每次重读磁盘); 组合文件挂载时读盘, standing mount 按文件 stamp(mtimeMs+size) 缓存。**

- API 全貌: `dsh-agent-presets/lib/types/index.d.ts` L55-289(class AgentPresets)。`copy(from,id,name?)` L228、`read(id)` L212、`remove(id)` L234、`list()` L104、`resolve()` L115、`mount()` L159、`recompose()` L274、`standingKeyFor()` L286、`composeFrom()` L186、`composedPreset()` L196、`serviceFor()` L250、`defaultId` L99。
- copy 实现: `dsh-agent-presets/lib/index.js` L1045-1050(`copy` → `copyComposition` 整目录 cp), L384-414(`copyComposition`, 用 `node:fs/promises cp` 复制整个目录, 重写元数据)。**没有把组合文本写盘的 API**。
- 发现 unmemoized: `list()`/`resolve()` 每次重读根目录——`lib/index.js` L887-889、types/index.d.ts L51-53。
- 缓存: standing mount 按 `compositionStamp`(`stat().mtimeMs+size`) 缓存, 文件变了为后续会话起新 generation——`lib/index.js` L1130-1159(`ensureStanding`)、L1162-1176(`compositionStamp`/`sameStamp`)。
- 含义: 「动态生成 preset 变体」只能 `copy` 整目录后**直接写** `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml`(绕过 API, node:fs), 且需自行处理与用户手改预设的同步/漂移。

---

## 2. 方案对比矩阵

| 维度 | ① 固定 preset(现状) | ② 动态 preset 变体 | ③ profile/home patch 工具替换 | ④ 服务层替换 | ⑤ 会话创建钩子(agent.ctx.tools.register) |
|---|---|---|---|---|---|
| 可行性(源码证据) | ✅ 已实装(M3/M4) | ⚠️ 部分可行: copy 整目录 + 直接落盘改 name(无 write API, Q6) | ❌ patch 触不到 preset 树(Q2)+ name 是守卫(Q1) | ⚠️ 技术上可(disable+insert, dsh-base L7 先例), 但副作用致命(Q5) | ✅ 有证据: scoped shadows global + agent/created 事件(Q3, dsh-tools L2550) |
| 覆盖范围 | 仅 standard-ssh preset | 需为每个用户 preset 生成+维护变体 | 无(preset 行覆盖不到) | 全 host(过宽, 波及所有消费者) | **全 preset 通吃**(按 agent scope 遮蔽) |
| 对「本地行为完全不变」 | ✅ 本地委托 host 全局官方实现(逐字节) | ✅(变体仅改 tool 行 name) | — | ❌ 全局服务替换改变所有本地路径 | ✅ 仅远端 cwd 会话注册路由工具, 本地零改动 |
| 维护成本 | 低(现状); 上游 standard 更新需重跑 build-preset | 高(检测/同步/漂移/清理变体) | — | 极高(重实现 fs/shell/subprocess 全 API) | 中(一个 host 插件 + agent/created 监听; 工具契约仍需逐字对齐官方) |
| 风险 | 用户须手动选 standard-ssh | 变体漂移、用户手改冲突 | — | 破坏持久化/settings/attachment 等; glob/grep 盖不住 | 需验证: agent/created 时机、子 agent、code-mode/minimal preset 的目录影响 |

## 3. 推荐结论(组合方案)

1. **主路线 = 方案⑤(会话创建钩子)**: host 平面插件监听 `agent/created`, 仅当 `agent.session.header.cwd` 为远端占位路径(`~/.dsh/remote/<hostId>/...`)时, 经 `agent.ctx.tools.register(...)` 注册七个同名路由工具(遮蔽 preset 官方工具; 本地路径 `ctx.tools.get(name)` 无 scope 查找 → 委托 host 全局官方实现, 逐字节一致)。这是唯一真正 preset 无关、且不破坏本地行为的路线。
2. **保留 standard-ssh preset 作为显式可选(回退/诊断)**（后续已改为 agent/created 钩子方案，preset 已移除）: 方案① 已实装, 作为「显式选 preset 即启用」的确定性路径继续保留, 与 ⑤ 不冲突。
3. **不采纳 ③/④**: ③ 被 Q1/Q2 证伪; ④ 被 Q5 证伪(硬约束 + 副作用)。

### 若采纳方案⑤, 最小验证步骤

1. **静态**: 在隔离 profile(dsh-ssh-dev)写一个最小 host 插件: `ctx.on('agent/created', ({agent}) => { if (isRemoteCwd(agent.session.header.cwd)) agent.ctx.tools.register(routeTool('bash',...)) })`; `dsh --profile dsh-ssh-dev --dump-config` 确认插件行进入 host 组合。
2. **时序**: 验证 `agent/created` 在首次工具调用前触发(源码已证: createAgent 在 announce 后才 start driver; 可用日志/断点确认)。
3. **遮蔽**: 新建会话选 `standard`(非 standard-ssh), cwd 指向远端占位路径; 调用 bash → 断言走路由实现(非官方); 本地会话选 standard → 断言 `agent/created` 未注册、行为与未装插件一致。
4. **委托**: 本地路径调用 → 断言 `ctx.tools.get(name)`(无 scope)命中官方全局实现, 结果与官方逐字节一致。
5. **子 agent**: fork/subagent 子会话同样经 `agent/created` 注册路由工具, 远端/本地路由一致。
6. **code/minimal preset**: 确认 code-mode 会话目录不被破坏(run_code 保留), minimal 会话在远端 cwd 下获得七工具(或按产品决策收窄为「仅遮蔽已存在的工具名」)。

## 4. 关键出处速查(源码行号)

- patch 语义: `cordis-plugin-include/src/index.ts` L58-128、L145-156; vendored `dsh-app-boot/lib/index.js` L57-106。
- 层叠: `core/lib/profile-boot-DG5t9aNs.js` L102-106、L146-198; `dsh-app-boot/lib/index.js` L539-557、L575-580。
- preset 挂载(无 patch): `dsh-agent-presets/lib/index.js` L707-735、L1130-1159。
- 会话创建/preset 解析: `dsh-host-apiproxy/lib/index.js` L1783-1807; `dsh-agent-presets/lib/index.js` L762-768、L954-961。
- 七工具服务面: `dsh-tool-bash/lib/index.js` L111-116/L429; `dsh-tool-fs/lib/index.js` L1173-1177/L274/L419/L656/L660/L805/L809/L1015-1020; `dsh-tool-fs-search/lib/index.js` L8-27/L120-123/L159-200。
- 服务注册/重复: `dsh-fs/lib/index.js` L58-60; `dsh-subprocess/lib/index.js` L52-55; `dsh-base/README.zh.md` L7。
- tools 遮蔽语义: `dsh-tools/lib/index.js` L2550、L2843-2881。
- standard preset 工具行: `core/config/agent-presets/standard/agent.cordis.yml` L44-62。
- agentPresets API: `dsh-agent-presets/lib/types/index.d.ts` L55-289。

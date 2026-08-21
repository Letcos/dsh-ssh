# M4 远端工作区流程调研(目录浏览槽 + 占位目录 + 客户端挂载)

> M4 前置调研(2026-08, 子代理)。结论全部来自本地源码, 出处 = 文件路径:行。
> 源码根: <dsh-checkout>/node_modules/@deepseek-ai/ 简写为 [D]。
> 验证状态: 源码核对 ✅; 未在真实 GUI 运行, 运行时行为标注"待真机"。

## 1. directoryFlow 槽完整契约

**槽声明**(@deepseek-ai/dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts):
- 两个洞, 均 kind 'single' + scope 'root': `conversation.hero.workspace.directoryFlow`(L48-52)与 `sidebar.workspaces.directoryFlow`(L54-58); owner 均为 DirectoryFlowOwnerProps。
- DirectoryFlowOwnerProps(L33-44):
  - `open: boolean`(L35): 交互请求中; 翻回 false = 撤回请求。
  - `busy: boolean`(L37): owner 正在采纳路径(createWorkspace 进行中); occupant 须禁用提交。
  - `onPicked: (path: string) => void`(L39): 用户选中目录, **path 为"absolute host path"= 本地 DSH 机器上的绝对路径**(非远端路径); owner 负责采纳。
  - `onCancel: () => void`(L41): 用户取消, owner 关闭流程。
  - `onError: (message: string) => void`(L43): 交互自身失败(chooser 缺失/列目录被拒), owner 弹错误面 + "Choose again"。
- 占用语义(L1-14 头注释): "the occupant owns everything between open and the picked path, **including creating a new directory to hand back**"; 每个 open 只能报告一个结果。
- occupant 注入钩子: DirectoryPickingInjected = { hooks: { directoryFlow: HostObservable<boolean> } }(L70-76); 洞空时 owner 侧 useDirectoryFlow(occupied) 反应式隐藏 "Add workspace…" 入口(ui-workspace client.js:829, 1930)。

**owner 拿到路径后的采纳链(真实调用链, 已逐跳核对)**:
1. WorkspacePickFlow.onPicked → adoptDirectory(path) → createWorkspace({ path })(ui-workspace/lib/client.js:852-857)。
2. 注入的 createWorkspace = `ctx.workspaces.create(input)`(同文件 L2391/2395)。
3. 客户端 runtime: Workspace.materialize() → `this.api.workspace.create({ path })`(dsh-client-runtime/lib/client.js:9422); `connection.api` 即 host `/api` 的 typed RPC 客户端(同文件 L10477-10480; api 端点在 dsh-host-apiproxy/lib/types/api/workspace.schema.js:26-28, 请求体仅 `{ path: string }`)。
4. host 侧: ensureWorkspace(path) → resolveByPath 未命中则 `ctx.workspaceRegistry.create(path)`(dsh-host-apiproxy/lib/types/api-proxy.js:1445-1452)。
5. registry.create: `realpathNormalize(path)`(不存在→ENOENT 拒绝)+ 必须是目录, 然后落库(dsh-workspace/lib/index.js:341-344; realpath 实现 L25-26)。

**occupant 注册模式(官方两个参照实现, 直接照抄)**:
- 原生选择器(dsh-client-ui-directory-picker-native/lib/client.js): 无渲染组件, `useEffect` 监听 open 上升沿 → pick() → path===null ? onCancel() : onPicked(path); 异常 → onError(message)(L23-50)。**注册**: `ctx.slots.inject(hole1, () => ctx.slots.inject(hole2, function* () { yield slots.register({name: hole1, inject}, Comp); yield slots.register({name: hole2, inject}, Comp); }))`(L63-74)。
- 应用内对话框(dsh-client-ui-directory-picker-browse/lib/client.js): DirectoryBrowser 消费 open/busy + 注入的 listDirectory/createDirectory; 确认→onOpen=onPicked, 关闭→onClose=onCancel(L952-962); 注册同上嵌套模式(L1026-1035)。
- 本地目录数据走 `ctx.workspaces.pickDirectory/listDirectory/createDirectory` → api.host.* → host `ctx.directoryPicker`(browse/native 能力)(client-runtime client.js:9956-9985)——**这是本地选择器, 我们的远端浏览不复用它, 改走自己的 ctx.remote.ssh.***。

**对 M4 建议**: 我们的 occupant = 一个远端目录浏览对话框组件, 注册进两个洞; 组件 props = { open, busy, onPicked, onCancel, onError } + inject 注入的 { listDir, stat, resolveHome, createPlaceholder, mkdirs }(包装 ctx.remote.ssh.*); 每次 open 用 useRef 防重入; busy 期间禁用确认。

## 2. 远端目录浏览的宿主侧支撑

现状注册模式(packages/dsh-ssh/src/remote.js):
- SshRemoteService extends Service(ctx, 'ssh'), 构造里 `bindTypertRemote(this, 'ssh')`(L19-26); 方法即端点(testConnection/listHosts/saveHost/deleteHost)。
- registerRemote() 在 `ctx.inject(['typert','settings'])` 内 `scope.typert.register(HOST_TYPERT_CONTRIBUTION)` + assertContributionShape 兜底(L155-176); gateway 按严格描述符 claim `/api/ssh/<method>` 并 `ctx.get('ssh').<method>()` 分发(typert-contribution.js 头注释 L8-11)。
- 描述符 = 纯数据模块 lib/typert-contribution.js: `descriptor(client, method, params, resultType)` 工厂(L49-64), host 侧 src-json codec、client 侧 strict passthrough codec(L37-46); HOST_TYPERT_CONTRIBUTION(L87-98) / CLIENT_TYPERT_REMOTE(L101-109)。

**加端点的结论(平滑, 无需新机制)**: ① SshRemoteService 加方法 listDir(hostId, path)/stat(hostId, path)/resolveHome(hostId, path)/mkdirs(hostId, path), 内部走 sshPool 的 SFTP, 返回纯 JSON 安全值(DirEntry {name,type,size?,mtime?}); ② typert-contribution.js 与 client.js 内联描述符各加 3-4 条(参数名数组即可, 走同一个 descriptor 工厂); ③ assertContributionShape 自动校验(端点不重复、codec 规则); ④ 客户端已有 `ctx.remote.$mount(CLIENT_TYPERT_REMOTE)`(client.js:759), 挂载后 `ctx.remote.ssh.listDir` 自动可用。无需碰 gateway/core。

## 3. 占位目录创建: 谁建、走哪个 API

**约束(已确认)**: workspaceRegistry.create 先 fs.realpath 再判目录, 不存在/非目录直接拒绝(dsh-workspace/lib/index.js:25-26, 341-344); ensureWorkspace/resolveByPath 同样 realpath(L452-453)。→ 占位目录必须是**已真实存在的本地目录**, 且勿用符号链接(realpath 会解析掉, 记录里存的 path 是 canonical 结果)。
**workspace id = randomUUID, 与路径无关**(dsh-workspace/lib/index.js:461) → 占位↔远端映射必须由 dsh-ssh 自己维护(§5.3 mapLocalToRemote 可逆编码)。

**职责划分(最小侵入, 与槽契约完全吻合)**:
- 槽契约明说 occupant 负责 "creating a new directory to hand back"(见 §1); 而 occupant 跑在浏览器, 无 fs → **宿主建目录**。
- 方案: SshRemoteService 增加 `createPlaceholder(hostId, remotePath)` → 本地 mkdir -p `<dshHome>/remote/<hostId>/<encode(remotePath)>`(真实目录, 可逆编码如 base64url) → 返回 { localPath }; 客户端 occupant 选定远端目录后调它, 拿到 localPath 再 `onPicked(localPath)`。
- owner 的既有采纳链(`ctx.workspaces.create({path})` → api.workspace.create → registry.create)完全不动 → **sessions/workspaceRegistry/apiProxy 零改动**(D6 已验证事实)。
- 占位根目录别硬编码 ~/.dsh: 用 @deepseek-ai/dsh-home-paths 的 `resolveDshHome()`(L73-76, 尊重 DSH_HOME 覆盖)/ `dshHomePath(...)`(L82-84)。
- 占位目录内不落业务数据, 只放映射元数据(§4.3 / 开放问题 8)。

## 4. 客户端 remote 自动挂载 —— 手动 $mount 会冲突吗?

**结论: 不冲突**。
- 自动挂载只存在于**核心包**: dsh-api-remotes(客户端包)把核心 host 包生成的 TYPERT_REMOTE 描述符(goal → remote.goals、messageFeedback、pluginInventory 等)在 boot 时逐个 `ctx.remote.$mount(contribution)`(dsh-api-remotes/lib/client.js:~5921)。所以 dsh-client-ui-goal 只声明 inject "remote.goals" 即可用(client.js:372-373), 它自己从不 $mount。
- 第三方 bundle 的 client half 不在 dsh-api-remotes 装配里 → **必须自己 $mount**(我们 client.js:759 已这么做, M2b 模式)。
- $mount 语义: ① fiber 作用域, 插件卸载自动 dispose(api-gateway/lib/client.js:35-45); ② validateContribution 对 namespace+method 重复会**抛错**(L111-137)——即若真有自动挂载撞车, 是大声失败而非静默冲突; ③ 命名空间服务 `remote.<ns>` 注册在 ownerCtx(api-gateway client.js:188-212)。'ssh' 与核心命名空间无交集。
- 细节: $mount 是异步的, 我们目前 fire-and-forget(.catch 记日志); UI 交互发生在 apply 之后, `ctx.remote.ssh.*` 届时已就绪(M2b 已用此模式, 待真机)。

## 5. 多主机切换与占位目录生命周期

**宿主侧事件钩子(已确认可用)**: storage-domain 每次写后 emit `ctx.emit('domain/changed', change)`(dsh-storage-domain/lib/index.js:203-207); workspace 注册表的一切变更都流经它(api-proxy.js:3287-3305 就是订阅它组 host/workspace-changed 帧)。
- put 事件带 value: { domain:'workspace', table:'workspaces', key:<id>, operation:'put', value:{path,title,...} }(dsh-storage-domain/lib/index.js:277-285; workspace 记录 shape 见 dsh-workspace/lib/index.js:463-469)。
- delete 事件**不带旧值**: { operation:'deleted', key:<id> }(L253-266)→ 必须靠 put 时记录 id→path。

**最小方案(推荐)**: dsh-ssh 宿主侧订阅 `ctx.on('domain/changed')`:
1. operation put 且 value.path 落在 `<dshHome>/remote/` 下 → 记录 id→path(内存 Map + 可落 settings/映射文件)。
2. operation deleted → 按 id 查记录, 删除对应占位目录(只删自己根目录下, rm -rf 该占位目录即可, 占位目录内无业务数据)。
- 覆盖所有删除入口(UI 删工作区 / api.workspace.delete / 任何未来路径), 因为都走 registry。
- **设置页删主机(deleteHost)不删占位目录**(src/remote.js:134-147 现状不动): 删主机时可能还有活工作区指向占位目录, 删了会破坏会话 cwd; 占位目录是空目录, 留到对应 workspace 删除时再清, 文档化即可。
- 备选: 惰性 GC(打开某主机的目录选择器前扫描 remote/<hostId>/ 删掉不在 ctx.workspaceRegistry.list() 中的占位), 免事件接线; 两案可都做, 事件钩子为主。

## M4 实现任务书要点草案(≤10 行)

1. host: SshRemoteService 增 listDir/stat/resolveHome/mkdirs + createPlaceholder(用 dsh-home-paths 定位根, 可逆编码, 真实目录非符号链接); typert-contribution.js 增描述符(两端)+ 单测。
2. host: 订阅 domain/changed, put 记录 id→path、deleted 清占位目录; 单测(建/删工作区 → 占位目录随动)。
3. client: 新 occupant 组件(远端目录对话框, 参照 directory-picker-browse 的嵌套 slots.inject 注册进两洞), props 用 DirectoryFlowOwnerProps + inject 的 ctx.remote.ssh 包装。
4. client: 确认 → ssh.createPlaceholder → onPicked(localPath); busy 禁用提交; onCancel/onError 必处理; 支持"远端新建目录"(mkdirs)。
5. 验证: 单测全过 + dump-config/静态契约检查; 真机 UI(选远端目录→建工作区→七工具跑在远端)待发布阶段 web 重建后验收。
## 6. M4 实现结果(2026-08, 子代理; 单测+静态契约验证 ✅, 真机 UI 待发布阶段)

**做了什么(全部按 §1-§5 契约执行, 零 core 改动)**:
- 宿主 packages/dsh-ssh/src/remote.js: SshRemoteService 增 4 端点(均走既有 SshError 包装):
  - listRemoteDir(hostId, path): SFTP readdir → [{name,type,size?,mtime?}], 排序目录在前+名称字典序。
  - statRemote(hostId, path): 直接读 SftpWrapper 的原始 handle(sftp.sftp.stat)取 mtime —— **踩坑: SftpWrapper.stat 丢弃 mtime, 而 ssh-core.js 是 M3c 划界文件不能改, 故在 remote.js 内绕开 wrapper.stat**; ENOENT → null(JSON 安全, 不用 undefined)。
  - resolveRemoteHome(hostId): exec("echo $HOME"), 非绝对路径结果拒收。
  - createPlaceholder(hostId, remotePath): 校验 hostId 在 dsh-ssh-hosts dict 中存在(readState().hosts) → 复用 src/router.js 的 mapRemoteToLocal 编码(根 = DSH_SSH_REMOTE_ROOT > $DSH_HOME/remote > ~/.dsh/remote) → fs.mkdir({recursive:true}) 真实目录 → {localPath, hostId, remotePath}; 幂等。
  - 连接类端点统一 _acquireStored(hostId): 走 resolveStored(未脱敏 settings 值)拿配置再 sshPool.acquire, 未配置 → SshError(stage resolve-host)。
  - 新文件 packages/dsh-ssh/src/placeholder.js: 纯函数 createPlaceholderDir({hostId, remotePath, env, fsImpl}), fs/env 可注入(单测 mock), 校验+编码+mkdir 分离。
- lib/typert-contribution.js + client.js 内联描述符: 各加 4 条(listRemoteDir/statRemote/resolveRemoteHome/createPlaceholder), 走同一个 descriptor 工厂, host src-json / client strict passthrough; assertContributionShape 自动校验(端点不重复)。client-selfcheck 的"内联↔lib 逐字钉死"循环自动覆盖新描述符。
- 客户端 client.js: 新 occupant RemoteDirFlow(纯 React + primitives), 嵌套 slots.inject generator 注册进两洞(照抄 directory-picker-browse L1026-1035); 交互流 = 选主机(listHosts) → 目录浏览(listRemoteDir 进入/返回/家目录) → 使用此目录(createPlaceholder → onPicked(localPath)); onCancel/onError 完整处理(open 上升沿 generation+reported 双守卫, 每 open 恰一结果; busy/adopting 禁用提交与关闭); 浏览/占位失败留对话框内可重试, listHosts 失败(含 remote 未挂载) → onError; 文案进新 locale ns workspace.ssh(zh/en)。remoteCall 守卫: $mount 是异步的, ctx.remote.ssh 未就绪时拒绝成 Promise 而非同步 throw(参考调研 §4)。

**验证结果**(2026-08):
- node --check 全部新改文件 ✅。
- 定向测试 44 全过: m4-placeholder.test.js(编码复用/幂等/mock fs/DSH_HOME 尊重/真实目录落地 tmp 隔离) + remote.test.js 新 5 用例(mock sftp/exec/settings) + typert-contribution.test.js(8 端点断言) + router.test.js。
- 全量 143 中 141 过; 2 失败均在 test/ssh-core.test.js(M3c 中间态, 已确认非本任务引入, 未动该文件)。
- node scripts/client-selfcheck.mjs(仓库根跑) ✅。
- dsh --profile dsh-ssh-dev --dump-config exit 0, dsh-ssh 插件行在组合中 ✅。

**踩坑/注意**:
- macOS /var → /private 符号链接: 占位"真实目录非符号链接"断言须与 canonical 逻辑路径比较(realpath(tmp)/remote/h1/enc), 直接 realpath(localPath)===localPath 会误报。
- Typert 端点参数是位置参数(wire 字段序 = 方法签名序, 参考 saveHost(id,patch,revision)); 新端点签名必须 (hostId, path) 顺序。
- resolveStored(settings 未脱敏) 与 settingsApi(读 dsh-ssh-hosts dict)是两条线: 连接类走前者, createPlaceholder 校验走后者 readState()。
- 按 §5 建议的 domain/changed 订阅(占位目录随 workspace 删除清理)本轮未实现(任务书只含浏览+占位), 留 M4 后续/真机验收前补。

**待发布阶段真机验证清单**:
1. 设置页配好主机 → 侧边栏/空会话 "Add workspace…" 入口出现(两洞占用生效)。
2. 选主机 → 家目录列出 → 进入/返回/家目录导航正确; 中文/空格目录名正常。
3. 使用此目录 → 本地 ~/.dsh/remote/<hostId>/<enc> 真实目录出现 → 工作区创建成功(registry realpath 通过)。
4. busy 期间 "使用此目录" 禁用; 取消/错误路径不重复报告。
5. 远端占位工作区(经 agent/created 钩子路由), 七工具跑在远端(与 M3 联调)。

## 7. 单例槽优先级冲突修复(2026-08, 紧急修复子代理)

**根因**(源码核对 [D]=<dsh-checkout>/node_modules/@deepseek-ai/):
- directoryFlow 两洞都是 kind 'single' + scope 'root', 单例槽按优先级唯一: 同一 priority 重复注册直接抛错, 排序取最小优先级渲染([D]/dsh-client-ui-slots/lib/index.js:68-73 register 检查, :122 排序, :179-193 entriesOfSlot 取每格首个)。
- 官方 @deepseek-ai/dsh-client-ui-directory-picker-browse 已用默认 priority 0 注册 BrowseDirectoryFlow 进两洞(client.js:1026-1035, register 无 priority 选项 → 0)。
- 我们 M4 的 RemoteDirFlow 也以默认 priority 0 注册 → **client apply 抛 "already has a registration … register at a different priority to shadow it (lowest renders)" → 整个客户端模块失效 → 设置页连带不出现**(settings.section 本身无冲突, 是同一 apply 连带失败)。

**修复**(packages/dsh-ssh/client.js):
- 两洞注册改 priority: -1(低于官方 0, 排序取最低 → 我们的组合选择器胜出, 官方注册仍在 ledger 不冲突)。
- 组件换成 DirectoryFlowCombined(props): 单 Modal + 双页签「本地 | 远程主机」。
  - 本地页签 LocalFlowBody: 简化目录浏览器, 走官方客户端线缆服务 ctx.workspaces(新增 inject 'workspaces'; dsh-client-runtime/lib/client.js:9956-9988 确认方法名 listDirectory(path, signal)/createDirectory(path, name))。数据形状 = DirectoryListing{path,home,crumbs[],entries[](直接子目录、名称排序、含 hidden 标志),truncated}([D]/dsh-host-apiproxy/lib/types/api/host.d.ts:7-30) → 客户端无需再排序。交互: 进目录/上级(crumbs[-2])/家目录(listDirectory(undefined))/新建文件夹(createDirectory 后重列)/打开(当前层级, 即 onPicked(cwd)); busy/loading 禁提交; 空/错误态清晰(空目录框 + 错误条带重试); showHidden 简化(全部展示)。
  - 远程页签 RemoteFlowBody: 原 RemoteDirFlow 逻辑不变(选主机→浏览→createPlaceholder→onPicked(localPath)), 去掉自绘 Modal 改为体内操作条。
  - 结果守卫上移: DirectoryFlowCombined 持 generation/reported ref, open 上升沿在 render 期重置(先于子组件 effect, 保证初始请求拿到新 generation), 每 open 恰一结果; adoptingRef 供取消守卫。
- locale workspace.ssh 增补: title 改「选择工作区目录」, 新增 tab.local/tab.remote + local.*(zh/en); 远程页签文案沿用旧键。
- inject = ["slots","workspaces","locale","remote"](对齐官方 inject 顺序 slots/workspaces/locale 追加 remote)。

**验证**(2026-08, 全部通过):
- node --check packages/dsh-ssh/client.js ✅。
- node --test 'packages/dsh-ssh/test/*.test.js': 149/149 ✅(含此前 2 个 ssh-core 失败用例现已过, 与本次改动无关)。
- node packages/dsh-ssh/scripts/client-selfcheck.mjs ✅(同步钉死: inject 含 workspaces、两洞注册 priority:-1×2、ctx.workspaces.listDirectory/createDirectory、DirectoryFlowCombined/LocalFlowBody/RemoteFlowBody)。
- dsh --profile web --dump-config exit 0 ✅(web profile 未装本插件, 仅验证无破坏); dsh --profile dsh-ssh-dev --dump-config 中 @dsh-ssh/dsh-ssh 插件行在 ✅。
- 未启动服务; 未改 checkout(只读参考); 未动 ssh-core/tools/search 等其它文件。

**待真机验证清单**(GUI 重启后):
1. 设置页正常出现(连带失败解除); 侧边栏/空会话 "Add workspace…" 入口出现。
2. 本地页签: 家目录列出 → 进入/上级/家导航; 新建文件夹出现在列表; 打开 → 本地工作区创建成功(registry realpath 通过); busy 期间打开/取消禁用。
3. 远程页签: 选主机 → 家目录 → 浏览导航 → 使用此目录 → ~/.dsh/remote/<hostId>/<enc> 占位目录出现 → 工作区创建成功。
4. 页签切换不丢 open 守卫: 任一页签报告结果后对话框关闭, 不重复报告。
5. 远端占位工作区(经 agent/created 钩子路由), 七工具跑在远端(M3 联调)。

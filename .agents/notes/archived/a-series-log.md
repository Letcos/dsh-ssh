> **历史流水归档, 不再更新; 权威以 .agents/notes/implemented/ 为准。**
> **安全说明: 真实测试主机地址与主机名已脱敏为保留示例地址 203.0.113.10(RFC 5737 TEST-NET-3, 永不真实路由)与 <remote-host> 占位; 本机 node/dsh 安装绝对路径与私钥路径已泛化为 <dsh-checkout>/<home>/.ssh/id_ed25519 等占位符。**
> 脱敏修订(2026-08-20 首轮 + 2026-08-21 二轮补漏)：本文件历史流水曾残留本机绝对路径与真实主机名，已按安全红线批量泛化（archived 只读规则的安全例外，判例见 notes/AGENTS.md §5），仅泛化路径/主机名、不改写史实。
> 本文件为 requirements-and-design.md 附录 A/B 的原始流水账整体迁移(2025-08-16 ~ 2026-08-21); 每条 A 条目在 implemented/ 下有提炼结论。

---

## 附录 A: 本会话已复核的验证记录(2025-08-16)

> 另见 .agents/notes/research/extension-point-facts.md(主编一手核查)与 .agents/notes/research/dsh-official-reference.md(调研子代理, 含文档页索引与打包发布要点), 三方交叉验证。

| 事实 | 出处 |
|---|---|
| agentPresets.copy(from, id, name) 存在 | .../dsh-agent-presets/lib/index.js:1045; 另见 lib/types/index.d.ts L228(主编验证: copy(from, id, name?): Promise<void>) |
| preset 组合文件名 = agent.cordis.yml | 同上, lib/index.js:146(COMPOSITION_FILE) |
| settings.section 槽(kind single, scope root) | @deepseek-ai/dsh-client-ui-settings@lib/types/client/contract/slots.d.ts:67; 另 @deepseek-ai/dsh-settings/lib/index.js(主编验证) |
| directoryFlow 槽: sidebar.workspaces.directoryFlow + conversation.hero.workspace.directoryFlow(owner 契约 open/busy/onPicked/onCancel/onError) | @deepseek-ai/dsh-client-ui-workspace@lib/types/client/contract/slots.d.ts L48-62(主编验证) |
| Typert: TypertRemoteService / Remote / RemoteScope / bindTypertRemote / remoteMethods | dsh-typert-protocol/lib/index.js:53,140 |
| bundle 声明格式 "dsh": {"bundle": {...}} + "dsh": {"client": {...}} | 官方 /develop/basic/publish; 本仓库 packages/dsh-ssh/package.json |
| DSH CLI 版本/启动机制 | @deepseek-ai/dsh v0.1.0-rc.6(profile bundle 层 + --patch), lib/bin.js |
| 工具实现包含 read_image(read/write/edit/read_image 分别位于 :333/:604/:749/:952) | @deepseek-ai/dsh-tool-fs@lib/index.js(调研子代理核对) |
| 用户 profile 结构(settings.yaml / profiles/web + pnpm workspace) | ~/.dsh/ |
| standard preset 三行与包归属 | config/agent-presets/standard/agent.cordis.yml: tool-bash→dsh-tool-bash / tool-fs→dsh-tool-fs / tool-fs-search→dsh-tool-fs-search(主编验证) |
| 用户 preset 根 = $DSH_HOME/.agent-presets | dsh-agent-presets@lib/index.js:160(调研子代理核对) |
| workspaceRegistry.create realpath + 拒绝不存在路径 | @deepseek-ai/dsh-workspace(官方文档 + 源码, 调研子代理核对) |
| patch 层顺序与整 config 替换规则 | 官方 /develop/basic/publish |
| glob/grep 超时由 dsh-tool-call-timeout-policy 强制 | 官方 filesystem 文档(调研子代理) |

其余可行性结论(执行链、排除路线、坑位)来自上一轮调研, 以 .agents/notes/research/dsh-official-reference.md 为准; 动代码前先复核该笔记。

### A.1 M1 脚手架实测(M1 子代理, 2025-08-16)

> 本次仅做**脚手架产出 + 静态自检**; CLI 安装验证(plugin add/list)由主编代理带授权执行(沙箱限制, 子代理无法写 ~/.dsh), 其结果由主编代理回填。以下为子代理实测/源码核对的事实与推荐命令序列。

| 事实 | 出处/实测 |
|---|---|
| dsh CLI 实际位置与版本: <dsh-checkout>/bin/dsh(symlink → ../lib/node_modules/@deepseek-ai/dsh/lib/bin.js), dsh --version = 0.1.0-rc.6 | 实测 which dsh + dsh --version(2025-08-16) |
| dsh plugin 是必带 --profile <name> 的子命令; dsh plugin --help 缺 profile 时报 error: required option '--profile <name>' not specified; 完整语法 dsh plugin --profile <name> <pnpm 参数...>, 子命令参数原样转发给 profile 目录内的 pnpm | 实测 + dsh@lib/bin.js:96(parseDshArgs 的 plugin 分支) |
| 首次 dsh plugin --profile <name> add ... 会自动 initProfile: 写 package.json(name=dsh-profile-<name>, private, dependencies:{} + dsh.profile.bundles=[@deepseek-ai/dsh-base])、cordis.patch.yml(空模板)、pnpm-workspace.yaml(packages:[.], nodeLinker:hoisted, autoInstallPeers:false) | dsh-app-boot@lib/index.js:353 initProfile(源码核对) |
| 安装后 bundle 自动加入 profile 的 dsh.profile.bundles 列表: pnpm add 成功后 reconcilePlugins 读安装后的 package.json, 凡声明 dsh.bundle.patch 的依赖即追加进 bundles(按依赖顺序); 移除 bundle 声明或 remove 则移出 | dsh@lib/plugin-9h8shc4d.js:46-78 reconcilePlugins(源码核对) |
| add 的本地相对路径会被锚定到调用者 cwd 再交给 pnpm(add . 会自链 profile, 勿用); **推荐传绝对路径** <本仓库>/packages/dsh-ssh | dsh@lib/plugin-9h8shc4d.js:90-94 anchorPathSpec(源码核对) |
| pnpm 实际执行 pnpm add <绝对路径>(file: 依赖, 本地安装无需网络) | 同上 |
| dsh --profile <name> --dump-config 可不启动服务打印组合树(profile bundles 层 + profile patch + home patch + --patch overlay), 用于校验 bundle patch 是否进入组合 | dsh@lib/dump-config-D-jtgwY3.js runDumpConfig(源码核对); 命令实测可行(不写 ~/.dsh 亦可运行) |
| cordis.patch.yml 的 insert 行 {id, name, config}: loader 按 name 作为模块说明符 import(解析到包 main), config 传给插件; 空 config: {} 合法 | cordis-plugin-loader@lib/index.js:512(源码核对) |
| bundle 包模板已按官方契约落盘: packages/dsh-ssh/{package.json, cordis.patch.yml, index.js}(dsh.bundle.patch 声明、exports 映射、files 结构) | 本仓库 packages/dsh-ssh/package.json |

**静态自检结果(2025-08-16, 全部通过)**:
- node -e "JSON.parse(...)" 两个 package.json(根 + packages/dsh-ssh)JSON 合法;
- node --input-type=module -e "import('.../packages/dsh-ssh/index.js')" 成功, 导出 name='dsh-ssh' + apply=function; 调用 apply({}) 打印 [dsh-ssh] plugin loaded (M1 scaffold);
- 用 dsh 自带 js-yaml 解析 cordis.patch.yml, 结构为 [{insert:[{id:'dsh-ssh', name:'dsh-ssh', config:{}}]}], 与参考行格式一致。

**推荐安装与验证命令序列(供主编代理带授权执行)**:

```bash
# 1. 安装(M1 验收动作; 首次会自动初始化 dsh-ssh-dev profile, 内含 dsh-base 层)
dsh plugin --profile dsh-ssh-dev add <home>/Code/AI/dssh/packages/dsh-ssh

# 2. 确认 bundle 已进入 profile(pnpm 转发; 同等于在 profile 目录跑 pnpm list)
dsh plugin --profile dsh-ssh-dev list

# 3. 校验 bundle patch 进入组合树(不启动服务, 打印后退出; 应能看到 dsh-ssh insert 行)
dsh --profile dsh-ssh-dev --dump-config

# 4. 核对 profile manifest(bundles 数组应含 dsh-ssh)
cat ~/.dsh/profiles/dsh-ssh-dev/package.json
```

> 备选隔离验证(不碰 ~/.dsh): 设 DSH_HOME=/tmp/dsh-test-home 后执行上述命令, resolveDshHome 优先读环境变量(dsh-home-paths@lib/index.js:74), 与真实路径走同一代码分支。沙箱测试确认 /tmp 可写。

**踩坑记录**:
1. 沙箱(workspace-write)拒绝写 ~/.dsh(EPERM), 故子代理未执行 CLI 安装; 改用 DSH_HOME 指向 /tmp 可复现同分支(主编代理已确认 dsh-ssh-dev profile 已初始化)。
2. dsh plugin --help 不能单独用, 必须带 --profile(否则报错), 这是该子命令的设计(参数全转发给 pnpm)。
3. bundle 的 main 字段: 参考包用 lib/index.js, 本 M1 按任务书用根级 index.js(未引入构建工具); M2 起如引入构建产物再迁 lib/。


### A.2 M2a SSH 连接层 + settings 命名空间实测(M2a 子代理, 2025-08-16)

> 产出: packages/dsh-ssh/{src/ssh-core.js, src/settings.js, index.js, cordis.patch.yml(加 maxConnections: 4), test/ssh-core.test.js(9 用例), scripts/live-smoke.mjs}。验证: pnpm install ✓; node --test ✓ 9/9; live smoke ✓(exit 0); dsh --profile dsh-ssh-dev --dump-config ✓(dsh-ssh 段带 config.maxConnections: 4)。

| 事实 | 出处/实测 |
|---|---|
| ssh2 版本 1.17.0(deps: asn1, bcrypt-pbkdf); 导出 { Client, ... } | packages/dsh-ssh/node_modules/ssh2/package.json + lib/index.js |
| **settingsNamespace 强制 /^[a-z][a-z0-9-]*$/ —— 不允许点号**: settingsNamespace('dsh-ssh-hosts') 直接 TypeError → 必须用 kebab-case, 本项目注册 'dsh-ssh-hosts' | @deepseek-ai/dsh-settings/lib/index.js:88(实测抛错) |
| ctx.settings.register(ns, schema, {applies:'live', base:{hosts:[]}}) → SettingsScope(get/update/replace/watch); base 为组合默认层, 用户层覆盖; 注册随插件 fiber 卸载 | @deepseek-ai/dsh-settings/lib/types/index.d.ts:85-111,225(API 核对) |
| installSettingsSection(ctx, ns, schema, entry, hooks{setSource,...}) 存在(M2b 客户端设置区渲染时用) | @deepseek-ai/dsh-settings/lib/types/index.d.ts:341 |
| schemastery z: z.object/array/union/const/string/number/boolean/.default(v)/.required()/.role('secret')/.description()/.min()/.max() 全部可用; union 按成员顺序匹配(用 type 常量判别式) | @deepseek-ai/schemastery/lib/types/index.d.ts(API 核对 + 实测验证) |
| cordis Service: 子类 constructor 调 super(ctx, 'sshPool') 即注册 ctx.sshPool 并随 fiber 自动移除; 清理用 ctx.effect(() => () => ...) | @deepseek-ai/cordis/lib/types/service.d.ts:9-40(实测 apply OK, ctx.sshPool 可用) |
| **node --test 目录参数在 Node 23.11 不扫描目录**: node --test packages/dsh-ssh/test/ 把目录当文件执行报 MODULE_NOT_FOUND; 必须用 glob: node --test 'packages/dsh-ssh/test/*.test.js'(或无参自动发现) | 实测 node v23.11.0 |
| ssh2 hostVerifier 收到的是**原始 host key Buffer**(不设 hostHash 时), known_hosts 条目 = base64(原始 key 字节), 直接比较; host 匹配需同时覆盖 'host' 与 '[host]:port'(非 22 端口)两种写法 | ssh2/lib/client.js:273-291 + 实测 |
| ssh2 仅在显式设置 agent 选项(如 SSH_AUTH_SOCK)时才尝试 agent 认证 | ssh2/lib/client.js:219-224 |
| exec 通道: stream.on('close', (code, signal)) 的 code 即退出码; 另有 'exit' 事件; stdout=stream, stderr=stream.stderr | ssh2/README.md:71-87(官方示例) |
| live smoke 实测输出: exec 'echo hi; hostname; uname -m' → exit 0 / hi / <remote-host> / x86_64; sftp readText('/etc/hostname') → <remote-host>; sftp listDir('/tmp') 前 3 条: mcp3.json, proxy_pool_deploy.log, server_run2.py | 实测 node packages/dsh-ssh/scripts/live-smoke.mjs |

**踩坑记录**:
1. **本机 ssh-agent 无身份**(ssh-add -l → "The agent has no identities"): 纯 agent 认证会失败 → live-smoke 配置 auth={type:'key', privateKeyPath:'~/.ssh/id_ed25519'}(ssh2 同时带 agent 选项, agent 有身份时优先; 无则公钥回退), 与笔记 §6.5 "公钥认证 OK" 一致。
2. settingsNamespace 不允许点号(见上表)——任务书里的 'dsh-ssh-hosts' 是笔误, 已用 dsh-ssh-hosts。
3. base64 比较陷阱: known_hosts 里未补齐的 base64 与 Buffer.toString('base64') 补齐后不一致 → 测试夹具用 Buffer.from(已知字节串).toString('base64') 生成, 保证往返一致。
4. 连接失败路径: 127.0.0.1:1 → ECONNREFUSED, SshConn.connect() 抛 SshError{stage:'connect'}; SshPool.acquire 失败后立即从池中驱逐该连接(防止复用坏连接), 容量恢复。
5. SFTP 目录项: ssh2 readdir 返回 {filename, attrs}, attrs.isDirectory()/isFile()/isSymbolicLink() 是函数; M2a 只封装 readText/listDir, 其余 M3 直接用底层 sftp 句柄。

**M2b 衔接点**: 设置区渲染用 installSettingsSection + SettingsDescriptor(describe 输出 schema.toJSON()); testConnection 由设置页调用 ctx.sshPool.testConnection(cfg) 即可(已带 banner/error 返回)。

### A.3 M2b 设置页 SSH 主机配置 UI(M2b 子代理, 2025-08-16)

> 产出: packages/dsh-ssh/{client.js, src/remote.js, lib/hosts-model.js, lib/typert-contribution.js, scripts/client-selfcheck.mjs, test/{hosts-model,typert-contribution,remote,settings-schema}.test.js}; 修改 index.js / package.json / src/settings.js, 更新 pnpm-lock.yaml(pnpm install, 新增 peer 依赖解析)。验证: node --check 全文件过; node --test 40/40(新增 25 + M2a 15; remote.test.js 用真实 cordis Context 验证 SshRemoteService 绑定与 secret 合并); 客户端静态自检通过(id/inject/require 契约, 只 require react + primitives); dsh --profile dsh-ssh-dev --dump-config exit 0 且 dsh-ssh 段存在(config.maxConnections: 4)。**客户端真机 UI 验证未做(需 web 重建, 见下方待发布清单)**。

**调研结论(先查后写)**:

| 问题 | 结论 | 出处/依据 |
|---|---|---|
| settings.section 槽如何注册? | 客户端 apply 内 `ctx.slots.inject("settings.section", () => ctx.slots.register({name:"settings.section", id, order, label, locale, inject}, Component))`; 注册项 {id(分区 key), order(导航位), label(可 thunk 跟随 locale), locale(字典 ns, 框架注入 `t` 座), inject(业务面工厂; 含 `hooks` 座时按 `use<Name>` 注入 selector hook)}; 槽 kind 'list'/scope 'root', owner 仅 {close} | dsh-client-ui-settings@lib/types/client/contract/slots.d.ts:67; 现成消费方 dsh-client-ui-agent-preset@lib/client.js:1555-1713; dsh-client-ui-slots@lib/types/index.d.ts(register/inject/hooks/locale 语义) |
| 客户端如何读写 settings? | **官方通道足够, 无需为 CRUD 自建**——`ctx.get("connection").api.settings`(SettingsApi: describe/update/mutate, 与 ui-agent-preset 同款)。describe 返回已脱敏值(role('secret') 字段剥除 + `secrets:[{path,set}]` 只写槽); update 是 merge 语义、省略的 secret 字段保留已存值; mutate 是路径编辑且**路径必须是字符串数组(数字下标被拒)**。另存在 `ctx.settingsScope.bind({namespace})`(dsh-client-ui-settings 的响应式 scope), 本项目选 api.settings 以对齐树内例子并保持纯函数可测 | dsh-host-apiproxy@lib/types/api/settings.d.ts:53-112; dsh-settings@lib/index.js:235(mergeLayers)/434(mutate 路径约束)/457; dsh-client-ui-settings@lib/types/client/settings-scope.d.ts |
| 测试连接怎么走? | 官方 RPC map(RpcMethodMap)是封闭集合, 无通用 host.call → **自建最小 Typert 远程服务**(唯一官方通道): 宿主 `SshRemoteService extends Service`(key 'ssh')+ `this.typertRemote = bindTypertRemote(this,'ssh')` + `ctx.typert.register(HOST_TYPERT_CONTRIBUTION)` 注册严格 descriptor(src-json codec); gateway claims /api/ssh/testConnection 并分发到 ctx.get('ssh').testConnection(cfg)。客户端 `ctx.remote.$mount(CLIENT_TYPERT_REMOTE)` 后调 `ctx.remote.ssh.testConnection({cfg})`。**关键**: 客户端 $mount 强制 strict codec(dsh-api-gateway/lib/client.js requireStrictCodec), 用 passthrough schema(parse=identity, 值已在宿主侧校验); 宿主侧可用 src-json | dsh-api-gateway@lib/index.js:65-160(claimsEndpoint/srcDescriptor/invoke); dsh-api-gateway@lib/client.js:35-110,379-395($mount/strict 强制); dsh-typert-registry@lib/index.js:510(validateInvocation: id 仅 nonempty, '#' 合法); 参考 dsh-goal@lib/typert.host.js + typert.remote-client.js(生成物形态) |
| 宿主侧如何取未脱敏口令补全 testConnection? | settings 脱敏只发生在 describe(redactSecrets) 边界; 宿主 `ctx.settings.get('dsh-ssh-hosts')` 拿到完整 resolved 值(含口令)。remote.testConnection 先按 id 查存储配置, 用 mergeTestConfig 补 auth 材料/默认值 | dsh-settings@lib/index.js:239(get); 本仓库 lib/hosts-model.js:mergeTestConfig |

**设计变更(影响 M2a 产物, 已迁移)**:

1. **settings 形状: hosts 数组 → hosts dict(id → HostConfig)**。理由: 官方 settings merge(mergeLayers)对普通对象递归合并、对数组整体替换; 数组下"口令留空 = 保持已存"无法表达(替换数组会把未回显的口令一并删掉)。dict 下省略 auth.password 即保留, 删除走 mutate unset ['hosts', <id>](字符串路径合法)。已核对 ~/.dsh/settings.yaml 无 dsh-ssh-hosts 用户层, 形状变更零迁移。HostsSettingsSchema 改为 z.dict(HostConfigSchema).default({}), base {hosts:{}}。
2. **peerDependencies 新增**: @deepseek-ai/dsh-typert-protocol(宿主 remote)、@deepseek-ai/dsh-client-ui-primitives(客户端, 与参考包一致); package.json 增 dsh.client{platform:'web', inject:['@deepseek-ai/dsh-client-ui-primitives']}、exports['./client']、files 含 client.js/lib。运行时经 $DSH_HOME/profiles/node_modules 回退解析(已实测 dsh-ssh-dev profile 内 typert-protocol 可解析; primitives 仅 web 客户端消费)。
3. **client.js 必须自包含**(web ModuleLoader 的 require 只解析 web 模块图, 不支持相对路径): 纯函数为 lib/hosts-model.js 的逐字内联副本(hosts-model.js 是 node 可测的权威副本, **改动需双处同步**); Typert 客户端 descriptors 内联 lib/typert-contribution.js; 只 require 'react' + '@deepseek-ai/dsh-client-ui-primitives'(静态自检断言)。

**待发布阶段验证清单(web 重建后)**:

- [ ] 设置页出现 "SSH 主机" 导航项(settings.section id=ssh-hosts), 空态 + 添加表单渲染正确;
- [ ] 添加/编辑/删除主机持久化到 ~/.dsh/settings.yaml 的 dsh-ssh-hosts(dict 形态), 重启后保留;
- [ ] 口令只写框: 留空保存后口令保持(describe 不再返回、合并保留); 输入新口令后覆盖; 切到密钥认证后 auth.password 槽被 unset;
- [ ] "测试连接": 对主测试远端(ubuntu@203.0.113.10:22)返回 ok+banner; 对错误配置返回错误文案; 口令认证主机在留空口令下仍能测通(宿主侧补全);
- [ ] locale 切换(en/zh)后导航 label 与表单文案跟随刷新;
---

### A.34 实施: TOFU 弹窗版 —— 首次连接未知主机密钥, 指纹确认后信任保存(2026-08-19, 子代理)

> 现状痛点: 原 hostVerifier 对 unknown/mismatch 一律硬拒绝(stage 'verify-host-key'), 用户新加主机首次"测试连接"必失败, 体验断裂。**已决策**: 做 TOFU 弹窗版(不要 accept-new 自动接受)。mismatch 维持硬拒绝(v1 不提供"仍然信任"覆盖)。

**设计要点**:

1. **错误面扩展(ssh-core.js)**: 新增常量 `HOST_KEY_UNKNOWN_STAGE = 'host-key-unknown'`。`verifyHostKey` 命中 unknown 且未 `acceptNew` 时, 抛 `SshError` 携带 `stage='host-key-unknown'` + `host/port/fingerprint/rawKeyBase64/keyType`; mismatch 保持 `stage='verify-host-key'` 硬拒绝、不带任何信任相关字段。`SshError` 增加 `isHostKeyUnknown` getter 与 `toJSON()`(保证结构化字段进程内 JSON 往返不丢)。新增 `sshKeyFingerprint(key)` = `'SHA256:' + base64(SHA256(rawKey)).replace(/=+$/,'')`(与 `ssh-keygen -lf` 一致, 已验证 ed25519/ecdsa/rsa 三种全部命中权威指纹) 与 `sshKeyTypeFromBlob(key)`(读 SSH pubkey blob 首段算法名)。

2. **结构化字段穿越连接错误面(关键坑)**: `SshConn._connectInner` 的 `client.on('error')` 此前只转发 `vErr.stage/message`, 把 fingerprint/rawKeyBase64 丢了 → 现把 `vErr.host/port/fingerprint/rawKeyBase64/keyType` 一并并入新 `SshError`。`SshPool.testConnection` 对 `isHostKeyUnknown` 的 SshError 返回 `{ok:false, error, stage, hostId, host, port, fingerprint, rawKeyBase64, keyType}`(作为返回值, 非抛出)。

3. **浏览方法值式上报(remote.js)**: dsh-api-gateway 对**抛出**的错误只序列化 `code/message/details`(`rpcFailure`), 结构化字段必丢 → `resolveRemoteHome / listRemoteDir / statRemote` 对 connect 阶段的 host-key-unknown 由 `acquireStoredOrHostKeyUnknown` 转为**返回**统一形状 `{ok:false, stage:'host-key-unknown', hostId, host, port, fingerprint, rawKeyBase64, keyType, message}`(被网关包成 `{ok:true, value:{...}}`), 前端据此弹窗。

4. **信任保存通道(宿主侧 `trustHostKey`)**: 入参 `hostId + rawKeyBase64 + fingerprint`。**防 TOCTOU**: 追加的必须是用户确认时看到的那把 key(前端把失败时拿到的 rawKeyBase64 原样回传, 宿主绝不重新握手取 key); 写盘前用 `fingerprint` 重算校验(与用户确认的指纹不符直接拒绝)。路径 `cfg.knownHostsPath || defaultKnownHostsPath()`。核心写盘 `appendKnownHost(path, host, port, keyType, keyBase64)`: 追加 `<hostpat> <keytype> <base64>`(hostpat 走 `knownHostsPatterns` 的 [host]:port 形态), 幂等(同 host+keytype+key 明文条目已存在则跳过)+ 换行幂等(文件以 \n 结尾/为空时直接追加)。keyType 由 rawKey 解析兜底。

5. **前端弹窗(client.js)**: 设置页 "测试连接"(HostRow.testConnection + HostForm.testConnectionForm)与目录浏览(RemoteFlowBody 的 resolveRemoteHome/listRemoteDir)捕获 host-key-unknown → 弹 `TrustHostKeyModal`: 显示 主机/host:port、密钥类型、SHA256 指纹(等宽字体 + 一键复制, navigator.clipboard 带 document.execCommand 回退), 按钮【信任并保存】/【取消】。确认 → `ssh.trustHostKey(hostId, rawKeyBase64, fingerprint)` → 自动重试原操作(测试连接 / 目录浏览); 取消仅关闭。zh/en 双语文案按 settings.ssh 与 workspace.ssh 两套命名空间各补一组。Typert 客户端 descriptors 增加 `trustHostKey(['hostId','rawKeyBase64','fingerprint'])`(host 与 client 双侧, 顺序保持一致以通过 `for i<9` 对齐断言)。

**改动文件清单**:
- `packages/dsh-ssh/src/ssh-core.js`: SshError(字段+isHostKeyUnknown+toJSON)、HOST_KEY_UNKNOWN_STAGE、sshKeyFingerprint、sshKeyTypeFromBlob、verifyHostKey(unknown→结构化)、appendKnownHost、knownHostsLine、`_connectInner` 错误面转发结构化字段、`SshPool.testConnection` unknown 富化返回。
- `packages/dsh-ssh/src/remote.js`: 浏览三方法(resolveRemoteHome/listRemoteDir/statRemote)值式上报 + `trustHostKey` 宿主方法 + 注册日志加 ssh/trustHostKey。
- `packages/dsh-ssh/lib/typert-contribution.js`: 新增 `TRUST_HOST_KEY_METHOD/ENDPOINT` 与 host/client 双侧 descriptor(共计 9 端点)。
- `packages/dsh-ssh/client.js`: `trustHostKey` descriptor + ZH/EN 与 SSH_ZH/SSH_EN 信任文案 + `TrustHostKeyModal` 组件 + controller 信任态(openHostKeyTrust/cancelHostKeyTrust/trustAndRetry/hostKeyUnknownOf) + 设置区 / 目录流两处接线(注入 injected/injectedFlow + 渲染)。
- 测试: `test/ssh-core.test.js`(unknown 结构化字段若干、mismatch 硬拒绝无信任字段、指纹/类型解析、knownHostsLine、appendKnownHost 幂等+换行, 写临时文件; 更新 makeHostVerifier unknown → host-key-unknown)、`test/remote.test.js`(trustHostKey 追加+幂等+指纹校验、resolveRemoteHome 值式上报)、`test/typert-contribution.test.js`(8→9 端点 + trustHostKey wire 断言)。

**验证结果**:
- 单测: 全仓 `node --test test/*.test.js` = **tests 258 / pass 248 / fail 10**, fail 10 全为 pre-existing Windows `path.sep` 用例(基线 250/240/10, **无回退**; 新增 8 用例全绿)。
- 指纹/类型解析 vs 权威 `ssh-keygen -lf`: 对 203.0.113.10 的 ed25519/ecdsa/rsa 三级全部 `ALL_MATCH`。
- 真机宿主侧流程(纯 Node, 临时 known_hosts, 未动真实 `<home>/.ssh/known_hosts`): ①空 known_hosts 对 ubuntu@203.0.113.10 → `SshPool.testConnection` 返回 `stage='host-key-unknown'` + `fingerprint=SHA256:DyeK...UUAkg`(== 权威 ed25519)+ `rawKeyBase64` + `keyType='ssh-ed25519'`; ②`SshRemoteService.trustHostKey` 追加到临时文件, known_hosts 行命中, 二次调用 `appended=false`(幂等), 传错指纹被拒(`refuse to write`); ③同一 pool 重测 `testConnection` → `{ok:true, banner:'ok'}`。**unknown→trust→重连成功 全程通过**。

**红线自查**: 未动 DSH core(只走 src/remote+typert 公共契约); 远端零安装; 未做 accept-new 自动信任(仅保留既有的 dev/test `acceptNew` 开关, TOFU 走用户确认); mismatch 不可覆盖(v1 无"仍然信任")。


### A.32 变更: 占位工作区标题格式改为 主机名 / basename(2026-08-19)

> 编号说明: 本条原编号 A.31 与后文「A.31 审计定位: 前端会话 ID 映射机制」撞号, 按 §6.4 保留双方, 本条改号 A.32。

> 按用户需求把远程占位工作区标题从 A.29 的 `basename · 主机显示名`(如 `opencode-api · ubuntu`)改为 `hostname / basename`(如 `ubuntu / opencode-api`)—— 主机名前置, 一眼识别来源主机。此条为对 A.29 历史条目的变更说明, 不改写历史条目。

**改动(仅 packages/dsh-ssh, 红线: core 零修改、本地工作区行为不变)**

- **src/placeholder.js**: `placeholderWorkspaceTitle(remotePath, hostDisplayName)` 输出改为 `hostDisplayName + ' / ' + placeholderDisplayName(remotePath)`。
- **src/remote.js createPlaceholder 迁移**: 新增识别 A.29 旧格式 `basename · 主机显示名`(精确匹配 `wantsBase + ' · ' + hostName`, 即本插件旧自动标题)并升级为新格式; 与既有迁移(① base64 编码段、② 纯 basename)并列, 幂等。用户手动改过、或已是新格式 `hostname / basename` 的 title 不动 —— 故个性化标题(如 `work · my-note`)仍不被强改写。
- **单测**: test/m4-placeholder.test.js 的 placeholderWorkspaceTitle 断言改新格式; test/remote.test.js 全部 createPlaceholder 标题断言改新格式(h1 / opencode-api、ubuntu / opencode-api、h1 / work、ubuntu / work), 并新增「A.29 旧格式 `basename · 主机名` → 新格式迁移 + 幂等」用例。

**验证**: cd packages/dsh-ssh && node --test test/*.test.js → **tests 247 / pass 237 / fail 10**(A.30 后总 246 上净增 1 测试、1 通过; fail 10 仍为 Windows path.sep 既有问题, 与本改动无关, 不劣化)。

- [ ] 只读 settings provider 下禁用添加/编辑/删除, 但测试连接仍可用;
- [ ] 卸载 dsh-ssh 后设置页无残留(槽、remote 贡献、locale 均随 fiber 清理)。

**踩坑记录**:

1. mutate 的 op.path 必须是**字符串数组**(数字下标直接抛 TypeError)→ 数组型设置无法逐元素编辑, 这是改 dict 的直接动因。
2. 客户端 $mount 的 strict codec 强制是硬校验, src-json 会被拒; 但宿主侧本地注册允许 src-json——两侧 codec 不对称是设计使然, 已在 lib/typert-contribution.js 注释说明。
3. 生成式 Typert 产物(id 形如 '<pkg>#<ns>/<method>')含 '#'——typert-registry 的 validateInvocation 对 id 仅要求 nonempty, 不自建形状校验时勿套用 service 段的 '#' 禁令(本项目 assertContributionShape 已对齐)。
4. 模板字符串里写正则字面量 `/\s/` 时注意转义(单反斜杠会被吞成 /s/, 曾导致 noSpaces 校验静默失效)→ 改用 host.includes(' ')。
5. 测试连接不该被 settings 只读门控(只读只禁写, 不碍读/测), 客户端按钮已解除该关联。

**M3 衔接点**: 工具层(M3)可直接经 ctx.sshPool.acquire(存储的 HostConfig)建连; 占位目录路径依赖 HostConfig.id(已在 dict key 上保留)。directoryFlow 槽与 Typert 目录浏览服务(M4)可复用本阶段的 Typert 通道模式(src/remote.js 是模板)。

### A.5.1 M3b 主编验收补记(2025-08-16)

| 事实 | 出处/验证 |
|---|---|
| **本地委托无递归风险(源码确认)**: dsh-tools 文档"Scoped tools shadow globals; duplicates within one layer fail"; register 按调用 ctx 的 scope 分层, get(name) 省略 scope = **全局视图** → 官方工具在 dsh-base 全局层、我们的同名工具在 preset 层, delegateLocal 取到的是官方实现 | dsh-tools@lib/index.js:2755 register / 2872 get(全局视图) |
| **OpenSSH 基础 SFTP rename 拒绝覆盖已存在目标**(远端未宣告 posix-rename@openssh.com 扩展, extensions 为空) → writeFileAtomic 改为: 有扩展用 ext_openssh_rename, 否则 rename 失败后 unlink 目标 + 重试(等价语义, 非原子窗口极小) | 实测: 第二次原子写(edit 往返)复现 rename Failure; 修复后 live smoke 全绿 |
| tools-live-smoke 脚本曾缺 mkdir 步骤(父目录不存在时 sftp 写报 No such file, 与本地 fs 语义一致) | 主编修复并验证 |
| M3b live smoke 全链路: exec hi → mkdir → 原子写 → 读回 → edit 往返 → 清理, TOOLS-LIVE-SMOKE-OK | 本机实测 ubuntu@203.0.113.10:22 |
### A.4 M3a preset-standard-ssh 产物与验证(M3a 子代理, 2025-08-16)

> 产出: packages/preset-standard-ssh/{upstream/standard-agent.cordis.yml, scripts/{build-preset,validate-preset}.mjs, scripts/lib/resolve-dsh.mjs, preset/{agent.cordis.yml,preset.yml}, package.json, README.md}。验证: build 两次 sha256 一致(幂等); validate 全绿(exit 0); 生成物 vs 快照 diff -u 仅两处替换 hunk。未启动任何 DSH 服务进程; 实验只在 /tmp; dsh checkout 只读。

**三个定案问题(先查后写)**:

| 问题 | 结论 | 出处 |
|---|---|---|
| Q1 preset 目录格式 | 目录 = COMPOSITION_FILE `agent.cordis.yml` + 可选 METADATA_FILE `preset.yml`(字段仅 name?/description?/order?; order 小者在前, 缺省排最后按 id); 目录名即 preset id, 须匹配 /^[a-z0-9][a-z0-9-]*$/; 缺组合文件或不可解析 → 报 `broken`(占 id 不隐藏); readPresetMetadata 读/解析/形状失败一律降级 {}; renderPresetMetadata = yaml.dump(自动引号, 缺省字段省略, 全空则 undefined); scanRoot({path,trust}) 按 order→id 排序, discoverPresets(roots) 先根胜出 | dsh-agent-presets@lib/types/metadata.js:23,47-91; discovery.js:24,38,136-186; preset.js:10(本包: <dsh-checkout>/node_modules/@deepseek-ai/dsh-agent-presets); /tmp 实测 scanRoot/discoverPresets/metadata 往返 |
| Q2 工具行方案(选 **B**) | 每个行 = 一次插件实例(cordis-plugin-loader entry._init/_start → registry.plugin(plugin, config)); 同名工具在同一 scope 层重复注册抛错(dsh-tools NamedEntries "already registered in this scope"); 单实例注册多工具是官方既有模式(dsh-tool-fs 一行注册 read/write/edit/read_image)。故三行 → 单行 `- id: tool-ssh / name: 'dsh-ssh/tools' / config: {}`: 少实例、单注册点、无需 toolMode 分派 API | cordis-plugin-loader@lib/index.js:512,522-533; dsh-tools@lib/index.js:2517; dsh-tool-fs@lib/index.js:333,604,749,952 |
| Q3 同包双角色(选 **exports 子路径**) | preset loader 对裸说明符走 Node internal import(相对 harness base, 即 host 组合 baseUrl=profile 目录), 支持包 exports 子路径; 官方 standard 自身就用 `'@deepseek-ai/dsh-tool-subagent-control/list-agents'` 子路径行(该包 exports `./list-agents`)。定案: host 服务行 name: 'dsh-ssh' → index.js(不变); preset 工具行 name: 'dsh-ssh/tools' → **M3b 需在 dsh-ssh exports 增加 "./tools" 并实现工具入口**。运行期解析: profile 自身 node_modules + $DSH_HOME/profiles/node_modules 扁平回退(dsh-ssh 作为 profile bundle 可达) | dsh-agent-presets@lib/index.js:469-506(PresetTree.import, 尤 495-505); cordis-plugin-loader@lib/index.js:259-273; dsh-app-boot@lib/index.js:299-305,390-434; standard/agent.cordis.yml:184; dsh-tool-subagent-control/package.json(exports './list-agents') |
| Q4 realm | 工具行只注册 tools、不 provide 服务 → 无需 isolate 组(与上游 tool-fs/tool-fs-search 同); mount 只拒绝向 ROOT realm 发布服务的行。tool-ssh 行顶层无 group/isolate, 合规 | standard/agent.cordis.yml:54-62 注释; dsh-agent-presets@lib/index.js:440-448(mount 守卫) |

**preset.yml schema(官方)**: `{ name?: string, description?: string, order?: number }`; 本 preset 用 name='标准 SSH 模式', order=3, description 见生成文件。**坑**: 手写 YAML 若 description 含 ": "(冒号+空格)会解析失败 → 必须经 renderPresetMetadata(yaml.dump 自动引号), 已实测往返。

**产出清单**:
- `upstream/standard-agent.cordis.yml` — 上游 standard 逐字快照 + 来源头(来源路径 / DSH v0.1.0-rc.6 / 2025-08-16 / "上游更新后重新复制并重跑 build" 维护说明)。
- `scripts/build-preset.mjs` — 幂等: 读快照 → 剥来源头(整行标记)→ 两处锚块纯文本替换(断言锚块恰好出现 1 次; 后置断言上游三行已移除、tool-ssh 行存在)→ 写 `preset/agent.cordis.yml` + `preset/preset.yml`(renderPresetMetadata)。替换行结构与定案注释见生成文件头部。
- `preset/agent.cordis.yml` — 生成物(生成头 + 正文; 与快照正文 diff 仅 tool-bash→tool-ssh 与 tool-fs/tool-fs-search→说明注释两处 hunk)。
- `preset/preset.yml` — 生成物(name/description/order)。
- `scripts/validate-preset.mjs` — ① loader 方言 entryListSchema YAML 解析(!!js 合法) ② 行结构: 每行 name 非空; 普通行 config 为对象/省略、group 行 config 为内嵌列表; tool-ssh 行存在且 config={}; 上游三行已移除; 顶层行数 = 上游 - 2 ③ 临时 $DSH_HOME 布局模拟(tmp/.agent-presets/standard-ssh)scanRoot/discoverPresets: 发现、trust=user、非 broken、元数据回读一致 ④ entryListSchema 即 loader 组合解析入口(无副作用, 不 boot 服务; 完整 loader boot 需建 Context, 属运行期验证) ⑤ 重跑 build 到临时目录与提交产物逐字节比对。
- `scripts/lib/resolve-dsh.mjs` — 从 dsh checkout 定位/导入 dsh 生态包(env `DSSH_DSH_NODE_MODULES` 可覆盖; dsh CLI realpath 推导, 只读)。

**validate 输出要点(2025-08-16)**: ① 3 项 ✓ / ② 8 项 ✓ / ③ 5 项 ✓ / ④ 1 项 ✓ / ⑤ 2 项 ✓ → "validate-preset: 全部通过 ✓", exit 0。

**踩坑**:
1. build 脚本 REPLACEMENT_BASH 注释行含单引号(`name: 'dsh-ssh'`)未转义 → JS SyntaxError; 改双引号包裹该字符串。
2. 快照头分隔标记若只取部分 ─ 装饰会残留一行 box 字符 → 前缀定位后跳到行尾整行吞掉。
3. 行结构校验须区分普通行 config(对象/省略)与 group 行 config(内嵌行列表数组), 否则误报。
4. 朴素逐行 diff 在替换区长度变化后会失步, 审查用 `diff -u`(仅两处 hunk 即正确)。

**M3b 衔接点**: dsh-ssh 需新增 exports `"./tools"`(如 lib/tools.js)并实现 apply: 用 ctx.tools.register(defineTool) 注册 bash/read/write/edit/read_image/glob/grep(与官方同名); 本地路径委托宿主 ctx.shell/ctx.fs/ctx.subprocess(逐字节一致), 远端路径(`~/.dsh/remote/<hostId>/...`)走 ctx.sshPool.acquire(存储的 HostConfig); glob/grep 远端用 find/grep -rn 重实现(R2)。preset 行结构已就绪, M3b 只实现模块即可被加载。


### A.5 M3b 同名工具路由(五工具)产出与验证(M3b 子代理, 2025-08-16)

> 产出: packages/dsh-ssh/{tools.js, src/router.js}; 扩展 src/ssh-core.js(SftpWrapper 增 stat/readBytes/writeFileAtomic/unlink/rmdir, exec 捕获 signal)、package.json(exports "./tools"、files、peerDeps、diff 依赖)、scripts/tools-live-smoke.mjs、test/{router,tools-remote,tools-local}.test.js; preset-standard-ssh 注释/描述更新并重跑 build(幂等)。验证: node --check 全过; node --test 70/70; build 两次 sha256 一致; validate-preset 全绿; dsh --profile dsh-ssh-dev --dump-config exit 0; dsh-ssh/tools 从 profile 目录可解析。

**调研定案(先查后写)**:

| 问题 | 结论 | 出处 |
|---|---|---|
| 五工具契约(name/parameters/output) | bash: command/description(必填)/timeoutMs/workdir/run_in_background/sandbox_permissions+justification(沙箱时); output oneOf[background{kind,jobId} / foreground{kind,exitCode,signal,timedOut,aborted,timeoutMs,stdout{text,truncated,spillPath},stderr,sandbox}]。read: file_path/offset/limit → {path,offset,lines[{number,text}],totalLines}。write: file_path/content → {path,operation(create/update),before(string|null),after}。edit: file_path/old_string/new_string/replace_all → {path,before,after}。read_image: file_path → {path,image{attachmentId,mediaType,bytes,width,height,name}} | dsh-tool-bash@lib/index.js; dsh-tool-fs@lib/index.js |
| 官方包是否导出可复用 execute? | 否: 仅导出 {Config, apply, inject, name}。**但** tool-bash/tool-fs/tool-fs-search 在 host 组合(@deepseek-ai/dsh-base/cordis.patch.yml:211/225/228)已全局注册 | 两包 lib/index.js 尾部 export; dsh-base/cordis.patch.yml |
| 本地委托最优路径(定案) | ctx.tools.get(name)(省略 scope=全局视图)返回官方注册定义 → 本地分支直接 official.execute(args, exec)(逐字节一致, 零重实现)。get(name) 语义: scoped 阴影 global, scope 省略取 global(dsh-tools/lib/index.js:2872-2874, view() 2836) | dsh-tools@lib/index.js |
| 会话 cwd 来源 | exec.agent?.session?.header?.cwd(bash resolveWorkdir 与 fs sessionCwd 同源) | dsh-tool-bash@lib/index.js resolveWorkdir; dsh-tool-fs session-cwd |
| ctx.fs / ctx.shell 精确 API | fs: resolve/stat/readText/streamText/readBytes/listDir/writeText/editText(FsError 码: FS_NOT_FOUND/FS_NOT_REGULAR_FILE/FS_TOO_LARGE/FS_NOT_TEXT/FS_AMBIGUOUS_EDIT/FS_EDIT_NOT_FOUND); shell: resolve→run→ShellRunResult{exitCode,signal,timedOut,aborted,timeoutMs,stdout{text,truncated,spillPath},stderr,sandbox} | dsh-fs@lib/types/index.d.ts + types.d.ts; dsh-shell@lib/types |
| edit 语义(远端套用) | applyLiteralEdit: CRLF→LF 归一化匹配; 0 次→FS_EDIT_NOT_FOUND; >1 次且非 replaceAll→FS_AMBIGUOUS_EDIT; 写回恢复原行尾 | dsh-fs-local@lib/types/fsio.d.ts(applyLiteralEdit/readForEdit/restoreLineEndings) |
| 未知 hostId 判定(决策) | routeByCwd 纯函数按路径形状返回 remote; tools.js 执行期查 dsh-ssh-hosts dict, 缺失 → 报"未配置"(不静默当本地, 避免对空占位目录做本地读写) | 本仓库 tools.js getHostConfig |

**产出清单**:
- tools.js: 注册五工具, 本地委托 ctx.tools.get(name).execute, 远端走 sshPool/SFTP; read/edit 有远端单文件大小上界(remoteMaxFileBytes 默认 10MB, 本地 read 流式无界, 文档化限制)。
- src/router.js: routeByCwd/mapLocalToRemote/mapRemoteToLocal/resolveRemotePath; 编码 = base64url(无补位、单段), hostId 校验拒绝穿越, 解码须回读为绝对路径。
- src/ssh-core.js: SftpWrapper 增 stat/readBytes/writeFileAtomic(临时+rename)/unlink/rmdir; exec 增 signal 捕获。
- test/: router(8)/tools-remote(14)/tools-local(8)。

**验证要点**:
- node --test 'packages/dsh-ssh/test/*.test.js' → 70/70(M2a 15 + M2b 25 + M3b 30)。
- node --check 全文件过; dsh --profile dsh-ssh-dev --dump-config exit 0(dsh-ssh 行 config.maxConnections:4)。
- dsh-ssh/tools 从 profile 目录 import('dsh-ssh/tools') 解析成功(name=dsh-ssh-tools)。
- tools-live-smoke.mjs: 真机 exec echo hi + writeFileAtomic→readBytes→read→改→写回→清理(与 live-smoke.mjs 同款内存配置, 不写 settings.yaml/用户 known_hosts; 本次子代理未运行真机, 供主编代理带授权执行)。

**踩坑**:
1. 官方包不导出 execute → 但官方工具在 dsh-base host 组合已全局注册, 用 ctx.tools.get(name) 复用其 execute, 比"重实现/动态 import"都更贴近硬约束 4。
2. SftpWrapper(包装层)与 ssh2 原始 SFTPWrapper(回调风格 readFile/stat/writeFile/rename/unlink)接口不同名 —— 测试 mock 须让 conn.sftp() 返回 SftpWrapper 包装(而非原始 sftp), 否则 tools.js 调 sftp.stat() 撞上原始 stat(p,cb) 签名 → "cb is not a function"。
3. 测试源文件里写 '\u0000'/'\n' 字面量经模板字符串会变成真实 NUL/换行字节 → 文件被判二进制/语法错; 用 String.fromCharCode(0)/显式断言代替。
4. 远端 exec 超时→映射为 timedOut:true 结果(非抛错), 与官方 bash 一致; 其余 SshError 转文案含 hostId/stage/远端命令。
5. base64url 空串往返: encode('')='' 但 decode('') 拒(远端路径必为绝对路径, 空串不是合法远端路径), 测试单独断言。

**M3c 衔接点**: glob/grep 需在 tools.js 补注册两个同名工具(远端 find / grep -rn 重实现, 对齐 rg 语义: 忽略规则/二进制/超时, R2); 可复用本阶段的 routeByCwd/resolveRemotePath/acquireRemote/SftpWrapper; 大目录列举用 readdir 批量 + 延迟 stat(R8)。directoryFlow 槽 + Typert 目录浏览(M4)可复用 SshPool + SftpWrapper.listDir。

### A.7 紧急修复: settings 命名空间未被 apiProxy 暴露, CRUD 改走 Typert 通道(2025-08-16)

> **背景**: M2b 的 F1 CRUD 走 api.settings(describe/update/mutate), 用户实测报错
> settings namespace "dsh-ssh-hosts" is not exposed to configuration clients。主编定位根因后派本修复:
> **CRUD 全部改走 M2b 已建好的 Typert 通道**(testConnection 同款), 移除 api.settings 引用。

**根因(源码出处, 主编定位 + 本子代理复核)**:

| 事实 | 出处 |
|---|---|
| 暴露给配置客户端的 settings 命名空间是**硬编码白名单**, 第三方命名空间不在内: WEB_SETTINGS_NAMESPACES = ["agent-loop","shell","locale","permission","ui-conversation","ui-theme","web-search-deepseek"] | @deepseek-ai/dsh-host-apiproxy@lib/index.js:888(本机: <dsh-checkout>/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js) |
| 白名单源码注释明确: "a namespace absent here answers settings-not-exposed even when its owner registered it… Moving that declaration to settings.register(), so a plugin can expose its own configuration without a change in this package, **is deferred work**" | 同文件 :880-887 |
| 产品侧白名单同样封闭: PRODUCT_SETTINGS_NAMESPACES = new Set(["ui-onboarding", SETTINGS_NAMESPACE]) | 同文件 :1001 |
| 判定与报错: exposedNamespaces()(model-provider ∪ 两个白名单) + notExposed() 返回 {code:"settings-not-exposed", message: settings namespace "<ns>" is not exposed to configuration clients}; describe 也按白名单过滤 | 同文件 :2410-2421(用户实测即此错误)、:3470-3474 |

**修复内容(纯附加, 不碰 core)**:

1. packages/dsh-ssh/src/remote.js: SshRemoteService 新增 listHosts() / saveHost(id, patch, revision) / deleteHost(id, revision)(沿用 testConnection 的 descriptor/claims 模式):
   - listHosts(): 从 ctx.settings.get('dsh-ssh-hosts') 读 dict, 经 redactHosts **剥除 auth.password 后**返回 {hosts, secrets:[{path,set}], revision, writable}; revision 取 settings describe 的 scope revision(乐观并发), secrets 形状对齐 describe 的只写槽(客户端 isHostSecretSet 不变)。
   - saveHost(id, patch, revision): mergeHostPatch 把 patch 合并进已存条目(口令缺省/空串 = 保持已存; auth.type 切 key = 清除 password), validateHostConfig 宿主侧复验(远端值不信任), 一次 settings.mutate set-op ['hosts', id] 整条目替换 + expectedRevision = revision; 过期 revision → SettingsConflictError(code SETTINGS_CONFLICT) → 转成带 SETTINGS_CONFLICT 标记的中文重试提示。
   - deleteHost(id, revision): mutate unset ['hosts', id]; 缺失 id 幂等。
   - 校验用 hosts-model 新增的 validateHostConfig(镜像 HostConfigSchema 规则), 宿主侧执行。
2. packages/dsh-ssh/lib/typert-contribution.js: 4 个端点 ssh/{testConnection,listHosts,saveHost,deleteHost}, 参数 listHosts:[] / saveHost:['id','patch','revision'] / deleteHost:['id','revision']; 宿主侧 src-json / 客户端 strict passthrough(同 testConnection, A.3 坑 2 的 strict codec 约束仍适用)。
3. packages/dsh-ssh/client.js: CRUD 改调 ctx.remote.ssh.{listHosts,saveHost,deleteHost}; 口令只写框语义保持(留空不发送 password 字段, 宿主侧合并); 删除 api.settings 引用与 connection inject(inject 变为 ["slots","locale","remote"]); 内联副本同步 hosts-model 变更(删除 assembleHostsSave/deleteHostOp/deepEqualJson); settings.section 槽注册不变。
4. packages/dsh-ssh/lib/hosts-model.js: 新增 mergeHostPatch / validateHostConfig / formatHostErrors / redactHosts / hostsSecretsList; **删除** settings-wire 专用的 assembleHostsSave / deleteHostOp(及仅其使用的 deepEqualJson)。
5. 测试: test/remote.test.js 新增 11 用例(真实 cordis Context + mock settings: 脱敏/secret 语义/冲突/幂等删除/校验拒绝); test/hosts-model.test.js 重写 settings-wire 用例为 merge/validate/redact 用例; test/typert-contribution.test.js 覆盖 4 端点与 wire 参数; scripts/client-selfcheck.mjs 增加内联 descriptor 与 lib 副本的逐行钉死(防再次漂移)。

**验证结果(本子代理实测)**:
- node --test 'packages/dsh-ssh/test/*.test.js' → **87/87 通过**(修复前 71)。
- node --check 全部改动文件通过; node packages/dsh-ssh/scripts/client-selfcheck.mjs 通过(inject=["slots","locale","remote"], 仅 require react + primitives, 4 条 descriptor 钉死)。
- dsh --profile dsh-ssh-dev --dump-config → exit 0, dsh-ssh 行存在(config.maxConnections: 4); 未启动服务、未写 ~/.dsh/settings.yaml、未动 known_hosts。
- 真机 UI 验证仍属发布阶段清单(A.3 待发布清单不变; CRUD 走 Typert 后, 该项的前两条"设置页出现/添加编辑删除持久化"以本修复后的通道为准)。

**对 A.3 的修正(重要)**: A.3 调研表"客户端如何读写 settings?"一行的结论 **"官方通道足够, 无需为 CRUD 自建"已被推翻**——api.settings 的 describe/update/mutate 仅对 dsh-host-apiproxy 硬编码白名单内的命名空间可用, 第三方插件命名空间一律 settings-not-exposed(含 describe 过滤)。**插件自己的 settings 命名空间 CRUD 只能走自建 Typert 远程**(本项目 testConnection 已建好框架), 这是 settings 子系统的硬边界, 后续 M4 目录浏览等任何"宿主读写 + 客户端 UI"能力都应沿用该通道; 若上游把"expose 声明下沉到 settings.register()"落地(见 :885-887 deferred work), 届时可再评估是否回退到 api.settings。
### A.6 M3c glob/grep 远端重实现产出与验证(M3c 子代理, 2025-08-16)

> 产出: packages/dsh-ssh/{src/search.js(新, 纯函数层), tools.js(注册 glob/grep), src/ssh-core.js(exec 增 maxStdoutBytes; 修复 readBytes 流水线 bug), test/tools-search.test.js(新), test/{tools-local,ssh-core}.test.js(更新), scripts/tools-live-smoke.mjs(扩展 glob/grep 段)}。验证: node --test 145/145; tools-live-smoke.mjs → **TOOLS-LIVE-SMOKE-OK**(真机 ubuntu@203.0.113.10:22, 含 glob/grep 段); dsh --profile dsh-ssh-dev --dump-config exit 0; node --check 全过。未启动任何服务; 未写 settings.yaml/用户 known_hosts。

**官方 glob/grep 契约要点**(抄录自 @deepseek-ai/dsh-tool-fs-search@lib/index.js + lib/types/{glob,grep}.d.ts, 只读):

- **glob**: parameters {pattern(必填), path(可选)}; output {root:string, paths:string[]}; rg argv = `--files --glob=P --sort=modified --no-ignore --hidden` + VCS 排除(双 negated glob: `!**/<vcs>` + `!**/<vcs>/**`); 无 '/' 的 pattern 匹配任意深度 basename; 返回路径相对**会话 cwd** 显示(toWorkdirRelative); 超限(globMaxResults 默认 100)取 mtime 头(sampleOverCapGlobResults=false, 与上游 standard preset 一致)或跨顶层采样; timeoutMs=30s。
- **grep**: parameters {pattern(必填), path(可选), include(可选, 单正 glob)}; output {matches:[{path,lineNumber,line}]}; rg argv = `--json --regexp=P [+--glob=include] [+-- path]`; 默认跳过隐藏与 .gitignore 文件、二进制; 超限(grepMaxMatches 默认 250)head + spill(远端不落盘); 输出/文本/meta 形状(render/presentationMeta/presentCall/presentResult)已逐字对齐(SearchError 词表: SEARCH_ABORTED/SEARCH_INVALID_PATTERN/SEARCH_FAILED/SEARCH_RAW_OUTPUT_OVERFLOW)。

**rg 语义 ↔ 远端命令 对照表(R2)**:

| rg 语义 | 远端实现 | 对齐程度 |
|---|---|---|
| --files 只返回文件 | find -type f | ✓ |
| --hidden 含隐藏文件 | find 默认列出隐藏项 | ✓ |
| 排除 .git/.svn/.hg/.bzr/.jj/.sl | find \( -type d \( VCS 名 \) -prune \) | ✓ |
| --sort=modified(**升序**, 实测) | GNU find -printf '%T@\t%p\n' \| LC_ALL=C sort -n; BSD find 无 -printf, 探测失败回退 -print(遍历序) | ✓(GNU) / 遍历序(BSD, 文档化) |
| 无 '/' pattern 匹配任意深度 basename | find -name <basename 段>(花括号展开成 -o 组; 保守超集) + 本地 rgGlobToRegExp 精确过滤 | ✓(本地正则实现 globset 语义: ** 跨段/零段、{a,b}、字符类、大小写敏感) |
| pattern 匹配对象 = **会话 cwd 相对路径**(实测, 非搜索根相对) | 本地 matcher 对 toWorkdirRelative 后的显示路径过滤 | ✓ |
| 默认跳过隐藏文件 | grep --exclude-dir='.*' | 部分: 隐藏**目录** ✓; 隐藏**文件**会被搜到(文档化) |
| 跳过二进制 | grep -I | ✓ |
| 行号+路径 | grep -n -H; 本地解析 path:line:content | ✓(路径含 ':' 为 best-effort) |
| .gitignore 规则 | 不读(v1) | ✗ 文档化(rg 默认读; 远端建议 path 限定) |
| include -g glob | --include(花括号展开成多个; ** 折叠为 *; 仅 basename) | 部分: 含 '/' 的 include 明确拒绝 |
| Rust regex ↔ POSIX ERE | \\d→[0-9] 等无损桥接; 其余交 grep -E; exit 2(/invalid|error|usage/)→ SEARCH_INVALID_PATTERN | 部分: lookaround/backref 等不支持, 报错不静默 |
| 超时 30s | exec timeoutMs → SEARCH_ABORTED | ✓ |
| 原始输出上限 20MB | exec 增 maxStdoutBytes → SEARCH_RAW_OUTPUT_OVERFLOW | ✓ |
| 超限结果(100/250) | head 保留 + 页脚如实说明"完整结果未保存"(远端不写 spillStore) | 部分(不落盘) |

**不支持项清单**(全部显式文档化, 不许静默错误结果): .gitignore 不读; 隐藏文件被搜到; BSD find 无 mtime 排序(遍历序); include 含 '/'; 文件名含换行/NUL; 路径含 ':' 的 grep 输出解析为 best-effort; 符号链接(rg 不跟随目录链接; 链接到文件 rg 会搜, find -type f / grep -r 会跳过); spill(完整结果不落盘, 描述文案已如实调整)。

**踩坑记录**:

1. **readBytes 流水线 bug(本次最大坑, 影响 M3b 的 read/edit)**: 流水线 readBytes 在**回调里**推进 offset → 并发请求全落在同一文件位置: 小文件被重复 pipeline(16)次读取(实测 12B 读回 192B), 大文件读回 0 字节。且 OpenSSH sftp-server 对超尾位置的 READ 立即回 EOF(无磁盘 IO)、对有效位置先做磁盘 IO → 响应**乱序**(EOF 先于数据), 按"收到 EOF 即结束"必然丢数据。修复: ①文件位置在**发出请求时**推进; ②先 stat 拿 size, 以"已收字节 >= size"判定完成, EOF 仅作降级。已加单测(乱序 EOF 回归: 12B/空文件/5MB 真机校验)。
2. **GNU grep --include/--exclude 互毁**: GNU 3.7 上 `--exclude='.*'` 既不排除隐藏文件、还会让 `--include` 失效(实测 b.log 被误搜); BSD grep 上 --exclude 与 --include 同用同样失效(点开头 glob 尤甚)。定案: 只保留 `--exclude-dir='.*'`(两端可靠), 隐藏文件差异文档化。
3. rg 的 --glob 匹配对象是**会话 cwd 相对路径**而非搜索根相对(实测: `rg --glob='sub/*.ts' -- src` 不命中 src/sub/leaf.ts)。
4. rg --sort=modified 为升序(旧文件在前, 实测), 超限取 mtime 头与之一致。
5. 本地委托仍走 ctx.tools.get('glob'/'grep')(无递归风险, 同 A.5.1); 远端搜索错误映射官方 SearchError 词表, 连接类错误保留 hostId/stage/远端命令文案(N7)。
6. 开发环境坑: run_code 程序源码里写 \'$\' 序列会被 worker 模板吞掉 → 改走 edit 工具或占位符替换。

**M4 衔接点**: 搜索工具已完成 R2 语义对照与文档化差异; M4 目录浏览复用 SshPool + SftpWrapper.listDir; 后台任务远端化(M5)评估时注意 exec maxStdoutBytes/超时映射可作为通用护栏。

---

### A.8 Windows 本地安装收尾 + preset 同步实测(2026-08-18, 子代理)

> 场景: Windows 本机, 隔离 profile dsh-ssh-dev, DSH_HOME=<home>/.dsh(仅进程级 env; User/Machine 作用域未设)。本次只做 preset 落盘同步 + 全量检查 + 笔记回写, 全程未运行任何 `dsh plugin` 命令、未写 DSH core、未重启/干扰 GUI 进程(pid 9604)。

**1. Windows 本地安装的确切命令与踩坑(已验证)**:
- 安装命令: `dsh plugin --profile dsh-ssh-dev add "<repo>/packages/dsh-ssh"`(本地路径, Windows 反斜杠)。
- **坑**: profile 目录是 pnpm workspace root(含 pnpm-workspace.yaml), 直接 add 报 `ERR_PNPM_ADDING_TO_ROOT`(pnpm 拒绝向 workspace root 写入依赖)。
- **解法**: 在 `<home>/.dsh/profiles/dsh-ssh-dev/.npmrc` 写入 `ignore-workspace-root-check=true`, 重跑同一条 add 成功。
- 出处: 主代理此前实测(本次复核); .npmrc 现内容即该行。

**2. 安装后形态(link: 依赖 + bundles 数组 + dump-config 组合树, 本次复核)**:
- profile `<home>/.dsh/profiles/dsh-ssh-dev/package.json` → dependencies 含 `"@dsh-ssh/dsh-ssh": "link:<repo>/packages/dsh-ssh"`(pnpm link: 本地路径依赖, 非发布版语义)。
- 同文件 `dsh.profile.bundles` 数组含 `"@dsh-ssh/dsh-ssh"`(bundle 通道 add 时自动追加, 出处: A.3 调研 + 本次 dump-config)。
- `dsh --profile dsh-ssh-dev --dump-config`(本次 2026-08-18 重跑)→ exit 0; 组合树含 `# == @dsh-ssh/dsh-ssh` → `- id: '@dsh-ssh/dsh-ssh' / name: '@dsh-ssh/dsh-ssh'` → `config.maxConnections: 4`。

**3. preset 自动同步时机(--dump-config 不触发 apply, 已验证)**:
- `--dump-config` 只组装 host profile 组合树并退出, **不执行插件 apply**(源码: dsh-app-boot 的 dump 分支), 因此 index.js 里的自动同步不跑: 安装后 `.agent-presets\standard-ssh` 不存在(dump-config 前后均无, 本次实证)。
- 自动同步在 `apply()` 内: packages/dsh-ssh/index.js:90-96, `installBundledPreset()`(index.js:22 导出, home/fs 可注入)由 `config.autoInstallPreset !== false` 守卫, 失败仅 warn 不阻塞宿主启动。
- 触发方式二选一: ① 真正启动 dsh 服务(apply 阶段执行); ② 手工 `node packages/dsh-ssh/scripts/install-preset.mjs [--dry-run] [--home <dir>]`(home 来源顺序: --home 参数 → $DSH_HOME env → os.homedir()/.dsh; 本次显式 `--home <home>/.dsh`)。

**4. 本次 preset 同步实测(2026-08-18)**:
```bat
cd <repo>/packages/dsh-ssh
node scripts/install-preset.mjs --dry-run --home <home>/.dsh
node scripts/install-preset.mjs --home <home>/.dsh
```
输出: `[dry-run] 将安装到: <home>/.dsh/.agent-presets/standard-ssh / 内容: agent.cordis.yml, preset.yml` → `installed: ...agent.cordis.yml / ...preset.yml` → `done`, exit 0。
- 结果: 目标目录含 `agent.cordis.yml`(14201B)+ `preset.yml`(214B); agent.cordis.yml 第 57 行工具行 `- id: tool-ssh / name: '@dsh-ssh/dsh-ssh/tools' / config: {}`; tools.js 注册六工具 bash/read/write/edit/read_image/glob/grep(register 于 438/502/568/628/684/740/789 行, 843 行日志字面量印证)。
- 注意①: preset 是**会话级选择**, 不入 host 组合 → dump-config 看不到 standard-ssh 层属正常(同 Q1/Q4 调研)。注意②: preset 生成头注释仍写"五工具/glob/grep 待后续", 属生成注释滞后于 M3c, 不影响运行, 待 M5 更新 build-preset 文案。

**5. 收尾检查清单(2026-08-18 逐项实测)**:
- a. GUI 进程 9604: `Get-Process -Id 9604` → alive, node.exe(path=node.exe); 全程未重启/未 kill ✓
- b. 其他 profile 未污染: web 与 test-max 的 package.json + cordis.patch.yml, 操作前后 SHA256 逐字节一致(mtime 亦未变) ✓
- c. dump-config: 重跑 exit 0 且含 @dsh-ssh/dsh-ssh 层(maxConnections: 4) ✓
- d. DSH core 未改: <dsh-checkout> 全程只读(根目录/package.json mtime+sha256 前后一致); 本次唯一落盘 = .agent-presets/standard-ssh 两个新文件(纯附加) ✓
- e. 红线核对: 未装 default profile(未运行 dsh plugin)、未写 core、未重启 GUI ✓

**6. 遗留/风险**: ① standard-ssh 首次进入真正的 dsh 会话启动时, index.js 的自动同步会幂等覆盖同名文件(与手工结果一致); ② `.npmrc` 的 ignore-workspace-root-check=true 是 profile 本地配置, 卸载插件后仍残留(可接受, 如需清理可手删); ③ preset 文案滞后(五工具 vs 六工具)列 M5。

### A.9 dsh-ssh-dev 加装官方 web-app + 独立 Web 服务实测(2026-08-18, 子代理)

> 场景: Windows 本机, 隔离 profile dsh-ssh-dev; 目标 = 在隔离 profile 上起官方 web UI 体验 @dsh-ssh/dsh-ssh。核心结论 + 全部命令/输出实记如下。

**1. 关键结论(出处: bin.js 源码 + 本次双端实测)**:
- `dsh web` 是 `--profile web` 的**硬编码别名**, 拒绝任何 --profile(源码 <dsh-checkout>\lib\bin.js) → 在自定义 profile 起 web UI 的**正确姿势 = `dsh plugin --profile <name> add @deepseek-ai/dsh-web-app` + `dsh --profile <name> --port N`**; 单独 `dsh --profile dsh-ssh-dev web` 会报 "web takes none of parent --profile"。

**2. 安装(registry 包, 走 npm 同款 pnpm 解析)**:
- 失败命令: `dsh plugin --profile dsh-ssh-dev add @deepseek-ai/dsh-web-app`(latest=0.0.1-rc.1) → `ERR_PNPM_FETCH_404 GET registry.npmjs.org/@deepseek-ai/dsh-client-ui-models`: 该私有包未发布, `npm view` 亦 404。
- **成功命令**: `dsh plugin --profile dsh-ssh-dev add @deepseek-ai/dsh-web-app@next` → 安装 @deepseek-ai/dsh-web-app@**0.1.0-rc.7**(2m36s, EXIT=0, ~230 包; 若干 ECONNRESET 网络重试自动成功)。
- 为什么用 @next: core dsh 版本 = 0.1.0-rc.7, 与 @next 同代; latest(0.0.1-rc.1) 是旧代且携未发布依赖。判断依据: `npm view @deepseek-ai/dsh-web-app dist-tags`(latest=0.0.1-rc.1, next=0.1.0-rc.7) + 各版本 dependencies 对比(dsh-client-ui-models 仅 latest 有)。
- 结果: dsh-ssh-dev/package.json → dependencies += `"@deepseek-ai/dsh-web-app": "0.1.0-rc.7"`; dsh.profile.bundles = ["@deepseek-ai/dsh-base", "@dsh-ssh/dsh-ssh", "@deepseek-ai/dsh-web-app"]。

**3. 安装验证(dump-config)**:
- `dsh --profile dsh-ssh-dev --dump-config` → EXIT=0; 组合树含 `# == @deepseek-ai/dsh-web-app` 层(name: '@deepseek-ai/dsh-web-app/startup'、webserver: '@deepseek-ai/dsh-host-webserver'), 多处 `# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app`; @dsh-ssh/dsh-ssh 层仍在(maxConnections: 4)。

**4. 启动独立服务(3090)**:
- dsh CLI 是 dsh.ps1 shim; 直接用 node 起 bin.js 更稳: `Start-Process -FilePath node.exe -ArgumentList @("<dsh-checkout>/lib/bin.js","--profile","dsh-ssh-dev","--port","3090") -RedirectStandardOutput web.log -RedirectStandardError web.err.log -WindowStyle Hidden -PassThru`(命令内显式设置 $env:DSH_HOME=<home>/.dsh; 3090 起前 netstat 确认空闲)。
- 服务 PID=**44284**(记录于 profiles\dsh-ssh-dev\web.pid); 访问 URL **http://127.0.0.1:3090**; 日志 web.log 首行为 `dsh web: http://127.0.0.1:3090`, web.err.log 空。
- 验证: Invoke-WebRequest http://127.0.0.1:3090 -UseBasicParsing → **StatusCode=200**, body 12237B, 首字节 `<!doctype html><html lang="zh-CN">` + `window.__DSH_BOOT__` 注入 + title "DeepSeek Harness"; netstat 显示 TCP 127.0.0.1:3090 LISTENING PID 44284。

**5. 本次新踩坑: 真实启动时 link: 插件的 peer 解析失败(重要, 后续 dsh-dev 会话/启动会再遇到)**:
- 首启崩: `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis' imported from <repo>/packages/dsh-ssh/index.js`(web.err.log)。
- 根因: @dsh-ssh/dsh-ssh 以 `link:<repo>/packages/dsh-ssh` 安装, ESM 按**真实路径**从仓库目录向上解析 peer; 该机器上仓库 <repo> 此前**没有 node_modules**(peer 其实在共享层 profiles/node_modules, 但解析路径不经过它)。--dump-config 不 import 插件源码所以此前未暴露。
- 修复(落点 = 项目仓库自身依赖, 不碰 core/profile): 仓库根 `pnpm install --frozen-lockfile`(EXIT=0, 29s; lockfileVersion 9.0, **pnpm-lock.yaml 未被改写** git 验证; ssh2/cpu-features 原生编译失败为可选绑定, 警告不阻塞) → peer 落入 packages/dsh-ssh/node_modules/@deepseek-ai/(cordis/dsh-fs/dsh-settings/dsh-shell/dsh-tools/dsh-typert-protocol/dsh-sandbox/dsh-client-ui-primitives/schemastery, 均 rc.6/cordis 4.0.1) → 仓库内 `import('./index.js')` 验证 OK → 服务正常起。

**6. 红线确认(本次逐项)**: GUI PID 9604(node)起服务前(Get-Process)与起服务后均 alive ✓; 未改 default/web/test-max profile、未改 DSH core; 落盘只发生在 dsh-ssh-dev profile(依赖+bundles+web.log/err.log/web.pid)与仓库 node_modules(.gitignore 覆盖)。唯一 git 可见改动 = 本笔记文件(A.8 既有 + 本节 A.9)。

**7. 遗留/操作说明**: ① 服务 44284 常驻, 停止用 `Stop-Process -Id 44284`; ② latest 因私有依赖暂不可装, 待官方发布修复后可选切回 latest; ③ 该服务与 9604 的 GUI 互不影响(3080 vs 3090 两个独立进程)。

### A.10 修复: 客户端 "remote.ssh without inject" 报错(2026-08-18, 子代理)

> 场景: 3090 独立 Web 服务(dsh-ssh-dev profile)上, dsh-ssh 设置页报"读取设置失败"; host 端 web.err.log 干净, $mount 本身没失败。主 Agent 定位根因后由子代理照方案修复+验证。

**1. 根因机制(出处行号, 已核实)**:
- DSH Typert 客户端框架把 remote 命名空间服务注册为**平铺键**: `@deepseek-ai/dsh-api-gateway/lib/client.js:350-352` `remoteServiceKey(namespace) { return \`remote.${namespace}\`; }` → "remote.ssh"。
- 访问方经 Cordis 代理按平铺键解析: `@deepseek-ai/cordis/lib/index.js:672-697` get trap → :675 抛 `cannot get property "${prop}" without inject`(fiber.store 链上找不到且 inject 未声明时)。
- 官方参照: `@deepseek-ai/dsh-client-runtime/lib/client.js:10457-10462` inject = ["connection","typert","remote","remote.commands"] —— 平铺键必须显式出现在 inject。
- 我方缺陷: `packages/dsh-ssh/client.js:1404` 原 `var inject = ["slots","workspaces","locale","remote"]` 缺 "remote.ssh" → controller.load() → getSsh()(原 1414 行 `remoteReady ? ctx.remote.ssh : null`)访问 ctx.remote.ssh 抛代理错误 → 设置页"读取设置失败"。$mount 本身成功(web.err.log 干净)。

**2. 修复方式(仅 packages/dsh-ssh/client.js, plain JS 无构建)**:
- "捕获引用"替代"代理访问": 新增 `var sshService = null`(1413 行); `getSsh()` 改为 `return sshService`(1415 行), 不再触碰 ctx.remote.ssh 代理; 删除 remoteReady 变量(原 1412 行)。
- **不**把 "remote.ssh" 加进主 inject 数组(1404 行)——会死锁: 主 fiber 激活等 remote.ssh, 而 remote.ssh 由主 fiber apply 内 $mount 注册。
- $mount 调用(1425 行)之后用 `ctx.inject(["remote.ssh"], function (sshCtx) {...})` 子 fiber 等待服务就绪并捕获引用(1449-1453 行): `if (mountFailure !== null) return; sshService = sshCtx.remote.ssh; controller.load();`。
- ctx.inject 语义(cordis/lib/index.js:1599-1605): "Start a callback once the requested dependencies are available", callback 收到子 fiber 的 ctx; 服务未就绪前子 fiber 保持等待, 不阻塞主 fiber 的 $mount 注册 → 无死锁。
- 失败路径保留: mountReady.catch(mountFailure + setLoadError) 原样(1425-1429 行)。
- 就绪后所有 getSsh() 消费方自动受益: controller.load/saveForm/confirmDelete/testConnection(384/448/470/491 行)、directoryFlow remoteCall(1493 行)。

**3. 验证(重启 3090 服务)**:
- 停旧 PID 44284 → 3090 无 LISTEN; 按 A.9 §4 相同方式重启(node bin.js --profile dsh-ssh-dev --port 3090, $env:DSH_HOME 显式, 日志覆盖), 新 PID **63940**(web.pid)。
- `Invoke-WebRequest http://127.0.0.1:3090` → **HTTP 200**; `__DSH_BOOT__` 列出插件入口 `/plugins/@dsh-ssh/dsh-ssh/client.js?rev=13e7d98d56d1`。
- 抓取该 bundle(74798B): 含 `sshService`、`ctx.inject(["remote.ssh"]`、`sshCtx.remote.ssh`、死锁注释、`function getSsh() { return sshService; }`; **不含 remoteReady** → 新代码已进入交付 bundle。
- `node --check client.js` → SYNTAX OK。
- web.err.log = 0 字节; web.log 首行 `dsh web: http://127.0.0.1:3090`; netstat 3090 LISTENING 属主 63940。

**4. "当前设置不可写(只读)" 文案结论(与 remote.ssh 报错同根因)**:
- 文案是**插件自己的 ZH locale**: client.js:91 `"readonly": "当前设置不可写(只读)"`, 不是 dsh-client-ui-settings 的文案(后者是 dsh-client-ui-settings-plugins lib/client.js:1188 `readOnly: "本部署的设置为只读。"`, 用于插件配置标签页)。
- 触发条件: client.js:806 `state.writable ? null : 只读横幅`; `state.writable` 由 controller.load() 设置(client.js:395 `writable: !!value.writable`), 值来自 host 端 `ssh.listHosts()`(src/remote.js:59-61 `writable = api ? !!api.writable : true`, 本地 dsh-settings-file 恒 true)。
- 修复前 load 在 getSsh() 抛代理错误 → catch 只设 status:'error', writable 停留在 INITIAL 的 false(client.js:350) → 只读横幅误显示(与"读取设置失败"同时出现)。**同根因**, 非 settings document 层的独立只读行为; 真正的设置只读是 host 端 provider writable=false(dsh-settings/lib/index.js:444 抛 "settings provider is read-only", 本地文件提供方恒可写)。
- 修复后 load 成功取真实 writable → 横幅消失、保存按钮恢复可用(client.js:815 `disabled: !state.writable`)。

**5. 红线确认**: 未碰 PID 9604(3080 GUI); 未改 DSH core; 改动仅 packages/dsh-ssh/client.js 与本笔记。

**6. 官方文档对照(2026-08-18 补充, 修复方案与官方姿势一致, 无需改代码)**:
- **Cordis 教程第 3 章"服务"**(https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/ ; 源文件 docs/cordis-tutorial/03-services.zh.md): "inject 列出该插件需要的服务。Cordis 会让插件保持 **PENDING**, 直到列出的每项服务都存在, 因此在 apply 内可以保证 ctx.greeter 已经就绪" —— 官方标准姿势 = inject 声明依赖 + 等待就绪; 该章还述: "加载后仍会跟踪依赖关系"(服务消失 → 依赖插件随之卸载, 恢复后再次加载), "可选依赖跳过 inject、用 ctx.get() 在使用处探测", "每个应用中的服务名称共用一个**扁平命名空间**"(印证 remote.ssh 是扁平键)。
- **Cordis 教程第 7 章"进入 harness"**(同 tutorial 源 docs/cordis-tutorial/07-into-the-harness.zh.md): `inject: ['tools']` + apply 内 ctx.tools.register() 的标准插件形态, 与我们整体结构一致。
- **能力接缝 capability-seams**(https://deepseek-harness.github.io/deepseek-harness/reference/capability-seams ; 源 docs/capability-seams.zh.md): ctx.typert / ctx.typertGateway 为 core 服务, api-gateway "将生成的 Remote 描述符与实时 Cordis 服务关联" —— 即 remote.<ns> 平铺服务由 api-gateway 框架注册, 客户端经 inject 声明后消费。
- **extension-cookbook**(https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/extension-cookbook ; 源 docs/cookbook/extension-cookbook.zh.md): host 端插件形态 `export const inject = [...]` + apply, 与我们的姿势一致; 该文档未覆盖"客户端插件消费自己 $mount 的 remote 服务"这一自引用场景。
- **对照结论**: 本修复 `ctx.inject(["remote.ssh"], function (sshCtx) {...})` 子 fiber = cordis 官方 API(cordis/lib/index.js:1599 "Start a callback once the requested dependencies are available")把官方 inject 等待语义放进**独立子 fiber**: 主 fiber 不声明 remote.ssh(避免自引用死锁: apply 内的 $mount 是注册动作, 主 inject 声明则 apply 永不运行), 子 fiber 声明并保持 PENDING, 就绪后 callback 内 sshCtx.remote.ssh 可用 —— 与教程第 3 章语义逐条一致(PENDING→就绪→callback 内服务可用; 服务消失→子 fiber 卸载、恢复→重载重捕获引用, 天然适配连接重置)。官方文档未给出更标准的替代做法(官方参照实现 dsh-client-runtime 把 "remote.commands" 放顶层 inject, 因其提供方为框架级、不依赖本插件 apply 触发; 本场景必须子 fiber 隔离), 故维持本方案。
### A.11 修复: 测试连接 "Host denied (verification failed)" —— known_hosts 缺省路径未 fallback(2026-08-18, 子代理)

> 场景: 3090 服务(dsh-ssh-dev profile)设置页主机 ubuntu@203.0.113.10(密钥认证)点"测试连接"报 `连接失败: Host denied (verification failed)`; 本机 ssh 客户端同主机免密正常。这是 known_hosts 主机密钥校验被拒(非认证失败)。

**1. 文案来源与排查结论**:
- "Host denied (verification failed)" **不在插件源码**(packages/dsh-ssh 仓库全 grep 无); 是 **ssh2 hostVerifier verify(false) 时的库内错误**(node_modules/.pnpm/ssh2@1.17.0/node_modules/ssh2/lib/client.js:281-287 包装 hostVerifier, verify(false) → 握手终止 emit error)。
- 插件自己的 verify-host-key 分类文案(ssh-core.js verifyHostKey: 'unknown host key for ...' / 'host key mismatch for ...')在旧代码里被 ssh2 原文覆盖(原 _connectInner client.on('error') 只传 err.message)。

**2. 根因机制(出处行号, 修复前)**:
- 保存的主机配置无 knownHostsPath 字段: <home>/.dsh/settings.yaml:80-90 仅 id/name/host/port/user/auth。
- schema 注释声称"缺省 ~/.ssh/known_hosts"(src/settings.js:29), 但实现无 fallback: 原 ssh-core.js:121-124 `_readKnownHosts` `if (!p) return []` → 缺省 = **不读任何文件**。
- 透传侧只带显式保存值: lib/hosts-model.js:273 `if (!c.knownHostsPath && s?.knownHostsPath) merged.knownHostsPath = s.knownHostsPath`。
- 结果链: entries=[] → 收到真实 host key 判 'unknown'(文件根本没读, 即便 known_hosts 里有 plain 记录) → verifyHostKey 抛 SshError → makeHostVerifier verify(false)(ssh-core.js:105-113) → ssh2 报 "Host denied (verification failed)" → _connectInner reject(ssh2 原文)。

**3. known_hosts 记录实况**(<home>/.ssh/known_hosts):
- 203.0.113.10 有 **3 条 plain(非 hashed)** 记录(第 14-16 行): ssh-ed25519 / ssh-rsa / ecdsa-sha2-nistp256; 另有 [203.0.113.10]:<ssh-port> 端口条目。
- hashed(|1|) 条目本机无; 插件原实现不支持 hashed(ssh-core.js:31 注释文档化局限)——本次一并补上(OpenSSH 默认 HashKnownHosts=no, 但开过的用户会中招)。

**4. 修复内容**(packages/dsh-ssh/src/ssh-core.js, plain JS, 无构建):
- `_readKnownHosts`: 缺省 `this.cfg.knownHostsPath || defaultKnownHostsPath()`(新导出函数 = `path.join(os.homedir(),'.ssh','known_hosts')`); 文件 ENOENT → [] 视为无记录(OpenSSH 同义), 其它读错误仍抛 known-hosts。
- `_connectInner` error handler: 若 `this.verifyError` 已设置, 以其 stage/message 覆盖 ssh2 原文(unknown/mismatch 分类保真, UI 不再显示 ssh2 库内文案)。
- `parseKnownHosts` / `checkHostKey`: 支持 OpenSSH hashed 条目 `|1|<saltB64>|<hashB64>`(host_hash = HMAC-SHA1(key=salt, msg=host), node:crypto), hashed 命中后才比较 key。
- 测试: test/ssh-core.test.js +6(hashed 解析/匹配、defaultKnownHostsPath、ENOENT→[]、makeHostVerifier 分类保真)。

**5. 验证证据(命令+输出)**:
- 仓库直连复现(临时脚本 <repo>/.agents/tmp/repro.mjs, 已清理; import src/ssh-core.js 用与 settings.yaml 完全一致的 cfg):
  - 修复前: `testConnection(无 knownHostsPath) => {"ok":false,"error":"Host denied (verification failed)"}`(与 UI 报错一致)。
  - 修复后: `=> {"ok":true,"banner":"ok"}`; 显式 knownHostsPath 同样 ok; 远端 `hostname; uname -a` → `<remote-host> Linux 5.15.0-106-generic ...`。
- 重启 3090: Stop-Process 63940 → `dsh --profile dsh-ssh-dev --port 3090`(后台, 新 PID 62712); netstat 3090 LISTENING 属主 62712; Invoke-WebRequest http://127.0.0.1:3090 → HTTP 200。
- Typert 网关在线: `POST /api/ssh/listHosts`(payload {"args":{}}) → `{"ok":true,"value":{"hosts":{...},"revision":0,"writable":true}}` → bundle 已加载、dsh-ssh-hosts settings 读通(主机 dict 与 settings.yaml 一致)。
- 单测: `node --test test/*.test.js` → **pass 145 / fail 10**(新增 6 个全过; 10 个失败 = Windows path.sep 既有问题——stash 掉本次改动后基线仍 pass 139/fail 10, 与本修改无关)。

**6. 红线确认**: 未碰 PID 9604(3080 GUI); 未改 DSH core; 远端 203.0.113.10 仅连接测试(exec hostname/uname, 无任何写操作); 改动仅 packages/dsh-ssh/src/ssh-core.js + test/ssh-core.test.js + 本笔记; 临时脚本已清理。

**7. 剩余事项**: 用户在 3090 设置页**刷新后重测**(应显示 banner "ok")。首次信任(TOFU)流程未实现: 若目标主机在 known_hosts 无任何记录(且未显式 knownHostsPath/acceptNew), 仍会报 "unknown host key for ... (set acceptNew to accept)" —— 建议后续在设置页表单加"接受新主机密钥(acceptNew)"选项并持久化到 HostConfig(UX 决策, 本次未硬改)。




### A.13 修复: 新建会话选远程主机报 "resolveRemoteHome 返回异常" —— 网关 {ok,value} 响应未解包(2026-08-18, 子代理)

> 场景: 3090 服务新建会话 → 选工作区 → 远程主机页签 → 选 ubuntu 主机(203.0.113.10) → 报「读取远端目录失败: resolveRemoteHome 返回异常」。同主机"测试连接"已成功(A.11 修复后), 说明 SSH 连接/known_hosts 均正常, 问题只在目录浏览第一步 resolveRemoteHome。

**1. 定位过程(逐层排除)**:
- ssh-core 层: 直连脚本(import src/ssh-core.js, cfg 与 settings.yaml 完全一致)跑 pool.testConnection → ok; acquire → exec('echo $HOME') → {code:0, stdout:"/home/ubuntu"}; sftp.listDir('/home/ubuntu') → 54 项。连接层无问题。
- 服务层: 真实 SshRemoteService(cordis Context + 真实 SshPool + setStoredResolver) → resolveRemoteHome(hostId) 返回裸字符串 "/home/ubuntu"; listRemoteDir 返回裸数组(54 项)。服务层无问题。
- 网关层(根因): core dsh-api-gateway 把 host 方法返回值统一包装成 { ok: true, value }(成功)/{ ok: false, error }(业务失败):
  - host 端: <dsh-checkout>/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js:123-131(invokeRpc 返回 {ok:true, value: await this.invoke(...)})。
  - client 端: 同包 lib/client.js:258-265(client 侧 promise resolve 的形状 = {ok:true, value: parse(descriptor.result, ...)})。
- UI 层(病点): client.js 的 startBrowse(修复前 ~1181-1188)把 resolve 值当裸字符串判定 typeof home === 'string' && home.startsWith('/'); 实际收到的是对象 {ok:true, value:'/home/ubuntu'} → 判定失败 → 走 1187 分支 setError('读取远端目录失败: resolveRemoteHome 返回异常') —— 与用户看到文案逐字一致。注意此分支是 resolve 成功但形状不符, 不是 reject(reject 走 messageOf 会显示真实错误)。

**2. 根因结论**:
- host 服务返回裸值本身没错(remote.js 语义与 lib/typert-contribution.js 的 src-json codec 均无问题, 与 listRemoteDir/listHosts/createPlaceholder 一致)。
- 唯一错误: client.js startBrowse 遗漏了网关 {ok,value} 解包 → 把对象当裸字符串。同文件其它 handler(listInto/listHosts/adopt)均已按 response.ok / response.value 处理, 故只有目录浏览第一步报错, 后续 listRemoteDir 在真实网关下本就正常。

**3. 修复内容**(plain JS, 无构建; 保持既有"lib 为 canonical、client.js 内联同步"惯例):
- lib/typert-contribution.js 末尾新增导出纯函数 unwrapRemoteResponse / remoteResponseError, 注释标注网关出处(index.js:123-131, client.js:258-265)。
- client.js 在 CLIENT_TYPERT_REMOTE 后内联同签名副本(标注 keep in sync); startBrowse 改为: var resolved = unwrapRemoteResponse(home); if (typeof resolved === 'string' && resolved.startsWith('/')) listInto(host, resolved, []); else { setLoading(false); setError(remoteResponseError(home, t('loadDirFailed') + ': resolveRemoteHome 返回异常')); } —— 同时保留原有 fallback 文案, 且业务失败时优先透出真实 error.message(修复后 SshError 的 stage/message 不再被吞)。
- src/remote.js 未改动(服务端行为正确)。

**4. 回归测试**: 新增 test/remote-wire.test.js × 4(解包 ok:true 形状、null/裸值/失败形状、error 文案优先 fallback、host 裸值经网关 wrap→unwrap 往返且满足 startBrowse 判定条件)。

**5. 验证证据(命令+输出)**:
- 单测: node --test test/*.test.js → tests 159 / pass 149 / fail 10(新增 4 全过; fail 10 与 A.11 基线相同 = Windows path.sep 既有问题, 无退化)。
- 直连验证(临时脚本 .agents/tmp/, 已清理): [host] resolveRemoteHome bare value = "/home/ubuntu"; listRemoteDir bare count = 54; 模拟网关包装后 [client] 旧判定(裸值直判) = false(复现 bug 分支), [client] 修复后判定(解包) = true(走 listInto); listDir 解包 54 项前 5 项 .cache/.camoufox/.config/.docker/.local; 业务失败形状诊断文案透出真实 SshError message。

**6. 红线确认**: 未碰 PID 9604(3080 GUI); 未改 DSH core(仅只读引用网关源码定位); 远端 203.0.113.10 仅 exec/SFTP 只读操作; 改动仅 packages/dsh-ssh/lib/typert-contribution.js + packages/dsh-ssh/client.js + test/remote-wire.test.js + 本笔记。3090 服务未重启(由主代理统一验证)。

**7. 剩余事项**: 主代理重启 3090 后, 在新建会话 → 工作区 → 远程主机流程真机确认目录浏览; 若仍报错, 检查网关版本是否一致(本修复依赖 client 侧 promise resolve 形状 = {ok,value}, 该形状位于 core 网关, 升级上游时注意)。

---

### A.12 修复: dsh-ssh-dev(3090) 新建会话选工作区 -> "本地" tab 报「host.listDirectory needs the browse capability; the composed picker serves "native"」(2026-08-18, 子代理)

> 场景: http://127.0.0.1:3090(dsh-ssh-dev profile, PID 52700) 新建会话选工作区 -> 选"本地" tab -> 报「读取目录失败 - host.listDirectory needs the browse capability; the composed picker serves "native"」。对照: 用户日常 GUI(web profile, 3080, PID 9604) 本地目录浏览正常。任务书假设"web 有 browse capability、dsh-ssh-dev 缺"——该假设经查证不成立。

**1. 排查过程与关键证据**:
- `dsh --profile web --dump-config` 与 `dsh --profile dsh-ssh-dev --dump-config` 各存临时文件 diff: 静态组合几乎一致, 两边都只有一条 `directory-picker: @deepseek-ai/dsh-host-directory-picker-auto`(web dump 行 390-391 / dsh-ssh-dev dump 行 395-396), 均无独立 browse 条目; 差异仅为 web 多 trustedHosts patch、dsh-ssh-dev 多 @dsh-ssh/dsh-ssh。说明 dump-config 无法直接看出 browse/native 差异。
- 读 `@deepseek-ai/dsh-host-directory-picker-auto` 源码(<dsh-checkout>/node_modules/@deepseek-ai/dsh-host-directory-picker-auto/lib/index.js): 该包是运行时决议器, apply() 里按 boot 采样事实 `resolveDirectoryPickerBackend`(行 63-69) 选 browse/native, 再用 `loader.create` 动态挂载后端 + client 表面(行 117-139)。决议条件: `bindHost !== "127.0.0.1" -> browse`; 有 `SSH_CONNECTION/SSH_TTY -> browse`; `darwin/win32 -> native`(弹系统对话框); linux 无 zenity/kdialog 或无 DISPLAY -> browse。
- netstat 实证: 两个服务都监听 `127.0.0.1:3080/3090`, 同一 win32 主机, 无 SSH 环境 -> 两个 profile 的 host 决议结果都是 native(与任务书"web 是 browse"的推断相反), `dsh web` 是 `--profile web` 的硬编码别名(bin.js:19,91)。
- 客户端运行时实证: 抓两服务首页 `window.__DSH_BOOT__` 模块表, 两者都只含 `@deepseek-ai/dsh-client-ui-directory-picker-native`(web 第 38 项 / dsh-ssh-dev 第 39 项), 都没有 `...-picker-browse`; HTTP 探测 `/plugins/@deepseek-ai/dsh-client-ui-directory-picker-browse/client.js` 两服务均 404, native 均 200。运行时挂载的都是 native 表面。
- 错误出处: `@deepseek-ai/dsh-host-apiproxy/lib/index.js:3174-3180`(host.listDirectory 要求 capability.kind === "browse", 否则报 directory-picker-unavailable + 文案逐字一致); client-runtime 的 `ctx.workspaces.listDirectory` 直连此 API(dsh-client-runtime/lib/client.js:9965-9969)。

**2. 根因结论(不是缺包, 是插件本地 tab 依赖 browse capability)**:
- browse 官方包存在且版本齐全(dsh-host-directory-picker-browse + dsh-client-ui-directory-picker-browse 均为 0.1.0-rc.7, core node_modules 与 profiles/node_modules 都有), 它由 auto 包按决议动态挂载, 不是通过 plugin add 安装的 bundle 包(其 package.json 无 dsh.bundle/client 声明)。
- 真正差异在客户端 directoryFlow 槽的占用者: web(无 @dsh-ssh/dsh-ssh) 本地 tab 由 stock native picker(dsh-client-ui-directory-picker-native) 填充, 它 renderless 直接调 `ctx.workspaces.pickDirectory()` 弹系统对话框(不调用 listDirectory)-> 正常; 而 dsh-ssh-dev 装了我们的插件, `packages/dsh-ssh/client.js:1505-1549` 以 priority -1 覆盖 BOTH directoryFlow 槽并注册 DirectoryFlowCombined, 其本地 tab 的 listDirectory/createDirectory 走 `ctx.workspaces.listDirectory`(client.js:1531-1532) -> 命中 host.listDirectory 的 browse 检查 -> 报错。
- 即: host 两边都是 native, 但 web 端没人调 listDirectory; dsh-ssh-dev 端我们的插件调了 listDirectory 而 host 是 native -> 报 browse 缺失。

**3. 修复方案(按任务书第 5 步: 根因不是缺包 -> 报告机制与方案, 不硬改)**:
- 方案 A(推荐, 改 dsh-ssh-dev host 决议为 browse): 在 `<home>/.dsh/profiles/dsh-ssh-dev/cordis.patch.yml`(当前为 `[]`) 覆盖 directory-picker 条目 pin 为 browse 后端, 使 host.listDirectory 可用。参考 web-app 源码注释 "Mount -native or -browse directly in an overlay to pin the interaction"(dsh-web-app/cordis.patch.yml 行 87-91)。需要主代理确认后实施并重启 3090 验证。
- 方案 B(改插件本地 tab 降级): `packages/dsh-ssh/client.js` DirectoryFlowCombined 本地 tab 在 listDirectory 抛 browse 缺失时回退到 `ctx.workspaces.pickDirectory()`(系统对话框, 与 web 行为一致), 或先探测 capability。待主代理决策。
- 不建议直接 `dsh plugin add` browse 包: 该包无 bundle/client 声明, plugin add 不会把它挂进组合, 装了就白装(可先 `dsh plugin --profile dsh-ssh-dev add <pkg>@next` 试装, 预期 dump-config 无变化)。

**4. 验证证据(命令+输出)**:
- diff: `Compare-Object (gc dump-web.txt) (gc dump-dsh-ssh-dev.txt)` -> 差异集中在 web/dsh-ssh-dev 的插件与 trustedHosts patch 上, directory-picker 两侧同为 auto。
- netstat: `TCP 127.0.0.1:3080 LISTENING 9604` / `TCP 127.0.0.1:3090 LISTENING 52700`。
- 模块表: web 39 项 / dsh-ssh-dev 39 项, picker 相关均为 picker-native; `/plugins/@deepseek-ai/dsh-client-ui-directory-picker-browse/client.js` -> 两服务均 404, native 均 200。
- 包版本: dsh-host-directory-picker-auto/browse/native + 两个 client-ui 包, core 与 profiles 层均为 0.1.0-rc.7。
- 根因代码出处: auto lib/index.js:63-69(决议)、117-139(动态挂载); api-proxy lib/index.js:3174-3180(报错); native client lib/client.js:22-51(renderless pick, 不调 listDirectory); 本项目 client.js:1505-1549(覆盖槽+本地 tab 依赖 listDirectory)。

**5. 红线确认**: 未碰 PID 9604(3080 GUI, 仅只读 HTTP GET 探测首页与插件路径); 未改 DSH core(只读引用); 远端 203.0.113.10 未连接; 未修改任何代码/配置(方案待主代理决策); 3090 服务未重启。临时文件 dump-*.txt / boot-*.txt 位于 .agents/tmp/, 已清理。

**6. 剩余事项**: 主代理决策方案 A(profile patch pin browse)或方案 B(插件本地 tab 降级到 pick), 实施后由主代理重启 3090 验证: 新建会话 -> 工作区 -> 本地 tab 目录浏览不再报错。

---

### A.14 修复: DirectoryFlowCombined 本地 tab 在 browse 能力缺失时回退官方原生系统对话框(2026-08-18, 子代理)

> 承接 A.12: A.12 判定"任务书假设 web 有 browse、dsh-ssh-dev 缺"不成立, 两个 profile 的 host composed picker 其实都只 serve "native"; dsh-ssh-dev 报错只是因为我们的插件 DirectoryFlowCombined 本地 tab 直接调 ctx.workspaces.listDirectory, 而 host 侧 listDirectory 强制要求 browse 能力。本条目为最终修复(方案 B 落地 + 统一重启验证)。

**1. 根因机制(出处行号, 本轮复核确认)**:
- error 产生端: @deepseek-ai/dsh-host-apiproxy/lib/index.js:3174-3191(host.listDirectory 检查 capability.kind !== "browse" 后返回 {code:"directory-picker-unavailable", message:"host.listDirectory needs the browse capability; the composed picker serves \"native\"", details:{capability:"native"}}); 同文件 3192-3204 host.createDirectory 同样门槛; host.pickDirectory(3152-3173) 门槛相反(要求 native, 弹系统对话框)。
- client 传递: @deepseek-ai/dsh-client-runtime/lib/client.js:9954-9958(pickDirectory → api.host.pickDirectory, resolve 为选中路径或 null)/ 9965-9969(listDirectory → DirectoryBrowseError)/ 9976-9983(createDirectory); DirectoryBrowseError 定义在 9799-9806(err.rpcError 携带业务码, err.message 前缀 "directory browse failed:")。
- 官方 native picker 为什么不报错: @deepseek-ai/dsh-client-ui-directory-picker-native/lib/client.js:22-51 是 renderless 组件, 按 open 上升沿恰好调一次 pickDirectory()(行 41-48: path===null → onCancel, 否则 onPicked, reject → onError), 从不调 listDirectory。
- 我们的病点: packages/dsh-ssh/client.js DirectoryFlowCombined(以 priority -1 覆盖 conversation.hero.workspace.directoryFlow + sidebar.workspaces.directoryFlow 双槽)本地 tab 的 listDirectory/createDirectory 走 ctx.workspaces.listDirectory/createDirectory(injectedFlow) → 首屏 list(undefined) 即命中 host browse 门槛 → UI 报「读取目录失败 — host.listDirectory needs the browse capability…」, 本地 tab 完全不可用。

**2. 决策: 方案 B(插件本地 tab 降级), 不采用方案 A(profile patch pin browse)**:
- 方案 A 需在 <home>/.dsh/profiles/dsh-ssh-dev/cordis.patch.yml 覆盖 directory-picker 后端 pin 为 browse —— 这改变的是 host 交互模型(把"系统对话框"换成自绘浏览树), 且依赖 web-app 内部 overlay 写法, 对用户 GUI 习惯(系统对话框选目录)不友好; 换一台 linux 主机时决议又变 browse, 方案 A 会造成行为不一致。
- 方案 B 只动插件: 本地 tab 在探测到 browse 缺失后回退官方原生对话框(ctx.workspaces.pickDirectory), 与"本地工作区行为完全不变"的硬约束(agents.md §2)吻合, 也符合任务书推荐的第 b 条检测路径(首次 listDirectory 失败且错误含 "needs the browse capability" → 回退并记住状态)。全局可移植: host 决议 native 或 browse 都成立(browse 时走原列表 UI, native 时走系统对话框)。

**3. 修复 diff 摘要**(plain JS/ES5, 无构建; 沿用"lib 为 canonical、client.js 内联同步"惯例):
- lib/typert-contribution.js 追加导出纯函数 isBrowseCapabilityError(err): 命中条件 = rpcError.code === "directory-picker-unavailable" 或 rpcError.message/err.message 含 "needs the browse capability"(覆盖 DirectoryBrowseError 与裸 Error 两种形状; 非对象/裸串/null/undefined 一律 false)。注意初版把三条件写成 a || b || (rpc && ...) 会在整式求值为 null 时返回 null(断言 null !== false 失败), 已改为先短路 if (rpc && rpc.code === ...) return true 再比文案, 恒返回 boolean。
- client.js 六处改动: ① 内联同签名 isBrowseCapabilityError(标注 keep in sync); ② SSH_ZH/SSH_EN 增 local.nativeHint/local.nativeAgain 两条文案; ③ LocalFlowBody 增 nativeMode state + nativeFiredRef + fireNativePick()/enterNativeMode()(fireNativePick 对齐官方 native picker: 取消直接调 owner cancel, 不能经 reportOutcome 包装, 否则 cancel 的 reported 自检短路关不掉对话框; 选中 reportOutcome(onPicked, path); 失败 reportOutcome(onError, failureText)); ④ list() 失败路径先判 isBrowseCapabilityError → enterNativeMode(不再展示错误); ⑤ 挂载 effect: nativeModeRef.current 为真时跳过 listDirectory 直接弹系统对话框(记忆状态跨页签切换/重挂载保持, 满足"后续不再尝试 listDirectory"); ⑥ nativeMode 渲染分支 = 仅提示 + 再次选择 + 取消, 不渲染目录列表与"新建文件夹"(系统对话框无法新建, 与官方 native picker 一致, createDirectory 在 native 态从不被调用)。DirectoryFlowCombined 持有 nativeModeRef = React.useRef(false); injectedFlow 增 pickDirectory: () => ctx.workspaces.pickDirectory()。
- 未改动: startBrowse 的 A.13 解包修复(另一子代理交付)、src/remote.js、DSH core、profile 配置。

**4. 回归测试**: test/remote-wire.test.js 追加 3 例(import 增 isBrowseCapabilityError): DirectoryBrowseError 形状命中; createDirectory(native host)/普通 Error/其他业务码/裸串/null/undefined 判否; 仅 message 无 rpcError 也命中。全套 node --test test/*.test.js → tests 162 / pass 152 / fail 10, fail 10 与 A.11/A.13 基线相同(Windows path.sep 既有问题: placeholder/router/search 相关, 与本改动无关), 无退化(149 基线 + 3 新增 = 152)。

**5. 验证证据(统一重启, 远端修复一并生效)**:
- 停 PID 52700(3090 dsh-ssh-dev) → 同方式重启: Start-Process node.exe bin.js --profile dsh-ssh-dev --port 3090($env:DSH_HOME=<home>/.dsh, 日志覆盖 profiles/dsh-ssh-dev/web.log / web.err.log, 新 PID 写 web.pid)。新 PID 45220, web.log="dsh web: http://127.0.0.1:3090", web.err.log 0 字节, netstat 3090 LISTENING 45220。
- Invoke-WebRequest http://127.0.0.1:3090 → 200; 抓 /plugins/@dsh-ssh/dsh-ssh/client.js(79391 字节)grep 特征串: isBrowseCapabilityError / local.nativeHint / needs the browse capability / pickDirectory 全部 True(新代码已进入交付 bundle)。
- Typert 网关: POST /api/ssh/listHosts, 请求信封需为 {type:"client-request", rpcId, method:"ssh/listHosts", payload:{args:{}}}(裸 {} 被拒: 先报 bad-request 缺 rpcId/method, 再报 "Remote payload must contain exactly one plain-object args field")→ {"result":{"ok":true,"value":{"hosts":{00000000-0000-4000-8000-000000000000:{name:"ubuntu",host:"203.0.113.10",port:22,user:"ubuntu",auth:{type:"key",privateKeyPath:"<home>/.ssh/id_ed25519"}},"secrets":[],"revision":0,"writable":true}}}。
- 红线: 未碰 PID 9604(3080 GUI, 存活); 未改 DSH core; 远端 203.0.113.10 未连接。

**6. 剩余事项**: 用户在 GUI(需刷新/重连 3090 页面)真机验证两个 tab: ① 本地 tab → 自动弹系统目录选择器(若 host 为 native), 选中或取消行为正常, 不再报 browse 能力缺失; ② 远程主机 tab → 目录浏览 + 占位工作区创建(依赖 A.13 修复)。host 决议为 browse 的环境(未来 linux 部署)本地 tab 仍走原列表 UI, 两模式共存。

---

### A.15 修复: 远程占位工作区显示名 = 远端路径 basename(不再显示 base64 编码段)(2026-08-18, 子代理实施 / 主 Agent 补记)

> 子代理在写报告阶段中断, 代码与测试已落地并经主 Agent 验证, 本节由主 Agent 依据代码注释(src/remote.js:245-251)与实测结果补记。

**1. 现象与根因**:
- 现象: 真机通过远程主机 tab 创建工作区成功, 但工作区名显示为 `L2hvbWUvdWJ1bnR1L29wZW5jb2RlLWFwaQ` = base64("/home/ubuntu/opencode-api"), 不可读。
- 根因: 官方 workspace.create 的 wire 只收 { path }(dsh-host-apiproxy workspaceCreateRequestSchema), title 默认取 basename(占位目录); 而占位目录名是 src/router.js mapRemoteToLocal 的 base64 编码段 → 编码段直接成了显示名。

**2. 修复(src/remote.js createPlaceholder:253-279 + src/placeholder.js)**:
- 创建占位目录后, 直接走 workspaceRegistry.create(localPath, title), title = placeholderDisplayName(remotePath)(远端路径 basename, 如 opencode-api)。
- 命名决策: 不带主机前缀 —— 创建工作区记录不强制 title 唯一, 与本地同名目录的既有惯例一致。
- 官方流程随后 adopt 同一路径时 resolveByPath 命中既有记录(created:false), title 保持不变, 不会被覆盖回编码段。
- 历史产物自动修复: 仅当记录 title 恰为编码段(旧 bug 签名)时才 setTitle 重命名; 用户手动改过的 title 不动。registry 不可用时降级为旧行为(不写记录, 不阻塞占位创建)。

**3. 回归测试与验证(主 Agent 复核)**:
- test/m4-placeholder.test.js 与 test/remote.test.js 追加回归用例; 全套 node --test test/*.test.js → tests 166 / pass 156 / fail 10(基线 152 + 新增 4 = 156; fail 10 与 A.11/A.13/A.14 相同, 为 Windows path.sep 既有的 tools-search 等问题, 与本改动无关), 无退化。
- 服务已由子代理重启: 新 PID 43508(3090), 主 Agent 复核 HTTP 200、web.err.log 0 字节、web.pid=43508。

**4. 剩余事项**: 用户在 3090 上删除旧的 base64 名工作区记录并重建(或对同一路径再走一次创建流程, 触发历史产物自动修复)。


---

### A.19 调研: 远端工作区在 PTC(code-mode / run_code)形态下的支持现状(2026-08-19, 审计子代理)

**范围与方法**: 纯审计 + 实测; 未改任何代码、未重启服务(3090/9604 未触碰); 以 git HEAD cdf9291 为审计基准(工作区 tools.js/index.js 有他方修改, 不计入); 实测在本地 DSH 宿主进程的 code runtime worker 内完成, 未连接远端主机。core 只读参考: <dsh-checkout>(下文 core)。

**Q1 run_code 工具体系与 scope 注册表 —— 确认经过**:
- run_code 由 @deepseek-ai/dsh-tools 提供: createRunCodeTool(core dsh-tools/lib/index.js:1083); 保留名 RUN_CODE_NAME(:893); register() 拒绝同名注册/遮蔽(:2769); view() 在 mode 非 native 时注入 run_code(:2863)。
- 代码运行时: @deepseek-ai/dsh-code-runtime(抽象缝 CodeRuntime, lib/index.js:148-152) + @deepseek-ai/dsh-code-runtime-worker-thread(worker-thread 实现)。
- tools.xxx 解析链条(全过 scope 注册表): createRunCodeTool 以 registry.schemas(exec.agent) 构建绑定(:1314-1321, 排除 run_code 自身 :1316); schemas(scope) → view(scope).visible(:2907-2908); view() 内 own 层注册遮蔽 inherited(:2859-2862), scoped 工具遮蔽全局同名工具; 绑定调用经 registry[TOOL_RUNTIME_SCHEDULER].prepare(input)(:1220, :1271), input 带 agent: exec.agent 与 parent: exec.token(:1211-1219); 调度 → resolveExecution(name, exec.agent, nested=true)(:2895-2900) → 与原生调用同一执行管线(scope guards/restrictions 等)。
- 结论: **方案⑤(agent scope 遮蔽)对 code-mode 同样生效** —— SDK 的 tools.xxx 与原生调用共享同一 scope 注册表与调度管线。code 模式唯一额外约束: 模型直接(非嵌套)调用仅放行 run_code(collapse, :2982-2984)。

**Q2 code preset 六工具 —— 存在**:
- core config/agent-presets/code/agent.cordis.yml: tool-bash(:51-53, win32 上 disabled)、tool-pwsh(:55-57)、tool-fs(:63-64)、tool-fs-search(:66-69)、tool-presentation mode: code(:259-262); preset.yml name "PTC 模式"。即 standard 全部能力 + code 呈现。
- 六工具注册名与出处: read(333)/write(604)/edit(749)/read_image(952)(core dsh-tool-fs/lib/index.js); glob(775)/grep(1083)(core dsh-tool-fs-search/lib/index.js); bash(260)(core dsh-tool-bash/lib/index.js)。
- 策略(a)下的实际工具面: 插件 packages/dsh-ssh/tools.js 现注册七个同名工具 bash/read/write/edit/read_image/glob/grep(:447/511/577/637/693/749/798), 本地分支委托 ctx.tools.get(name)(:438), 远端分支走 SSH(src/remote.js / src/search.js)。但 standard-ssh preset(packages/preset-standard-ssh/preset/preset.yml, "标准 SSH 模式" order 3)是 native 模式、无 tool-presentation 行 → run_code 不注入, PTC 形态对远端会话当前不可用; 而 core code preset 用的是本地六工具。当前仓库不存在 "SSH 六工具 + code 呈现" 的组合 preset(grep tool-presentation/mode: code 在 packages/dsh-ssh 与 preset-standard-ssh 下 0 命中) → 策略(a)需要补一个组合 preset 才能让 PTC 形态覆盖远端。
- 另注: tools 服务配置 mode 默认 native(core dsh-tools/lib/index.js:2556-2560, defaultMode :2593); 若部署全局设 mode: code/both, 所有会话(含 standard-ssh)都会暴露 run_code, SDK 面同样按 scope 解析为可见工具(即 SSH 工具)。

**Q3 执行位置与沙箱 —— 本地 worker, 可绕过(node:fs 实测成功)**:
- 程序本体在**本地 worker thread** 执行: new Worker(WORKER_PATH, {workerData, env: {}, execArgv: [], resourceLimits:{maxOldGenerationSizeMb}, stdout:true, stderr:true})(core dsh-code-runtime-worker-thread/lib/index.js:737-752); 程序以 new AsyncFunction(...) 编译执行(worker.cjs:884-887), 绑定经消息端口桥接(worker.cjs:806-845), 端口入站全部重校验(host index.js:532-571)。
- 模块总文档明示 "This is containment, not a security boundary: model code has bash-equivalent trust"(index.js:451-457)。**无模块白名单、无 import/require 拦截、无自定义 loader、无 cwd/import map**。
- **实测**(在本 DSH 宿主进程 code runtime 内执行 run_code): await import('node:fs') 直接写文件成功(写入 <repo>/.agents/tmp/ptc-bypass-test.txt, 已清理); 读任意本地绝对路径成功(如 <home>/.dsh/settings.yaml 内容可读出), 完全不受工具层 path 路由影响; await import('node:child_process') execSync 成功; worker 的 process.env 为空(env:{} 生效, envCount=0)。
- 结论: **PTC 下模型可用 node:fs / node:child_process 在本地执行文件操作与进程, 绕过工具层 → 绕过 SSH 路由, 一致性缺口成立**。这是 core 设计内的隔离边界(worker-thread = containment only), 插件层无法拦截。

**Q4 cwd 语义 —— 宿主进程 cwd, 与工具层分叉**:
- CodeRunRequest 无 cwd 字段(core dsh-code-runtime/lib/types/types.d.ts:70-86 仅 program/bindings/signal); worker 继承宿主进程 cwd。
- **实测**: code runtime 内 process.cwd() = <home>(本 harness 宿主启动目录) ≠ 会话工作区(<repo>); 相对路径按宿主 cwd 解析(agents.md 在 worker 内 not found); child_process 子进程同 cwd。
- 工具层对照: bash 的 cwd 来自 exec.agent?.session.header.cwd(core dsh-tool-bash/lib/index.js:173-178); 远端占位 cwd(remoteRoot()/<hostId>/<base64url>, 插件 src/router.js:12-16, 46-50)在 code runtime 里只是普通字符串。→ 占位 cwd 下 run_code 内相对路径与 child_process 全部按**本地宿主**解析/执行, 与工具层(远端)语义分叉; 模型若在程序内用相对路径(node:fs)会落在本地宿主目录而非远端。

**Q5 支持矩阵与修复建议**:

| 工具路径 | PTC(core code 呈现)下现状 | 依据 |
|---|---|---|
| tools.bash/read/write/edit/read_image/glob/grep(SDK 子调度) | ✓ 机制成立: 经 scope 注册表路由, 与原生调用同一管线; 组合 preset 下即 SSH 六工具 | Q1 链条; tools.js 七同名工具 |
| 现成 "远端 + PTC" 会话 | ✗ 当前无组合 preset; standard-ssh 是 native 模式(无 run_code), core code 是本地六工具 | Q2 文件勘察 |
| import('node:fs') / node:child_process(程序内) | ✗ 本地执行, 绕过工具层与 SSH(一致性缺口, core 设计内) | Q3 实测 |
| process.cwd() / 相对路径 / 子进程 cwd(程序内) | ✗ = 本地宿主 cwd, 非会话/远端 cwd; 与工具层(按 session.header.cwd 路由)分叉 | Q4 实测 |
| 背景任务(tool-jobs) | run_code 子调度可触发远端 job(job 控件在 preset 内), 未实机验证 | 推理 |

修复建议(只调研不实施):
1. **组合 preset(推荐、零 core 改动)**: 在 packages/preset-standard-ssh 基础上加 tool-presentation 行(mode: code), 发布为"标准 SSH 模式(PTC)"。scope 注册表机制已支持, 七 SSH 工具自动成为 SDK 工具面 → 这是让 PTC 形态远端会话可用的最小路径。
2. **cwd 对齐(需 core, 仅作上游 RFC)**: 程序级 cwd 与工具层分叉是 core 行为(CodeRunRequest 无 cwd 字段)。若要让 run_code 内相对路径跟随会话/远端 cwd, 需 core 扩展(注入 cwd/chdir)——违反硬约束(DSH core 零修改), 不实施; 不阻塞, 因为受管文件操作应走 tools 子调度(天然带 session cwd)。
3. **node:fs 绕过(记录为已知边界)**: core 设计内边界("bash-equivalent trust"), 插件无法拦截(worker 由 core 宿主生成)。缓解: 在组合 preset 的系统提示/SDK 说明中明确"程序内 node:fs / node:child_process 操作的是本地文件系统; 远端文件一律走 tools.read/write/bash"; 或上游将 code runtime 迁移到更严格沙箱(超出本项目范围)。
4. 组合 preset 落地时核对: 七 SSH 工具面完整(tools.js:447/511/577/637/693/749/798); code 呈现下 wireSchemas 仅暴露 run_code(:2722-2725), sdkSchemas 剔除 run_code 自身(:2911-2921), 其余工具全量出现在 SDK 内。

**出处汇总**: 本节约 30 处 core 行号(见上文各问答) + 3 组实测(run_code worker 内 node:fs 写入/读取、process.cwd()、process.env 为空)。实测探针文件已清理(.agents/tmp/ptc-bypass-test.txt 已删除); 未触碰远端主机 203.0.113.10 与 3090/9604。
---

### A.17 审计+实测: 远端 bash 后台任务(run_in_background / jobs)现状与差距(2026-08-19, 子代理, 纯审计不实施)

> 任务: 审计 packages/dsh-ssh 远端 bash 后台任务行为 + 官方 jobs 语义对照 + ubuntu 真机实测 + 差距清单与修复建议(只出方案不实施)。审计基准 git HEAD cdf9291(tools.js 存在另一子代理未提交的结构重构, 仅提取常量/改名, 未触及远端 bash 后台分支, 见其 diff 摘要)。源码出处均为本地行号。

**1. 现状行为(代码事实, HEAD cdf9291)**

- 远端分支**硬拒绝**: packages/dsh-ssh/tools.js bash execute 远端分支(route.kind === 'remote')在 args.run_in_background === true 时直接 throw: "[@dsh-ssh/dsh-ssh] run_in_background is not supported for remote workspaces yet (M5); run the command in the foreground"。**没有 nohup / 持久通道 / tmux 任何后台化机制; 不退化为前台; 直接报错**。这是 M5 待办 "后台任务(tool-jobs)需远端化" 的现状。
- 广告不一致(UX 坑): bash 的 description(bashDescription, tools.js 行 82-85)与参数 schema(行 447, backgroundEnabled = config.enableRunInBackground ?? true 恒为 true)照抄官方广告 "Set run_in_background: true ... job_output / job_kill"; 模型在远端工作区会看到该参数被广告, 调入才抛错。
- job_output / job_list / job_kill(官方 @deepseek-ai/dsh-tool-jobs)在 standard-ssh preset 中**保留**: packages/dsh-ssh/preset/agent.cordis.yml 行 79-80 仍有 tool-jobs 行(未被 tools.js 同名替换)。它们走 host 平面 ctx.jobs 注册表, 不按 cwd 路由 → 在远端工作区可用但不产生任何远端 job: job_list 恒空; job_output / job_kill 对远端任务报"找不到该 job"。
- 远端前台通路本身正常: route.kind === 'remote' 时 conn.exec(cmd, { cwd: remoteCwd, timeoutMs }) 正常返回; timeoutMs 缺省 60s(REMOTE_EXEC_DEFAULT_TIMEOUT)。

**2. 官方 jobs 语义对照(只读)**
- 本地后台 = jobs.start({ kind:'bash', label, owner, run:{ cancel, done, readOutput } })(@deepseek-ai/dsh-tool-bash/lib/index.js 行 403-427, 空 jobs 时抛 "load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs"): cancel = () => proc.kill()(本地进程 SIGTERM); done = proc.done.then(processOutcome)(completed 带 "exit code: N" detail / killed 带 "signal: X" detail, 行 21-30); readOutput = 增量读(丢读时报 spill path, 行 85-98)。bash 工具返回 { kind:'background', jobId }。
- 三控制器(@deepseek-ai/dsh-tool-jobs/lib/index.js): job_output 走 ctx.jobs.read + 可选 wait=true / timeout_ms(ctx.jobs.wait, 行 270-281); job_list = ctx.jobs.list(exec.agent)(行 298-301); job_kill = ctx.jobs.kill(id, agent, reason), 返回 cancellation-requested | already-finished(行 340-348)。公共状态机: running / stopping / completed / killed / failed(PUBLIC_TASK_SCHEMA 行 28-62)。
- 关键差异: 官方后台句柄是**本地 spawn 进程**(kill/读流/done 都是进程句柄操作); 插件远端对应的应是 ssh2 exec 通道或远端 OS 进程, 无现成句柄抽象(ssh-core.js SshConn.exec 只做一次性完整执行: 收集输出到 Buffer, timeout 用 setTimeout + stream.close, 无 kill/增量读/done)。

**3. 真机实测(ubuntu 203.0.113.10; 仅 /tmp/dsh-ssh-verify-jobs; 已清理; 脚本 .agents/tmp/verify-jobs*.mjs 已删)**

- 层1 工具路由实测(最小 fake ctx 真实加载 tools.js apply, 真实 SshPool; 占位 cwd 经 router.mapRemoteToLocal 生成, routeByCwd 判定 remote 正确):
  - T1: run_in_background:true + 远端 cwd → **抛错** "[@dsh-ssh/dsh-ssh] run_in_background is not supported for remote workspaces yet (M5); run the command in the foreground"。与代码一致, 实测确认真机即现状。
  - T2: 前台远端 exec → 正常 { kind:'foreground', exitCode:0 }。cwd 不存在时 buildRemoteCommand 的 "cd '<cwd>' && cmd" 使 cd 失败短路, 后续用 ; 串联的命令仍执行而整链 exitCode 变 1(既有行为, 与本审计相关度低)。
  - T3: 前台 + timeoutMs:2000 + "sleep 6" → { kind:'foreground', timedOut:true, exitCode:null }: timeout 语义正常。但超时(客户端 stream.close())后 2.7s 查远端 "sleep 6" **仍在运行** —— 与本地 executor "超时杀进程"语义不同(远端残留进程, 输出无人收)。
- 层2 后台化机制可行性(ssh2 SshConn 直连实测, 三轮):
  - **单命令异步形式可靠**: "nohup bash -c 'sleep 5' >/dev/null 2>&1 & echo $!" → ~100ms 快速返回, 后台进程存活并完成写文件(验证过 a.txt / d.txt)。加显式 </dev/null(Eb)、setsid + disown(Ec)均 ~100ms 快速。
  - **链式异步形式不可靠**: "mkdir -p X && nohup bash -c 'sleep 4' ... & echo $!" → 挂到 sleep 4 完成才返回(第二轮 4.3s / 第三轮 C1 4.2s; 第一轮同形 10s 超时)。机制: bash 把整个 AND-OR 链当异步作业, 子 shell 前台等待链尾命令(nohup → exec bash -c → wait sleep), 通道被该子 shell 持有 → sshd 不关通道 → conn.exec 不 resolve。**与 ssh-core.js buildRemoteCommand 的 "cd '<cwd>' && cmd" 组装方式直接冲突**: 后台命令若外包 cd 前缀即变链式后台, 不可靠。
  - 通道关闭不杀远端进程: 对 "sleep 20" 的 exec 通道立即 stream.close() → 2s 后进程仍存活(T4b); 超时 close 后 sleep 6 亦残留。远端后台任务可脱离通道存活(结果文件写成功), 但输出无人收集(写向已关通道, 终会 EPIPE)。
  - kill 语义陷阱: "echo $!" 的 PID 在单命令形态 = nohup→exec 的 bash(pstree: bash(pid)---sleep(child)); "kill -TERM <pid>" 只杀 bash, **其子 sleep 仍存活**(grep -c '[s]leep 25' = 1)。⇒ job_kill 若只 kill $! 的 PID 必然漏杀进程树。
  - 输出收集: 后台命令重定向日志文件后, 前台 exec cat 日志可拿到结果(等价 job_output 的轮询实现); nohup 任务写 a.txt / d.txt 均验证成功。

**4. 差距清单**

| 行为 | 本地(官方) | 远端现状 | 差距 |
| --- | --- | --- | --- |
| run_in_background:true | jobs.start 返回 {kind:'background', jobId} | 直接抛错拒绝 | 完全缺失(M5 待办) |
| 后台进程脱离调用存活 | spawn 常驻 | nohup 可行(实测验证) | 无实现 |
| job_output 读输出 | ctx.jobs.read 增量 + 丢失(带 spill path)通知 | 不可用(无 job 可读) | 缺失 |
| job_list | ctx.jobs.list(agent) | 恒空(无远端 job 注册) | 缺失 |
| job_kill | proc.kill() SIGTERM | 无句柄; 即便有 PID, kill 单 PID 漏杀子进程(实测) | 缺失 + 语义陷阱 |
| 超时语义 | 本地 executor 超时杀进程 | 只关客户端通道, 远端进程残留(实测) | 不一致(既有, 建议一并决策) |
| 参数广告 | description/schema 广告 run_in_background | 照抄官方广告但执行拒绝 | 不一致(建议收敛) |

**5. 修复建议(只出方案不实施; 结合现有 ssh2 连接池 exec 架构)**

- 方案1 nohup + PID/日志文件(最贴合"远端零安装 + exec 即焚 + 连接池"): execute(run_in_background) 时组装**单命令异步**远端命令, 且必须把 cd 移进 bash -c 内(实测红线, 否则链式后台挂起): "nohup bash -c 'cd <cwd> && <cmd>' ><jobdir>/<jobid>.log 2>&1 </dev/null & echo $!"。返回 {kind:'background', jobId}; kill 用 setsid 起步 + "kill -TERM -<pgid>" 或 pkill -P 递归(实测红线: 单 PID 漏杀); job_output 用日志文件游标增量读; job_list 由插件自持 Map<jobId,{pid, logPath, cwd, startedAt}>。难点: 与官方三控制器对接。
- 方案2 持久通道: 每后台任务保留一条 ssh2 channel 常开 + 内存缓冲增量读。优点: 输出实时、无额外远端进程; 缺点: 连接池按 hostId 复用单连接, 需每任务独立 channel 生命周期管理; 实测表明"蓄意不关通道"的进程即 Ed 形式会占用通道语义(依赖链式行为, 脆弱); 插件进程重启后所有任务失控; 复杂度高于方案1。
- 方案3 tmux: 远端需安装 tmux, 违反硬约束"远端零安装", 否。
- **推荐方案1(b)**, 与官方契约对齐的接法: 在 execute 里直接 jobs.start({ run:{ cancel: 远端 kill 树, done: 轮询日志/pid 探测得到 completed|killed + exit code, readOutput: 日志增量读 } }), 返回官方同形 {kind:'background', jobId}; 三控制器零改动(它们只见 ctx.jobs 注册表)。三处必修: ① 后台命令单命令异步组装、cd 内嵌(实测); ② kill 必须覆盖进程树(实测); ③ run_in_background 广告需与实现同步(远端分支不可用时收敛描述/schema, 或实现后开放)。
- 遗留小项: 前台 timeout 的远端进程残留(差距表末行)建议本期一并决策(超时后补发一条远端 kill 命令的代价与收益)。

**6. 红线与清理**: 未改任何代码/配置; 未重启 3090(PID 45220)与 9604(3080 GUI); 远端仅操作 /tmp/dsh-ssh-verify-jobs(已 rm -rf 并确认 ALL-CLEAN); 本地临时脚本 .agents/tmp/verify-jobs.mjs / verify-jobs2.mjs / verify-jobs3.mjs / verify-cleanup.mjs 与 $TEMP/dsh-ssh-verify-root 已删。终检扫描到远端残留 4 个 sleep 进程(PID 408714/408740/408758/427472, 命令行与本次测试不匹配, 疑似其他子代理的真机测试), **未触碰**, 交由对应子代理自行清理。


### A.18 实施: 方案⑤ preset 无关的 SSH 工具路由(agent/created 钩子 + scope 遮蔽)(2026-08-19, 子代理)

> 任务书指定回写 A.16; 但并发子代理已占 A.16(PTC/code 模式审计)与 A.17(远端后台任务审计), 按 agents.md §6.4「冲突时保留双方条目并标注」纯追加为 A.18, 不覆盖他人结论。实现基于决策 notes/decisions/2026-08-19-agent-created-tool-shadowing.md 与调研 notes/research/preset-independent-tool-routing.md; 现状代码 packages/dsh-ssh(plain JS/ESM, 无构建)。

**1. 实现摘要(文件 / 导出 / 关键行号)**

- **packages/dsh-ssh/tools.js(重构, 六工具路由实现不变, 仅拆注册形态)**:
  - `export const ROUTED_TOOL_NAMES`(L411) = ['bash','read','write','edit','read_image','glob','grep']; `export const ROUTED_TOOL_MARKER`(L413, Symbol, 注册时打在定义上, 调试/验证用)。
  - `buildRoutedToolDefinitions(ctx, config)`(L415): 纯构建七个同名工具定义(不注册), 内含 `delegateLocal`(L438: `ctx.tools.get(name)` 无 scope 委托 host 全局官方实现)。
  - `export function registerRoutedTools(agentCtx, names, config)`(L859): 按 names 注册到 agentCtx.tools, 未知名字抛错, 注册前打 ROUTED_TOOL_MARKER。
  - `export function apply(ctx, config)`(L875): preset 挂载路径(standard-ssh 回退)= `registerRoutedTools(ctx, ROUTED_TOOL_NAMES)` + log。
  - **关键修复**: escalation 判定由 `ctx.shell?.sandboxMode` / `ctx.fs?.sandboxMode` 改为 `ctx.get('shell')?.sandboxMode` / `ctx.get('fs')?.sandboxMode`(L424-425)。原因: 方案⑤在 agent.ctx(无 inject)上调 registerRoutedTools 时, `ctx.shell`/`ctx.fs` 直接抛 cordis「cannot get property "shell" without inject」; `ctx.get(name)` 走 reflect 存储, 无需 inject。preset 路径行为不变(注入场景两者等价)。
- **packages/dsh-ssh/index.js(host 侧钩子)**:
  - `export function selectShadowNames(agent, names)`(L97): 策略 (a) 保守 —— 仅返回 agent 视图里已可见的名字(`agent.ctx.tools.get(name, agent) !== undefined`)。**scope key 即 agent 对象本身**(dsh-agent-loop `createScope(loopCtx, this)` → `agent.ctx[kScope] = agent`), 故 `get(name, agent)` = 该 agent 作用域视图(全局 + preset standing + 自身层), 无需 import dsh-scope。
  - `export function installToolRoutingHook(ctx, opts)`(L114): `ctx.on('agent/created', handler)`; handler 取 `agent.session.header.cwd` → `routeByCwd(cwd)`(src/router.js)判定; 本地 cwd → return(零影响); 远端 cwd → `selectShadowNames` 过滤后 `registerRoutedTools(agent.ctx, selected)`(agent 自身 scope 遮蔽, dsh-tools「scoped shadows global」)。**全程 try/catch 吞错告警** —— agent/created 是 emit 事件, 同步抛错会 veto agent 发布(dsh-agent types)。
  - `apply` 调用 `installToolRoutingHook(ctx)`(L146); import(L15)。

**2. 六条最小验证(逐项证据)**

1. **dump-config**: `node ...dsh/lib/bin.js --profile dsh-ssh-dev --dump-config` → EXIT=0, 组合树含 `- id: '@dsh-ssh/dsh-ssh'  name: '@dsh-ssh/dsh-ssh'` 行。
2. **时序**: dsh-agent/README.zh.md 源码 —— `agent/created` 在 setup 之后、driver 启动之前同步发出(首次工具调用前); 实测 scripts/verify-agent-created.mjs 中 `agents.create(...)` 返回后阴影已在 agent 视图(早于任何 `execute`)。
3. **遮蔽**: verify 脚本(真实 cordis 组合 dsh-base+dsh-ssh, 无 web-app)实测 —— 远端占位 cwd + standard preset 会话的 read/glob/grep 等 6 个 fs/search 工具带 ROUTED_TOOL_MARKER, 且 `read /etc/hostname` 返回 **<remote-host>**(远端 Ubuntu, 非本地 Windows)——证明走 SSH 路由而非官方本地实现。
4. **委托**: test/tools-local.test.js(本地分支 args/exec 按身份原样传递官方工具, 逐字节一致); 本地 cwd 会话实测阴影为空(无 marker → 官方工具)。硬约束 4 成立。
5. **子 agent**: 钩子监听器注册在 host 根 ctx(无 scope tag)→ dsh-scope `scopeTarget` 对未 tag 监听器返回 true → 接收**所有** agent(根 + 子); 子 agent 由 dsh-subagent `composeFrom` 走同一 dsh-agent-loop `createScope(loopCtx, this)` + `agent/created` 路径(调研笔记 Q3)。源码证据, 真机子 agent UI 确认归用户。
6. **code/minimal preset 不受影响**: 策略 (a) 仅遮蔽「已存在」名字 —— 实测 standard preset 在 Windows 上 `bash` 因 `tool-bash disabled: !!js process.platform === 'win32'` 不在视图, **未被补注册**(verify 输出「bash(Windows 禁用)未被补注册」); 单测 selectShadowNames 覆盖「minimal 只暴露 bash → 只遮蔽 bash」「get 抛错 → 返回空不抛」。code preset 同样只遮蔽其已注册的名字。

**3. 单测**: `node --test test/*.test.js` → tests 180 / pass 170 / fail 10。新增 test/tool-routing-hook.test.js 14 例全过; fail 10 与基线一致(Windows path.sep 既有问题, 本改动无关), 不劣化。

**4. 真机验证(3090)**: 停旧 PID 43508 → Start-Process 重启 → 新 PID **11452**(web.pid); HTTP GET http://127.0.0.1:3090 → **200**; web.err.log **0 字节**; web.log 尾部 `dsh web: http://127.0.0.1:3090`。插件经 symlink 指向仓库, 改动即时生效。scripts/verify-agent-created.mjs 作为可复用脚本级验证保留。

**5. 剩余事项**:
- 浏览器端最终确认(用户): 3090 新建会话选 **standard**(非 standard-ssh)preset + 远端占位工作区(如已建 opencode-api), 观察 read/glob/grep 走远端。
- **Windows 平台注意**: standard preset 在 Windows 暴露 `pwsh` 而非 `bash`(tool-bash 被 platform 禁用), 故「bash 走路由」在 Windows 上落在 fs/search 工具(read/glob/grep); macOS/Linux 上 bash 才在视图内并被遮蔽。
- 子 agent 真机 UI 一致性确认(源码已证, 待用户浏览器复核)。
- standard-ssh preset(回退路径)与 preset 挂载模式**未删**、保持不变。

---

### A.20 审计: 路径路由交叉方向与 sandbox 权限一致性(2026-08-19, 子代理两度中断, 主 Agent 源码核实补记)

> 编号说明: 本节原拟 A.18, 因并发追加 A.18 已被方案⑤实施占用, 按 §6.4 规则顺移为 A.20(A.16 缺号为并发占用遗留, 不补)。审计子代理两度中断(第二次中断于回写前), 远端实测脚本已清理未留证据; 以下结论全部由主 Agent 源码核实(tools.js / src/router.js / core dsh-tool-fs 行号), 交叉方向实机复测留待后续统一做。

**1. 路由语义(源码核实)**:
- 六工具按**会话 cwd** 路由: tools.js bash execute L478-482 `const cwd = exec.agent?.session?.header?.cwd; const route = routeByCwd(cwd); if (route.kind === 'local') return delegateLocal(...)`(read L542 / write L602 / edit L663 / read_image L718 / glob L772 / grep L824 同构, 行号为 HEAD cdf9291 基准, ⑤重构后略有漂移)。
- 交叉方向结论:
  - 本地会话 + 访问远端占位路径 → route=local → delegateLocal 委托官方实现, 占位目录当普通本地目录读写(占位目录本就存在于本地, 行为自洽) ✓
  - 远端会话 + bash → 整条命令在远端 exec(conn.exec), 无本地逃逸面 ✓
  - 远端会话 + write/edit 本地绝对路径(如 C:\foo) → mapLocalToRemote 拒绝非 / 开头绝对路径(src/router.js L58/L66) → 报错, 不能逃逸写本地 ✓
  - 远端会话 + 远端工作区外绝对路径(如 /etc/foo) → resolveRemotePath 放行(/ 开头即远端) → **SSH 直写, 无任何策略拦截** ✗

**2. sandbox 权限一致性(核心缺口, 源码核实)**:
- 官方 tool-fs: write L655-660 `sandbox.resolvePolicy("write", args, exec)` → `ctx.fs.writeText(..., sandboxPolicy)`; edit L804-813 同构; schema 广告条件 L617(仅 sandbox.escalationModes 非空才挂 schemaFields); 升级语义经 @deepseek-ai/dsh-sandbox(approveEscalation / validateEscalationArgs / mapError / sandboxDenialMarker, import 于 L4)。
- 我们 tools.js: L38 注释"sandboxMode 用于逐字对齐官方广告"; schema 广告了 sandbox_permissions/justification(bash L457-458 / write L584-585 / edit L646-647)与完整升级话术(L87); **但远端 execute 分支完全不消费这两个参数 —— 无 resolvePolicy、无审批、无拒绝语义, 直接 SFTP/exec 写入**(审计子代理发现, 主 Agent 核实)。
- 后果: ① **workspace-write 模式在远端工作区不生效** —— 写远端工作区外路径不拦截、无审批提示; ② 广告与实现不一致 —— 模型按话术在"拒绝后"带 sandbox_permissions 重试, 但远端根本没有拒绝/升级环节, 广告了一个不存在的语义。
- ⑤实施时的关联修复: escalation 判定改走 ctx.get('shell')/ctx.get('fs')(tools.js L424-425, 见 A.18) —— 只解决了无 inject 下读 sandboxMode, 未解决远端分支不消费策略的本问题。

**3. 修复建议(M5, 接入点)**:
- 远端分支在 write/edit/bash 执行前接入宿主 sandbox 语义: 复用 @deepseek-ai/dsh-sandbox 的 resolvePolicy(tool, args, exec)(读会话 sandboxMode); 远端占位根内视为"工作区内"放行; 远端绝对路径在工作区外按 workspace-write 语义拒绝并返回官方 denial marker, 支持 sandbox_permissions 升级重试(approveEscalation/validateEscalationArgs)。远端没有 fs-sandbox 的文件系统层拦截, 需在工具层自实施(参考 dsh-fs-sandbox 判定逻辑)。
- bash 远端策略语义需定义: 官方本地 bash 由沙箱 runner 强制文件写入边界, 远端无 runner, 只能工具层按 policy 粗粒度放行/拒绝整条命令(或文档化"远端 bash 不 enforce, 仅文件工具 enforce"的差异)。
- 广告同步: 远端 sandbox 语义落地前, 收敛 schema 广告或在描述中明示远端语义差异。

**4. 红线**: 本节为源码核实补记, 未改代码/配置, 未重启服务, 未连远端。

---

### A.21 实施: P0 远端 sandbox 权限语义接入(工具层 fence)(2026-08-19, 子代理)

> 任务书: P0 安全缺口修复 —— 远端 write/edit/bash 的 schema 广告了 sandbox_permissions/justification 与完整升级话术, 但 execute 远端分支不消费(无 resolvePolicy/无审批/无拒绝)。本节依据 A.20 接入点建议实施, 纯追加。

**1. 设计决策**

- **远端工作区边界 = route.remoteCwd**(会话占位 cwd 解码出的远端绝对路径)。三模式远端语义:
  - `danger-full-access`: 全放行(现状行为不变)。
  - `workspace-write`: 解析后的远端路径在 remoteCwd 内放行; 区外(含远端 /tmp 等系统目录)拒绝 —— 返回官方 denial 语义, 支持 `sandbox_permissions` 升级重试。
  - `read-only`: write/edit 一律拒绝; bash 整条命令拒绝(fail-closed)。
- **bash 远端语义(有歧义点, 已按任务书建议收敛, 未自行放宽)**: 远端无 sandbox runner, 无法按文件粒度 enforce 命令内的写边界。
  - `workspace-write` 下远端 bash 前台命令**放行**, 工具描述中明示差异(新增一句: "In a remote (SSH) workspace there is no sandbox runner on the remote host … under workspace-write it runs with the remote user's full privileges")。
  - `read-only` 下远端 bash **整条拒绝**(fail-closed), 用官方同形 denial 结果 `sandbox: { mode: 'read-only', denied: true }`, 现有 renderResult 追加 marker + 升级 hint; 模型可带 `sandbox_permissions=workspace-write` 升级重试(approveEscalation 审批)。
  - 不放宽的点: read-only 不因"无法静态区分读写"而放行任意命令(那会架空 read-only); workspace-write 下 bash 的"不 enforce"以描述明示, 是任务书明确建议的收敛, 不是自行放宽。
- **工作区内外判定(尾斜杠与前缀陷阱)**: 词法包含 `isPathInsideWorkspace(target, root)` = target===root 或 `target.startsWith(root + '/')`; 两端先 `posix.normalize` 折叠 ./../。`resolveRemotePath` 绝对路径分支新增 `posix.normalize`(router.js L89), 关闭绝对 `/data/work/../etc` 词法逃逸, write/edit/read/glob/grep 全链路归一化。
- **升级通道与官方一致**: 复用 `@deepseek-ai/dsh-sandbox` 的 `validateEscalationArgs`(参数成对/非空校验)与 `approveEscalation`(严格更宽校验 + `ctx.get('approval').request` 审批, 审批在一切执行前)。denial 错误与官方 mapError 同形: `FsError(code=FS_SANDBOX_DENIED, message=[sandbox: file access denied under <mode> mode]\n[sandbox: escalation available — …])`。
- **广告对齐**: escalationModes 为空(无 sandbox 后端)时不广告 sandbox_permissions/justification(现状已满足, 官方 dsh-tool-fs L617 同款); 接入后广告语义变真实。会话有效模式经 `ctx.get('sandboxPolicy').resolve({session}).mode` 读取(会话覆盖 > 部署默认), 回退到 fs/shell 的 sandboxMode 能力事实。

**2. 实现摘要(文件/关键函数)**

- **packages/dsh-ssh/src/policy.js(新增, 纯函数)**: `isPathInsideWorkspace`(词法包含 + posix.normalize + 前缀陷阱防护)、`mutationDenialMode`(三模式判定矩阵, 未知模式 fail-closed)、`sandboxDenialError`(官方同形 FsError)。
- **packages/dsh-ssh/src/router.js L89**: `resolveRemotePath` 绝对路径分支 `return posix.normalize(requestedPath)`(关闭绝对 .. 逃逸)。
- **packages/dsh-ssh/tools.js**:
  - import 增加 `approveEscalation`/`validateEscalationArgs`(dsh-sandbox)与 `./src/policy.js`。
  - 新增 helper `resolveRemoteSandboxMode`(会话有效模式) / `resolveRemoteEffectiveMode`(validateEscalationArgs → 会话模式 → approveEscalation) / `assertRemoteWritable`(denial 抛错)。
  - write/edit 远端 execute: 先 resolveRemoteEffectiveMode → resolveRemotePath → assertRemoteWritable(拒绝即抛 denial), 再 acquireRemote 写。
  - bash 远端 execute: resolveRemoteEffectiveMode; mode==='read-only' 返回 `sandbox.denied` 结果; 否则放行。
  - `bashDescription` 新增远端无 runner 的明示差异一句。
  - 本地委托分支(delegateLocal)与 preset/standard-ssh 回退路径零改动。

**3. 验证证据**

- **单测**: `node --test test/*.test.js` → tests **205** / pass **195** / fail **10**(10 个为基线既有 Windows path.sep 问题, 与本改动无关; 基线 180/170/10 不劣化)。新增 `test/policy.test.js`(纯函数矩阵: 三模式 × 区内/区外/逃逸 + denial 形状 + resolveRemotePath 归一化)与 `test/tools-sandbox.test.js`(write/edit/bash 三模式 + 升级重试/拒绝/非严格更宽/参数校验)共 25 例全过。
- **直连实测(ubuntu 203.0.113.10, scripts/sandbox-live-verify.mjs, 真 SFTP, 测后清理)**: 9 项全过 —— workspace-write 区内写放行; 区外写拒绝(FS_SANDBOX_DENIED); denial 形状 `[sandbox: file access denied under workspace-write mode]` + 升级 hint 与官方一致; read-only 区内写拒绝; 升级重试(sandbox_permissions=danger-full-access + 审批)→ 区外文件真实落盘且审批通道被调用(toolName=write/callId/session 正确); danger-full-access 区外写全放; 绝对 ../ 逃逸拒绝; /tmp/dsh-ssh-verify-* 清理确认无残留。
- **服务重启(3090)**: 停旧 PID 11452(不碰 9604) → Start-Process 重启 → 新 PID **17692**(web.pid); HTTP GET http://127.0.0.1:3090 → **200**; web.err.log **0 字节**; web.log 尾部 `dsh web: http://127.0.0.1:3090`。

**4. 剩余事项**

- 浏览器端最终确认(用户): 3090 远端工作区会话中, workspace-write 会话写区外路径应出现官方 denial marker, 模型带 sandbox_permissions 重试时弹出审批。
- 远端 `workspace-write` 未放行远端 `/tmp`(官方本地语义中 /tmp 与 os.tmpdir() 可写; 远端分支按任务书"工作区内/外"从严只放行 remoteCwd, 未复制本地 /tmp 语义; 如需对齐官方 writableRoots 需在远端实现 remote /tmp 白名单, 留待确认)。
- 词法归一化不解符号链接(与官方 dsh-fs-sandbox "containment 非安全边界"威胁模型一致); 远端符号链接 + .. 的 TOCTOU 残差官方同样接受, 未额外加固。
- bash 远端 workspace-write 的"不 enforce"已通过描述明示; 若后续需真 enforce, 需在远端引入 runner 或命令级写边界(超出"远端零安装"硬约束, 暂不在范围)。




### A.23 修复: 原生下拉框美化为官方 Menu 组件 + 「添加」按钮防换行(2026-08-19, 子代理)
> ⚠️ A.22 可能正被另一子代理并发写入, 为避免冲突本节顺移为 A.23。改动只影响 packages/dsh-ssh/client.js 样式, 未重启 3090 服务。

**1. 问题与改动摘要**

- **原生 <select> 丑**(两处): ① 设置页 SSH 连接表单的「认证方式」下拉(Field 组件 kind=select 分支); ② 工作区选择对话框「远程主机」页签的主机下拉(RemoteFlowBody)。
  - 解决方案: 全部替换为官方 @deepseek-ai/dsh-client-ui-primitives 的 **Menu 组件**(primitive 导出, 内置 role=menu/keyboard/Escape/outside-click 关闭/选中态勾选), 自绘封闭态触发胶囊。调研确认 primitives 无现成 Select/Dropdown 命名组件, Menu 即官方下拉语义对应物。
  - SelectMenu(client.js 新增, 自管理 open 态): 触发按钮复用 .dsh-select 类(保持原胶囊视觉 + DSH 主题变量), 值+chevron 图标(IconChevronDownOutline14, 打开 rotate 180deg); Menu 以 portal:true 渲染列表避免被设置面板/Modal 滚动祖先裁剪; .dsh-select-wrap 给 Menu 外层 span 设 display:flex 使触发胶囊撑满字段宽(替代原生 select 的块级宽度)。
  - 视觉状态(hover 提亮; :focus-visible/.open 用品牌色边框+光晕; disabled 半透明; value 单行省略; chevron 过渡), 全用 --dsw-alias-* 主题变量, 深/浅色主题自适应。
  - 注意: 原打算用 --dsw-alias-state-accent-primary 作 focus 色, 但审计主题 token 全集发现 DSH 只有 state-success/error/warn/business-primary, 无 accent token → 改用 --dsw-alias-brand-primary(品牌主色即交互强调色)。
- **「添加」按钮文字换行**(设置页头部 Add 按钮 + 表单「添加/保存」按钮, 中文"添加"拆两行): Button 加 className=dsh-add-btn, CSS white-space:nowrap + flex-shrink:0 + min-width:0 防收缩断行(头部 header 是 justify-content:space-between, 之前按钮可被挤压)。

**2. 设计取舍**

- 用官方 Menu 而非纯自绘 ul: 白送无障碍(DOM role/键盘)、主题 token、portal 定位/裁剪防护、选中勾选态, 与 DSH 其它菜单交互一致; 自绘仅保留触发胶囊一层。
- Field / RemoteFlowBody 的 onChange 契约保持字符串值不变(Field 之前传 e.target.value, Remote 传 hostId), SelectMenu 内部按 String(o.value)===String(value) 匹配选中 → 调用方零改动。
- 未改文案(「添加」「选择主机…」等仍走原 locale), 文案重设计由另一子代理负责。
- 触发胶囊宽度: 父容器(column flex)stretch 外层 span, 内层按钮 flex:1 1 0% 撑满, 替代原生 select 的块级 100% 宽度。

**3. 验证**

- node --check packages/dsh-ssh/client.js → EXIT:0。
- grep 确认 client.js 无残留 React.createElement("select")(两处原生 select 均已替换)。
- 未重启 3090(红线); 真机效果待 GUI 重启统一验证。

**4. 遗留待办(本任务范围外, 仅记录)**

- 本地目录浏览器「新建文件夹」名称输入框(client.js L1169)仍是原生 input, 走 .dsh-newfolder-input 自绘样式, 视觉尚可但与官方 Input 组件不统一 → 后续可换 primitives.Input 对齐。
- 其余表单字段(name/host/port/user/password/keyPath)已用官方 primitives.Input, 无需处理。
### A.25 调研: 远端工作区会话下 skill / MCP / 其他宿主侧工具的行为(2026-08-19, 子代理, 纯调研不改代码)
> 背景: dsh-ssh 方案⑤(agent/created + scope 遮蔽)把 7 个同名工具(bash/read/write/edit/read_image/glob/grep)按会话 cwd 路由到远端。用户问: skill、MCP 在远端会话里引用的本地还是远程? 本节给结论+源码行号。仅调研, 不实施。
> 约定: core = <dsh-checkout>(node_modules 下 packages)。编号说明: A.22/A.24 可能被并发占用, 按 §6.4 顺移为 A.25。

#### 0. 一句话结论
**① ⑤遮蔽只覆盖 7 个同名路由工具, skill 与 mcp__* 不在名单, 绝不被遮蔽、始终可见。② skill 目录发现/读取走宿主 ctx.fs(host 全局, 未被⑤替换)+ 本地绝对路径 → 远端会话技能目录/SKILL.md/脚本文本一律本地读; skill scripts/ 若被远端 bash 执行会因本地路径不在远端而失败, 若被 read 读则本地委托官方、读得内容但脚本不在远端。③ MCP 服务器(stdio 本地子进程 / HTTP)在自己环境执行, 与 cwd 路由完全解耦 → 远端会话 MCP 工具仍在本地 host(或 HTTP server 所在处)执行。④ 其余宿主工具(todo/ask_user/web_search/subagent/goal/jobs)与 fs 无关 → 远端/本地一致。总结: ⑤只影响被遮蔽的 7 个工具, skill/MCP/其它全部在本地执行。**

#### 1. Q1 skill 加载: 目录 / SKILL.md 通道 / 工具注册表
- skill 服务: SkillRegistry extends Service, super(ctx,"skills") 注册 ctx.skills(core dsh-skill/lib/index.js, class 定义 L~155)。
- 技能目录集合: dsh-skill-filesystem/lib/index.js roots(cwd) L150-183 —— L153 findProjectRoot(resolve(cwd), fs)(向上找 .git, 定义 L799); L155-157 <projectRoot>/.dsh/skills(rank100)、L160-162 <projectRoot>/.agents/skills(rank200); L165-167 customSkillDirs(rank300); L171-175 $DSH_HOME/skills(rank400); L177 agentsHome/skills=~/.agents/skills(agentsHome 默认 join(homedir(),".agents") L78, rank500); L180+ bundled(rank600)。
- SKILL.md 读取通道(关键): readSkillText() L708 —— fs 存在且非 trustedHost 走 readSkillTextFromFileSystem(L723: fs.resolve→fs.stat→fs.readText), 否则 node:fs readFile; 默认走 ctx.fs, path 为本地绝对路径。ctx.fs 是 host 单例, ⑤ 只换工具层不换 ctx.fs → 技能文件始终本地读。
- skill 工具注册: dsh-tool-skill/lib/index.js L145 ctx.tools.register(skillTool); 名"skill"(L38), inject["agents","tools","skills"](L13)。与 7 个路由工具同一 dsh-tools 注册表。挂载: dsh-base host 平面(dsh-base/cordis.patch.yml L237-248) 且 standard preset 也挂 skill-filesystem/tool-skill(standard/agent.cordis.yml L83-87, 注释 L78-82: registry 在 host、preset 贡献其层)。
- ⑤是否遮蔽 skill 工具: 否。ROUTED_TOOL_NAMES=['bash','read','write','edit','read_image','glob','grep'](packages/dsh-ssh/tools.js L~246); selectShadowNames 只在这 7 个里挑 agent 视图已存在的遮蔽(index.js L97-127)。skill 不在名单 → 远端会话模型仍可调 skill 工具。

#### 2. Q2 skill scripts/ 资源在会话里怎么用 → 远端推断
- 无任何「skill 脚本执行器」: skill 工具只返回 {name, provider, resourceBase, content}(dsh-tool-skill L119-142); resourceBase={kind:'directory',path:locator.directory}(dsh-skill-filesystem L126 = 技能目录本地绝对路径), content=SKILL.md 正文; 正文(dsh-skill renderSkillContent/renderResourceHint)只让模型对 base directory 解析相对路径按需加载。故 scripts/ 只能由模型自己用 bash/read 加载。
- 远端会话行为(⑤遮蔽后模型面对的 bash/read 都是路由工具、按 cwd 判定):
  - SKILL.md 指令文本: 经 ctx.skills.get→ctx.fs 本地读 → 本地读 OK(注入上下文, 不落远端)。
  - 模型用 bash 跑技能脚本(bash <skilldir>/scripts/x.sh): cwd 远端占位 → 远端分支 → 远端机器无 <home>/.../.agents/skills/x/scripts/x.sh → 失败(找不到)。
  - 模型用 read 读技能脚本: 传本地绝对路径(不在 ~/.dsh/remote/... 下)→ routeByCwd 判 local → delegateLocal → ctx.tools.get('read')(无 scope→host 全局官方)→ 本地读成功, 但脚本不在远端(只读本地副本)。
  - 技能目录都在本地 ~/.agents/skills 或项目根, 不落占位路径 → 一律本地。

#### 3. Q3 MCP: core 支持形态与远端行为
- core 有 MCP: @deepseek-ai/dsh-mcp-client(host 插件), inject=["tools"](lib/index.js L720), apply L765。不在 dsh-base 默认组合(grep 无 mcp), 用户 cordis 显式加载(每 server 一实例, README.zh)。
- 形态: ① stdio StdioClientTransport spawn 本地子进程(L41-45, 含 command/args/env/cwd: config.cwd); ② streamable-http StreamableHTTPClientTransport 连 URL(L47)。
- 注册: syncTools 里 ctx.tools.register(definition)(L165), 公开名 mcp__<serverName>__<rawName>(publicToolName L119)。与 7 路由工具同一 dsh-tools 注册表; ⑤ 只遮蔽那 7 名, mcp__* 不遮蔽。
- 远端行为: callToolUncached→client.request(tools/call) 发已连接的本地/外部 server, 与 exec.agent.session.header.cwd 完全无关 → 服务器在自己环境(本地 host spawn 的 stdio 进程 或 HTTP server 所在处)执行, 不落 SSH 远端; 可访问路径 = 本地 host 或 server 自己的 cwd(config.cwd), 不是远端工作区。

#### 4. Q4 其他宿主侧工具快速扫
| 工具 | 包/inject | 与 fs 关系 | 远端行为 |
|---|---|---|---|
| todo_write | dsh-tool-todo ["tools"](index.js L12) | 会话内 todo 状态 | 一致 |
| ask_user_question | dsh-tool-ask-user ["tools","userQuestions"] L12 | UI 交互 | 一致 |
| web_search | dsh-tool-web 网络 | 网络非本地 fs | 一致(本地 host 走 web 服务) |
| subagent/subagent_fork | dsh-tool-subagent ctx.get("jobs") L246 | 子 agent 本地派生 | 一致; ⑤ 的 agent/created 钩子为 host 全局, 子 agent 若继承远端 cwd 同样被遮蔽路由工具 |
| goal/jobs | dsh-tool-goal/jobs 按 Session/agent 键控 | 无 | 一致 |
| run_code(code-mode) | dsh-tools 保留 transport | 本地 | 保持本地(不在 7 名) |
结论: 除被遮蔽的 7 个工具外, 其余宿主侧工具与会话 cwd 无关 → 远端/本地一致, 全在本地执行。

#### 5. 行为矩阵: 远端会话(会话 cwd = ~/.dsh/remote/<hostId>/... 占位路径)下各能力实际行为
| 能力 | 实际执行位置 | 数据/资源来源 | 受⑤ cwd 路由影响? | 说明 |
|---|---|---|---|---|
| bash/read/write/edit/read_image/glob/grep | SSH 远端 | 远端路径(相对基于 remoteCwd) | 是(被遮蔽+路由) | 7 个同名工具, cwd 判定远端分支 |
| 本地绝对路径下 read/write/edit | 本地 host(delegateLocal→官方) | 本地 | 部分(经⑤但落 local 分支) | 路径不在占位目录→委托本地官方 |
| skill 目录发现/SKILL.md/skill 工具 | 本地 host | 本地目录(~/.agents/skills、项目根)经 ctx.fs | 否(skill 不在名单) | {cwd} 只决定扫哪些项目根, 仍是本地路径 |
| skill scripts/ 被 bash 执行 | 尝试远端→失败 | 本地路径在远端不存在 | 是(bash 被路由) | 远端找不到 C:\...\.agents\skills\...\x.sh |
| skill scripts/ 被 read 读 | 本地 host | 本地文件读内容 | 否(read 落 local 分支) | 读得到本地内容, 脚本不在远端 |
| MCP 工具(mcp__*) | 本地 host / 外部 server 自己环境 | MCP server 自己的 FS/env | 否(不在名单; 执行与 cwd 无关) | stdio 本机 spawn;HTTP 在 server 处;不落 SSH 远端 |
| todo/ask_user/web_search/subagent/goal/jobs | 本地 host | 各自服务 | 否 | 与 fs/cwd 无关, 行为一致 |

#### 6. 缺口与产品建议(只调研, 不实施)
**缺口**
1. 技能脚本「本地可用、远端不可用」不对称: 远端会话 SKILL.md 可读、skill 工具正常, 但 scripts/ 若被 bash 执行因本地路径不在远端而失败; 难预判哪类技能脚本远端失效。
2. MCP 与远端割裂: MCP 工具在远端会话跑在本地 host, 读写本地/自身环境而非 SSH 远端, 操作「当前工作区」会错位误导。
3. 无统一能力面说明: 缺「哪些落远端、哪些落本地(除 7 工具外全落本地)」清单, 跨机器一致性难推理。
**产品建议选项(供决策, 未实施)**
- A(文档化, 成本最低): preset/README + 远端会话 system-prompt 明确「远端只路由 7 工具; skill/MCP/其余一律本地; 技能脚本需远端文件用 bash 传远端绝对路径或 git/sftp 同步」。MCP「文档化说明即可」可行 —— 与 cwd 路由本质无关, 无代码可改。
- B(资源同步远端): 提供技能同步动作把 resourceBase 目录经 sftp 同步到远端, 让技能脚本远端可执行; 或 skill 工具远端改造(不推荐, 需换 skill 实现, 超⑤边界)。
- C(能力面提示注入): agent/created 钩子向 agent 注入「环境声明」(本地/远端能力面 + 资源基座), 纯附加不遮蔽。
**结论**: ⑤本身无缺口(只遮蔽 7 名), 无需改代码; skill 与 MCP 在远端会话均引用本地/自身资源, 属设计如此, 建议「A 文档化 + 可选 C」收口, 不引入工具层改动。
### A.24 实施: UI/UX 设计规范四批(§6 A/B/C/D)+ 默认工作区方案 C(2026-08-19, 子代理, 只改 client.js 样式/文案/交互, 未重启服务)
> ⚠️ 依据 .agents/notes/design/2026-08-20-ui-ux-spec.md §6 四批清单执行, 方案 C 完整版(用户拍板)。A.22 被并发占用已顺移过; 本节编号 A.24(A.23 之后、A.25 之前, 当前空闲; 若并发占用则按 §6.4 顺移)。只改 packages/dsh-ssh/client.js(plain JS 无构建), 未碰 core / tools.js / src/(另子代理在改), 未重启 3090。

**1. 用户三项决策落实证据**
- **决策1 方案 C 完整版**:
  - A1 智能默认 tab: DirectoryFlowCombined `useState('local')` → `useState(null)`(未定); open 上升沿 useEffect 先读记忆, 无记忆则调 `props.listHosts()` 按是否非空决定 remote/local; 未定前渲染轻 loading(`IconLoadingOutline16 + t('loading')`), 绝不渲染任何 tab 内容(故也不会触发本地自动浏览/系统对话框)。
  - A2 tab/主机记忆: 设计文档要求持久化到 settings(hosts 命名空间 ui 子键), 但客户端无法经 `api.settings` 写插件命名空间(宿主硬编码白名单 WEB_SETTINGS_NAMESPACES, A.7), 且本任务红线禁止改 src/remote.js 新增写通道 → **降级为浏览器 localStorage 持久化**(键名沿用设计命名 `dsh-ssh.ui.lastWorkspaceTab` / `dsh-ssh.ui.lastHostId`, 不触碰主机配置校验), 跨页面刷新仍生效; localStorage 不可用时静默降级为仅本次会话记忆(符合 spec §3.3/§7 的降级授权)。手动切换 tab 时 `selectTab` 写记忆; RemoteFlowBody 通过 `onSelectHost` 回调写 lastHostId, 并以 `initialHostId` 在载入后自动恢复上次主机(autoBrowseRef 守卫只首载自动)。
  - A3 本地页签任何情况不自动弹系统对话框: 把 `enterNativeMode()` 拆成「进入回退 UI」与「触发系统对话框」两动作 —— `enterNativeMode()` 只置回退态+清态(不再 fireNativePick); 新增 `pickNative()`(reset nativeFiredRef + fireNativePick)。挂载 effect 不再「一进即弹」; `list()` 命中 browseCapabilityError 只进入回退 UI; 回退 UI 渲染 `local.nativeHint` 说明 + 显式 primary「选择本机文件夹…」(`local.nativePick`, 新增 locale key)+ 取消, 点击才弹系统对话框。
- **决策2 删除确认 = Modal 一键确认**(不用 RiskConfirmation): SshHostsSection 的自造 `.dsh-delete` 内联条 → 官方 `Modal`(`.dsh-delete-modal` width 440px), title=`confirmDelete` 带主机名插值、description=confirmDeleteHint、footer=[取消 幽灵][删除 primary `confirmDeleteAction`], 确认钮禁用态绑定 state.deleting。
- **决策3 其余按 §6**: 见下逐条。

**2. 四批实施逐条结果**
- **A1/A2/A3**: 见「决策1」。全部落在 DirectoryFlowCombined / LocalFlowBody 内 + 4 行 localStorage 工具函数, 不碰 core、不加依赖、不新建代码文件。
- **B1** 重写 settings.ssh ZH/EN 全部值 + 新增 `saved`/`empty.first`/`mountFail`/`notReady`/`remoteResolveError` 键, 黑话清零(`sshd/exec/SFTP/占位/命名空间/dsh-ssh-hosts/只写字段` 不再出现在用户文案): title=远程主机/Remote Hosts; intro 讲价值; 状态词统一(测试中/已连接·可以开始会话/连接失败; 保存中; 删除=仅移除本机配置...)。键数 ZH=EN=48(脚本逐键核对无差异)。
- **B2** 重写 workspace.ssh SSH_ZH/SSH_EN 全部值 + 新增 `tab.defaultHint`/`select.remote.emptyCTA`/`remoteResolveError`/`local.nativePick` 键; `use` 与 `local.open` 统一为「打开」; intro 去「占位目录」; 键数 SSH_ZH=SSH_EN=48。
- **B3** 去掉 HostRow `passwordSet` 前 `t("passwordSet").split("(")[0]` 脆写法 → 直接用 `t("passwordSet")`(新值「已保存(留空沿用)」不再带括号当数据拆)。
- **B4** confirmDelete 插值: `t("confirmDelete", { name: displayHostTitle(pendHost) })` —— 核实 `dsh-client-locale` bind/translate 原生支持 `{var}` 插值(`template.replace(/\{(\w+)\}/g, ...)`, dsh-client-locale/lib/client.js L1117-1119), 无需 replace 回退。
- **B5** 收口硬编码(H1-H3): `resolveRemoteHome 返回异常` → `t('loadDirFailed') + （t('remoteResolveError')）`; `远程服务挂载失败:` → `sshT('mountFail')`; `远程服务未就绪...` → `sshT('notReady')`(apply 内新增 `var sshT = ctx.locale.bind("settings.ssh")`)。H5 banner/testDone 死文案已换人话值(归档, 保留键)。
- **C1** 状态组件收敛: 新增 `StatusNote({state:'done'|'error'|'warning'|'ongoing', text, detail?, onRetry?, retryLabel?, onDismiss?, dismissLabel?})`, 内部用官方 `StateDot`(aria-hidden)+ 三态着色(`.dsh-statusnote.done/error/warning/ongoing`, ongoing 用 `--dsw-alias-state-business-primary` 蓝色——审计主题 token 全集确认**无 state-info-***, 用 business 品牌蓝), 替换三套自造条: `.dsh-hosts-error`(设置页错误)、`.dsh-remote-error`(本地/远端浏览错误)、`.dsh-test`(连接结果)。
- **C2** 删除确认改 Modal(见决策2)。
- **C3** SelectMenu 已由另一子代理完成(A.23), 本条跳过; 确认 `field.authKey/authPassword` 已用 §4 新文案(SSH 密钥/密码)。
- **C4** 测试连接三态: HostTestResult 改用 `StatusNote`(`done`/`error`)带 StateDot; 表单内试连结果同样 StatusNote(成功/失败)。「已保存」反馈: store 新增 `notice` 字段, saveForm/confirmDelete 成功后置 `'saved'`, SshHostsSection 渲染官方 `p.savedNotice` 内联绿字(`role="status"` + `aria-live="polite"`, 对齐 dsh-client-ui-settings-models 的 ModelsSection savedNotice 模式, 样式 `--dsw-alias-state-success-primary`)。
- **C5** 空状态副引导: 设置页空态加 `empty.first` 第二行; 远程页签空态 `noHosts` + 「去添加主机」CTA 按钮(`select.remote.emptyCTA`, 点击调用 owner 的 `cancel` 关弹窗引导去设置页)。C7 另给 loadHostsFailed 重试按钮。
- **C6** HostForm 表单内「测试连接」按钮: 新增 controller 方法 `testConnectionForm()`(用表单当前值 `buildHostConfig` 构造 cfg 直接 `ssh.testConnection({cfg})`, 不受已存主机束缚), store 新增 `formTesting`/`formTestResult`, form 底部加 outline「测试连接」按钮(loading 态 IconLoadingOutline16 + disabled), 结果 StatusNote 展示 + `dismissFormTest`; `patchForm` 清 formTestResult 避免陈旧结果。
- **C7** 远程浏览「当前主机」标识: browse pathbar 前加 `Pill`(active)显示主机名(`onSelectHost` 同时持久化 lastHostId); `loadHostsFailed` 不再直接 reportOutcome 关弹窗, 改为 phase='error' 内联 StatusNote(错误 + Retry 按钮, `reloadHosts()` 可重试), 消灭死胡同。
- **D4 约束遵守**: 未改 core、未加依赖、未新建代码文件; 所有新样式走 `--dsw-alias-*` token; ZH/EN 对称(48=48 双命名空间, 脚本核对)。

**3. 验证证据**
- `node --check packages/dsh-ssh/client.js` → EXIT 0。(D1 语法)
- `node packages/dsh-ssh/scripts/client-selfcheck.mjs` → `client.js static self-check OK`(inject/requires/双槽 priority -1/descriptors 内联/locale 注册全部通过)。
- 自写一次性校验脚本(临时, 已删, 未留仓库): ZH vs EN、SSH_ZH vs SSH_EN 键全对等(各 48); 黑话词(sshd/exec?/SFTP/占位/命名空间/dsh-ssh-hosts/只写字段/关键词法串)扫描 —— 命中项均为「代码注释」或「正确译文值」(`mountFail`/`notReady` 译文本身含「挂载失败/未就绪」为应有; EN intro 'execute' 为正常英文), 无残留用户可见硬编码中文。
- 未重启 3090(红线); D2 dump-config 未重跑(slot 注册、priority -1 完全未改, 静态 selfcheck 已复核双孔); D3 真机 GUI 验证待主 Agent 统一重启后执行。

**4. 遗留项(记录, 本任务范围外/受限)**
- **A2 持久化介质与设计文档不一致**: 设计文档要求 settings 命名空间持久化, 受 api.settings 白名单 + 「不改 src/」红线双重限制, 本次用浏览器 localStorage 替代(键名沿用 dsh-ssh.ui.* 命名)。若主 Agent 希望真写入 settings 命名空间, 需协调在 src/remote.js 新增 Typert 写通道(或等上游把 expose 声明下沉到 settings.register, A.7 deferred work), 属后续任务。
- **C4 保存成功反馈仅内联绿字**, 未叠加 Toast(spec 为「可选叠加」, 内联 savedNotice 已达标)。
- **本地目录浏览器「新建文件夹」输入框**仍为原生 input(A.23 遗留), 未改。
- 真机效果(默认 tab 智能、记忆恢复、本地不再自动弹系统对话框、Modal 删除、表单试连、远端主机标识)需 GUI 重启后人工验证(D3).
- 表单试连的空口令(保持已存)与 testConnection 将用 form 当前值构造: 已存口令场景下绕过了 mergeTestConfig 补 secret(setting 只用 form 填的口令), 属设计取舍 —— 保存前试连无法使用未在表单输入的已存 secret, 与「表单内不可见 secret」语义一致, 记录备查。




### A.22 实施: P1 远端 bash 后台任务(run_in_background 接入)(2026-08-19, 子代理)

> 背景: A.17 审计「远端 bash 后台任务」差距, 采用方案1(b): 工具层 bash 远端分支把 run_in_background 接到宿主 ctx.get('jobs').start 通道, job 控制器由本包自建(单条 exec + 日志/status 文件轮询), 官方 job_output/job_list/job_kill 零改动自动可见。

**红线落实(对应 A.17 两条实测红线)**
- 红线① 后台命令单命令异步、cd 内嵌 bash -c: setsid bash -c 'cd <cwd> && ( <cmd> ); ec=$?; printf "%s\n" "$ec" > <status>' ><log> 2>&1 </dev/null & echo $!(buildSpawnCommand, src/remote-jobs.js)。
- 红线② kill 覆盖进程树: setsid 起步使后台 bash 为独立 session/进程组组长, PID==pgid → kill -TERM -- -<pid> 杀整组 + pkill -TERM -P <pid> 补杀孙进程(buildKillTreeCommand)。

**产物**
- packages/dsh-ssh/src/remote-jobs.js(前两回合已建, 本回合复核): createRemoteBashJobHooks 返回 {cancel, done, readOutput} 完整 jobs.start 契约; done 轮询 status 文件 + kill -0 探活得最终 {status:'completed'|'killed', detail}; readOutput 日志游标增量读; _meta/_state 挂测试钩子; killForegroundTree 前台超时清理。
- packages/dsh-ssh/tools.js 接入(bash 远端分支):
  - 过 P0 sandbox fence(read-only 拒绝, fail-closed 同官方 shape)→ 解析 escalation → 再进 background 分支。
  - run_in_background:true → startRemoteBackground(ctx, exec, args, route): ctx.get('jobs') 缺失则明确报错; acquireRemote 拿 conn(host 级复用实例, job 存活期内仍可走 exec/sftp)→ jobs.start({kind:'bash', label:command, owner:exec.agent?, run:()=>createRemoteBashJobHooks({conn, cmd, cwd:route.remoteCwd, hostId, jobDir:defaultRemoteJobDir(hostId)})}) → 返回 {kind:'background', jobId}(对齐官方 tool-bash L403-427)。
  - 前台 exec 超时(exec-timeout)路径调用 killForegroundTree(conn, args.command, route.remoteCwd) best-effort。
  - 保持 P0 的 sandbox fence、本地 delegateLocal、preset 回退不变。
- 单测: test/remote-jobs.test.js(13 新: 命令组装纯函数/setsid/转义/parseSpawnPid/hooks 契约形状/readOutput 增量/cancel→killed/done→completed/parse 失败兜底; fake conn 模拟 exec/sftp, 无网络)。tools-remote.test.js 更新一条过时断言(原「run_in_background → not-supported 报错」改为「jobs 缺失→明确报错」+「jobs 可用→返回 {kind:background, jobId} 且 run() 给控制器契约」)。
- 全套 node --test test/*.test.js: tests 219 / pass 209 / fail 10(基线 205/195/10 之上净增 14 过, 10 个既有失败不变, 不劣化)。

**直连实测(ubuntu 203.0.113.10, 仅 /tmp/dsh-ssh-jobs-* 与 /tmp/dsh-ssh-verify-jobs2)**
- 真实 SshPool+SshConn 跑 2 个后台任务: Job A sleep 4 写文件 exit3; Job B sleep 20。readOutput 增量读到 START-A/B-START; cancel B → done={status:killed}, pid kill -0 探活 DEAD, ps -eo pid,ppid,pgid,args|grep 无残留(NONE); 等 A done → {status:completed, detail:'exit code: 3'}, 输出文件 DONE-A 落盘; 清理后 /tmp/dsh-ssh-verify-jobs2 删除且全局进程扫描 NONE。脚本保留: test/live-jobs.mjs(可复跑, 非 *.test.js 不进套件)。

**3090 服务重启(dsh-ssh-dev profile, 供真机验证)**
- 停旧 PID 17692 → Start-Process node.exe dsh/lib/bin.js --profile dsh-ssh-dev --port 3090, DSH_HOME=<home>/.dsh, WorkingDirectory=$DSH_HOME/profiles/dsh-ssh-dev, 日志覆盖 web.log/web.err.log, 新 PID 63188 写 web.pid; 验证 HTTP 200 + web.err.log 空(0 行)+ web.log 一行 "dsh web: http://127.0.0.1:3090"。

**遗留/注意**
- jobs.start 的 owner 仅在 exec.agent 存在时传入; 后台日志/status 文件放 /tmp/dsh-ssh-jobs-<hostId>(远端该目录需可写)。
- 编号说明: 本文件 A.22 曾被并发子代理「顺移」为 A.23/A.25; 现 A.22 空闲, 按本任务书使用 A.22(若后续并发冲突, 按 §6.4 顺移注明)。

### A.26 实施: skill/MCP 能力面收口 —— 方案 A(文档化)+ C(远端会话提示注入)(2026-08-19, 子代理)
> 背景: A.25 调研结论 + 竞品 research/remote-capability-competitors.md(A 对标 VS Code extensionKind; C 对标 Claude Code Agent Skills 指令注入加本地执行)。用户已拍板 A + C(B 资源同步不做)。只改 packages/dsh-ssh/(index.js 注入 + README + client.js UI 小字 + 单测), 未动 core / tools.js / src/remote-jobs.js(另子代理在跑), 未重启 3090。

**1. C: 远端会话能力面提示注入(agent/created 钩子, index.js)**
- 注入机制(core 官方通道, 无需改 core): dsh-agent 的 assembleContextFor(agent, signal) 返回 { agent, scope: agent, ... }(dsh-agent/lib/index.js L384-390), 即每个 agent 的 system prompt 组装用 scope === agent; dsh-system-prompt 的 SystemPrompt.section() 经 layers.effect(this.ctx, ...) 在调用上下文作用域注册(dsh-system-prompt/lib/index.js L186-188), 且 PromptLayer 错误文案 L142 明示 per-agent 覆写走该 agent 的 agent.ctx。→ 在 agent/created 钩子里调 agent.ctx.systemPrompt.section(...) 即把声明注册进该 agent 自身作用域, 只参与该 agent 的组装(远端会话专属)。
- 时机: agent/created(dsh-agent setupAndPublish, emit)agent.ctx 已就绪(方案⑤同款钩子, index.js installToolRoutingHook)。
- 新增(全部在 packages/dsh-ssh/index.js): CAPABILITY_SECTION_NAME=dsh-ssh:capability-surface、CAPABILITY_SECTION_ORDER=150(工具指引 100-199 区间, 避开 harness:identity(-100)/persona(0)); buildCapabilitySection(route, opts) 纯函数返回 {name, order, text}(zh/en 双语文案, opts.zh!==false 默认 zh; header 无 locale 字段故默认 zh 起步); injectCapabilitySurface(agent, route, opts)(经 agent.ctx.systemPrompt.section 注册, 返回 disposer 或 null, 绝不外抛, agent/created 是 emit); resolveHostLabel(ctx, hostId)(尽力读 dsh-ssh-hosts 显示名, 失败回退 hostId)。
- 钩子集成: installToolRoutingHook 确认 route.kind===remote 后、独立于工具遮蔽(即使 minimal preset 无工具可遮蔽也注入)调用 injectCapabilitySurface; 本地 cwd 在 route.kind!==remote 处先行 return, 零影响; opts.capability===false 可关。
- 声明文案要点: 本会话工作区在远程主机上执行(bash/read/write/edit/read_image/glob/grep 走 SSH); skill 脚本资源与 MCP 工具在本机执行、与远端工作区无关; 访问本机文件请用本机绝对路径。

**2. A: 文档化能力面**
- packages/dsh-ssh/README.md(新建): 能力面/Capability Surface 小节 = A.25 行为矩阵的用户可读版(逐能力执行位置表 + 一句话结论), 附设计语义对标 VS Code extensionKind(声明式能力面)/ Claude Code Agent Skills(指令注入加本地执行)/ MCP 业界常态(不跟随远端)。
- packages/dsh-ssh/client.js(轻标注, 改一处): 工作区弹窗远程 tab 目录浏览阶段(RemoteFlowBody, phase=browse)在 pathbar 后加一行小字 hint, 复用 .dsh-remote-hint 样式(--dsw-alias-label-tertiary, 11px, 不抢眼); locale 新增 capHint(SSH_ZH/SSH_EN 对称), 文案「此工作区的命令与文件在 {host} 上执行; 技能脚本与 MCP 工具在本机执行。」, host 用 curHostTitle 或 hostId 插值(A.24 已证 locale bind 支持 {var} 插值)。

**3. 验证证据**
- node --check packages/dsh-ssh/index.js 与 client.js → 0。
- 单测新增 test/capability-surface.test.js(11 个, fake agent): buildCapabilitySection 纯函数 / injectCapabilitySurface 走 agent.ctx.systemPrompt.section / installToolRoutingHook 集成(远端 cwd 注入、本地 cwd 零注入、capability:false 零注入、无 systemPrompt 不抛) / resolveHostLabel 回退。
- 全套 node --test test/*.test.js: tests 230 / pass 220 / fail 10 —— 基线 219/209/10(10 个既有 Windows 路径失败)之上净增 11 过, 无劣化。
- node packages/dsh-ssh/scripts/client-selfcheck.mjs → client.js static self-check OK。

**4. 遗留/注意**
- C 注入仅在新建的远端会话 agent 上生效(agent/created 触发); 已在运行的旧会话不受影响(符合预期)。
- resolveHostLabel 读 settings 为尽力而为(inject 内才安全, 失败回退 hostId), 展示名可能缺失为 hostId。
- 注入正文为静态中英文案; 如需严格跟随模型 locale, 需 core session 提供 header locale 字段(A.25 已核 header 无 locale, 未改 core)。
- 未重启 3090(红线: 另一子代理负责重启, 统一由主 Agent 协调); 真机 GUI 提示效果待主 Agent 统一重启后验证。
- tools.js / src/remote-jobs.js 未动(另一子代理在跑, 红线); 冲突面为 client.js(A.24 已改)与 requirements-and-design.md(纯追加本节目)。

---

### A.27 修复: 远端会话 shell 路由 —— bash 必注册(远端 shell 跟随远端平台)(2026-08-19, 子代理)

> 决策依据: .agents/notes/decisions/2026-08-19-remote-shell-follows-remote-platform.md(修订 2026-08-19-agent-created-tool-shadowing.md 的策略 (a): shell 工具例外)。**本节是 A.18「Windows 平台注意」(L1134) 旧语义的修订对象**: 旧断言「standard preset 在 Windows 暴露 pwsh 而非 bash, 故 bash 走路由在 Windows 上落在 fs/search 工具, bash 不被补注册」已被本次决策取代 —— 远端会话的 shell 语义由**远端平台**(Linux, 有 bash)决定, 与宿主平台无关, bash 在远端占位 cwd 会话中总是注册路由实现。A.18 原文按 §6.4 保留不覆盖, 以本节为准。

**1. 修复摘要(diff 最小, 只动 index.js 名单选择处)**

- **packages/dsh-ssh/index.js** installToolRoutingHook handler:
  - 原: `const selected = selectShadowNames(agent, names); if (selected.length === 0) return; registerRoutedTools(agent.ctx, selected, opts.config);`
  - 现: selectShadowNames 之后 `if (!selected.includes('bash')) selected.push('bash');` 再注册(含决策笔记引用注释)。含义:
    - **bash 在远端占位 cwd 会话中总是注册路由实现**, 不经过策略 (a) 的「已存在」过滤 —— Windows 宿主 tool-bash 被 platform 禁用(视图无 bash)时补注册; macOS/Linux 宿主 bash 本在视图, selectShadowNames 已含 bash, push 为空操作(走遮蔽殊途同归)。
    - **六文件/搜索工具(read/write/edit/read_image/glob/grep)维持策略 (a) 不变**; selectShadowNames 本身保持纯策略 (a)(未被污染, 不强制任何名字)。
    - **pwsh 不路由**(不遮蔽不注册; 远端会话用 bash —— 能力面声明文案 A.26 已明示「bash / read / ... 在远端机器(SSH)上运行」, 措辞即 bash, 无需改)。
  - 本地 cwd 会话仍在 route.kind !== 'remote' 处 return, 零影响(含 bash 一律不注册)。
  - A+C 子代理交付的能力面注入逻辑(buildCapabilitySection / injectCapabilitySurface / resolveHostLabel / CAPABILITY_SECTION_*)与 client.js **原样保留, 未回退**。
- **packages/dsh-ssh/test/tool-routing-hook.test.js**: 更新 1 个旧断言(远端 cwd 无可见工具 → 由「零注册」改为「bash 仍注册」), 新增 3 例:
  - 视图无 bash(Windows 宿主形态)→ 远端会话注册 bash + 六工具(七工具全);
  - selectShadowNames 不强制 bash(纯策略 (a), 强制发生在钩子层);
  - 本地 cwd + 视图无 bash → 零注册(bash 例外只作用于远端会话)。
- **packages/dsh-ssh/test/capability-surface.test.js**: makeSystemPromptAgent 夹具补 get: () => undefined(远端 cwd 现在恒触发 registerRoutedTools, 其 buildRoutedToolDefinitions 需读 ctx.get('shell')/ctx.get('fs') 判沙箱模式; 断言不变)。
- **packages/dsh-ssh/scripts/verify-agent-created.mjs**: L64-66 旧断言「bash(Windows 不存在)未被补注册」→ 新语义「远端会话 bash 必注册(七工具全遮蔽)」; 新增 DSSH_VERIFY_SKIP_SSH=1 跳过 read /etc/hostname 的 SSH 行为验证(仅装配+遮蔽断言), 头注释同步更新。
- **未改**: tools.js 工具实现本体(P0/P1 sandbox fence / 远端 exec / 后台任务逻辑零改动, registerRoutedTools 只按传入名单注册)、core、client.js、src/*。

**2. 验证证据**

- node --check index.js / test/tool-routing-hook.test.js / test/capability-surface.test.js / scripts/verify-agent-created.mjs → 全部 EXIT 0。
- node --test test/*.test.js(packages/dsh-ssh)→ tests **233** / pass **223** / fail **10**(基线 230/220/10 之上净增 3 过; fail 10 为 Windows path.sep 既有问题, 与本改动无关, 不劣化)。
- node scripts/verify-agent-created.mjs(DSSH_VERIFY_SKIP_SSH=1, 不连远端)→ 真实 cordis 组合(dsh-base + dsh-ssh)装配成功; 远端占位 cwd + standard preset 会话 **bash+六工具全部带 ROUTED_TOOL_MARKER**(七工具全遮蔽, 验证了 Windows 宿主视图无 bash 也补注册); 本地 cwd 会话零遮蔽; VERIFY-OK。
- 远端真机行为验证(read /etc/hostname 走 SSH 返回远端 hostname)因「不连远端」红线跳过, 由主 Agent 统一重启后或后续真机轮执行(脚本默认开启, DSSH_VERIFY_SKIP_SSH=1 可关)。

**3. 红线确认**: core 零修改; 未回退工作区 A+C 的 index.js/client.js 改动; tools.js 工具实现本体未动(只在 index.js 名单选择处改); 未连远端(SSH 部分跳过); 未重启 3090(主 Agent 统一重启)。

### A.28 修复: 远端 bash 后台任务真机报错 "no job controller serves this agent"(2026-08-19, 子代理)

> 症状: 3090 真机, 远端工作区会话 + standard preset + Windows 宿主, 模型调 bash run_in_background:true → 报错 `background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)`。任务书初步诊断(待证实): 疑 Windows 上 tool-bash 被 platform 禁用 → job controller 无人注册。本节结论:**该假设证伪**; 真根因是 web 组合下 base tool-jobs 被禁用 + Cordis Service 按 scope 分层实例化导致 agent scope 的 jobs 实例无 controller。修复=方案⑤钩子为 agent scope 补记 controller, core 零修改。

**1. controller 机制结论(core 源码行号, 只读参考 <dsh-checkout>\node_modules\@deepseek-ai)**

- 抛错点: **dsh-jobs-local/lib/index.js L132** `start()` 首行 `if (!this.servesOwner(spec.owner)) throw ... no job controller serves this agent`。
- **servesOwner 判定(L139-144)**: 全局层非空即 true；否则沿 `scopeOf(owner.ctx)` 的 scope 链 `chainLayers` 找非空 controller 层。
- **谁注册 controller**: 官方 **dsh-tool-jobs** 的 apply 调 `ctx.jobs.attachController('tool-jobs')`(dsh-tool-jobs/lib/index.js, 一行动作)。**dsh-tool-bash 并不注册 controller** — 它只 `ctx.get('jobs')` + `jobs.start({...})`(dsh-tool-bash/lib/index.js L403-427, 与遮蔽 bash 同形)。任务书「controller 由 tool-bash 附带注册」**证伪**。
- **attachController 落层**: `attachController(name)` 用 `this.layers.effect(this.ctx,...)`(dsh-jobs-local L159-161), layer 由 **registry 自身 ctx** 的 scope 决定; Cordis Service 按 scope 分层实例化(repro 实证 `scopeOf(ctx.jobs.ctx)` 随作用域变化), dsh-scope ScopedLayers 全局层 + 每 scope 一层(L133 注释)。

**2. 真根因(3090 真机 web profile 实测, --dump-config 佐证)**

- web 平面为「每会话挂 preset」: **@deepseek-ai/dsh-web-app/cordis.patch.yml** 把 base 的 tool-bash/tool-pwsh/**tool-jobs**/tool-fs/tool-fs-search 等行 `disabled: true`(注释: registry 留 host 平面, 模型面 job_* 控制随 preset 移动)。真机 `dsh --profile dsh-ssh-dev --dump-config` 确认 `- id: tool-jobs disabled: true`、`- id: tool-bash disabled: true`。
- base tool-jobs 被禁 → **全局层无 controller**。controller 只能来自 preset 的 tool-jobs 在 agent scope 注册; 且遮蔽 bash 的 `startRemoteBackground` 用 `agent.ctx.get('jobs')` 解析到「agent 自身 scope 的 jobs 实例」。若某远端会话的 preset 未把 tool-jobs 挂进该 agent 同一 scope 链, 该 jobs 实例全局+自身链都无 controller → `start()` 抛此错。
- 与 Windows 禁用 tool-bash 无因果(tool-bash 本不注册 controller; 且远端 shell 已由 A.27 决策跟随远端平台补注册 bash)。

**3. 修复(方案⑤ agent scope 注册, core 零修改)**

- **packages/dsh-ssh/index.js**: 新增 `attachAgentJobsController(agent, name='@dsh-ssh/dsh-ssh')`: 用 `agent.ctx.get('jobs').attachController(name)`(官方 API)在 agent 自身 scope 补记 controller, 返回 `{jobs, disposer}` 或 null(静默)。
- installToolRoutingHook handler 在 `route.kind !== 'remote'` 之后、遮蔽注册之前调用它(顺带 controller; 结果仅日志/断言, 绝不外抛 — agent/created 同步抛错会 veto agent 发布)。
- 原理: 遮蔽 bash 与补记 controller 走**同一 `agent.ctx.get('jobs')` 实例**, `servesOwner(agent)` 沿 agent scope 链即命中 → 后台任务可用。纯附加: 不改 core; 不改本地会话(local cwd 仍先行 return); preset 已挂 tool-jobs 时只是多一个匿名 token, 无副作用。
- **未改**: tools.js 的 startRemoteBackground 本体、src/remote-jobs.js、core、client.js。

**4. 验证**

- 新增 **test/jobs-controller.test.js**(8 例): 最小忠实模型镜像官方 servesOwner(全局层优先, 其次 scope 链)+ attachController 语义, 断言修复前后 servesOwner/start-guard 翻转; 默认/自定义 controller 名; jobs 缺失、attachController 缺失/抛错时静默 null; ⑤钩子对远端 cwd 顺带注册 controller。
- 全套 test/*.test.js: tests **241** / pass **231** / fail **10**(基线 233/223/10 净增过 8, 全为新增; fail 10 为 Windows path.sep 既有问题, 与本次无关, 不劣化)。
- node -e import(index.js) EXIT 0; 完整 241 例含 8 个新 controller 例全绿。

**5. 红线确认**: core 零修改; 不碰 PID 9604; 本地会话与现有工具行为不变(fail 10 基线持平, 本地路由仍零注册); 未连远端(SSH 跳过); 已重启 3090(dsh-dev profile, 见事件记录)。
### A.29 侧边栏工作区加主机标识(title=basename · 主机显示名) + 工具卡片 base64 显示排查(2026-08-19, 子代理)

> 两个需求: ① 工作区 title 加主机标识区分多主机; ② 工具调用卡片里的 base64 编码段(如 L2hvbWUvdWJ1bnR1L29wZW5jb2RlLWFwaQ) 优化。本纪录与 A.28 并行(A.28 已完整, 无占位); A.28 若被 controller 子代理后续写入则顺移。

**1. 工具卡片 base64 显示来源排查(core 只读，行号证据)**

- 卡片上那串 base64 = 框架显示会话 cwd 的最后一段。链路:
  - **dsh-client-ui-tool/lib/client.js:1148** — BashRow 把 sessionCwd = useSessions(list => list.byId[sessionId]?.cwd) 传给 terminalCardModel;也见 :813/:970(GenericToolCard 同源)。
  - **dsh-client-ui-tool/lib/client.js:427-431** — resolveTerminalCwd(call.cwd, sessionCwd): call.cwd 缺失/空时回退 sessionCwd(远端会话就是占位路径 ~/.dsh/remote/<hostId>/<base64url>)。
  - **dsh-client-ui-primitives/lib/index.js:3557-3562** — promptLabel(cwd, home) 取最后一段(web 无 home): 占位尾段=那个 base64url 编码字符串。
  - 结论: **就是① 框架显示 session cwd — bash/terminal 卡片(扩展后)的提示行 cwd**。read/write/edit 卡片的路径是代理传的远端绝对路径(/开头, 不是 base64), relativizeToCwd(:120-125)只对占位根下路径相对化,远端路径原样返回 → 不显示 base64。A.15 已把侧边栏工作区 title(来源②)修正为 basename; 但卡片的 cwd 仍是 session cwd 尾段(占位 base64)。

- **为何插件无法在 presentCall 中解决**: presentCall 只收 (args)(**dsh-tools/lib/index.js:869-872** tool.presentCall = (args) => ...; 调用点 **dsh-host-apiproxy/lib/index.js:1366** presentCall?.(JSON.parse(raw)) 仅 args, 无 session/路由上下文)。占位 cwd 不能改(workspaceRegistry/sessions 必须看到真实本地路径以保证路由可逆) → **bash 卡片 cwd 的 base64 显示在 core 零修改前插件无法从主机侧修复**(需自定义客户端 bash toolview 接 tool.call.toolview 槽 key:"bash"代替默认 BashRow, 在客户端解码 cwd, 见“遗留项”)。

**2. 工作区 title 新格式 + 旧记录迁移(实现)**

- 新格式: basename · 主机显示名(中缀点分隔, 中文环境自然)。例: opencode-api · ubuntu。
- **src/placeholder.js**: 新增 ⑨ hostDisplayName(hosts, hostId) — name 优先、回退 hostId(name 去空白; banner 不持久化、占位创建不建连拿不到, 不用); ⑩ placeholderWorkspaceTitle(remotePath, hostDisplayName) — basename · host。placeholderDisplayName 保留为 basename 部分。
- **src/remote.js createPlaceholder**: title = placeholderWorkspaceTitle(target, hostDisplayName(hosts, id))(取自 dsh-ssh-hosts dict)。
- **旧记录迁移(扩展 A.15, 幂等、安全)**: 对同一路径再次 createPlaceholder 时(命中已存记录,返回其既有 entity), 仅当 title 为旧签名时 setTitle 升级: ① A.15 前 title 恰为 base64 编码段(encodeRemotePath(target)); ② A.15 的纯 basename(恰等 target 尾段, 无主机标识)。已含 ·的标题视为新格式/用户定制, 不强改写。安全: create 命中的 localPath 由本插件 mapRemoteToLocal 构造(占位根/<hostId>/<base64>), 故迁移只可能命中本插件创建的占位工作区记录, 不碰用户普通本地工作区。幂等: 升级后 legacy===title → needsUpgrade=false, 无再写。

**3. 单测覆盖**

- test/m4-placeholder.test.js: ⑨ hostDisplayName(name/回退/空 hostId) + ⑩ placeholderWorkspaceTitle(basename · host, 尾斜杠/根兑底)。
- test/remote.test.js: ① 标题用主机 name(有 name) 回退 hostId → opencode-api · ubuntu; ② 基准两组改为新格式(显示 registry title=opencode-api · h1; 基准 base64 升级为 work · h1); ③ 新增纯 basename(A.15)迁移 + 幂等(已新格式不再写); ④ 新增已含 ·的用户定制标题不被强改写(安全)。

**4. 验证**

- node --check src/placeholder.js / src/remote.js / test/m4-placeholder.test.js / test/remote.test.js → 全部 EXIT 0。
- node --test test/*.test.js(packages/dsh-ssh)→ tests **246** / pass **236** / fail **10**(A.28 后 241/231/10 上净增 5 过, 全为新增; fail 10 为 Windows path.sep 既有问题, 与本改动无关, 不劣化)。
- 引用源（以上行号的 core 只读路径）: <dsh-checkout>\node_modules\@deepseek-ai\dsh-client-ui-tool / dsh-client-ui-primitives / dsh-tools / dsh-host-apiproxy。

**5. 红线确认 / 遗留项**

- core 零修改; 不碰 PID 9604/48728; 未重启 3090; 未连远端(迁移只动本地 workspaceRegistry 记录); 不碰 tools.js(A.28 子代理改动区域未触碰)。
- **遗留(A.29)**: bash/tool-call 卡片的 cwd base64 显示未修复(core 零修改前主机侧无解; 需客户端自定义 bash toolview接 tool.call.toolview 槽 key:"bash"代替默认 BashRow, 客户端解码 cwd; 待真机 GUI 进一步。read/write 已确认不显示 base64)。



### A.30 修复: 远端 bash 后台任务 job_output/job_list 报 "value is not lossless JSON"(2026-08-19, 子代理)

> 背景: 3090 真机远端会话, 模型经 run_code 调 tools.job_output/job_list 报 `tool "job_output" returned invalid output: value is not lossless JSON`。后台任务启动/完成正常(jobId 返回、completed/exit 0), 但 job_output 取值即炸; 官方本地 bash 后台任务无此问题。

**根因(经真实 LocalJobRegistry 复现, 行号证据)**

- 官方 registry 的 read() 调用 `job.readOutput()` 时**不 await**(@deepseek-ai/dsh-jobs-local/lib/index.js **L190**: `const text = job.readOutput !== void 0 ? job.readOutput() : ...`), 并直接把该返回值作为 job_output 的 text 字段(dsh-tool-jobs/lib/index.js **L276-280**)。job_output 的 output schema 要求 `text: {type:'string'}`(L247-260), 工具输出经 snapshotJsonValue 校验(dsh-tools/lib/index.js **L2468**: `value is not lossless JSON`)。
- 官方 bash 的 `readOutput` 读的是进程本地**内存缓冲**, **同步**返回 string(dsh-tool-bash/lib/index.js **L418-425** 的 run() + renderProcessRead L85-98)。
- 我们旧实现 `readOutput` 是 **async**(remote-jobs.js 旧 L162-167, 每次 SFTP 读日志文件) → 返回 **Promise** → registry.read() 不 await 直接当 text → `read.text` = Promise → `snapshotJsonValue(Promise)` = undefined → job_output 炸。**逐次 job_output 必中**(即便 job 已完成)。
- 复现脚本(临时, 用真实 LocalJobRegistry + 真实 SSH)在同一 fixes 前: `read.text: {}`(Promise 的 JSON 形)且 `job_output value -> NOT LOSSLESS JSON`; 修复后 `text type=string` 且 lossless OK。
- 次要字段 `_meta/_state/_spawned`(run() 返回值上挂的测试内窥; `_spawned` 是 Promise)本身**不进** registry 记录(snapshot L317-331 只投影纯字段; dsh-tool-jobs publicJob L64-74 再剥离), 故不直接导致本报错; 但为严格对齐官方契约且消除任何序列化隐患, 一并收敛。

**修复 diff(仅 packages/dsh-ssh/src/remote-jobs.js + 测试)**

1. **readOutput 改为同步**(remote-jobs.js): 新增 `buffered`/游标 + `refreshLog()`(异步 SFTP 拉远端日志到本地缓冲, 由 done 轮询每轮 + 终止前调用); `readOutput()` 同步返回 `buffered.slice(cursor)` 增量(每次调用游标前移)。job_output 是轮询式读取, 语义不变。
2. **run() 返回严格对齐官方契约**: 返回对象可枚举键 = `{cancel, done, readOutput}` 三键(不多不少)。`_meta/_state/_spawned/_refresh` 改为**不可枚举**属性挂载(never in Object.keys/JSON/spread → 永不进 registry/序列化), 单测/实机脚本仍可 `hooks._meta` 访问内窥。旧测试经 `await hooks.readOutput()` 改为同步调用 + `await hooks._refresh()` 驱动缓冲。
3. **done 对齐官方 ProcessOutcome**(dsh-tool-bash L21-30): completed → `{status:'completed', detail:'exit code: N'}`; killed → `{status:'killed', detail:'signal: TERM'}`(原 'killed by signal: TERM' 措辞对齐)。
4. tools.js startRemoteBackground(L371-395)签名未变(run() 仍经 createRemoteBashJobHooks), **未改**。

**验证**

- 单测: remote-jobs.test.js **13/13**; tools-remote.test.js + jobs-controller.test.js **23/23**; 全量 `node --test test/*.test.js`(packages/dsh-ssh)→ tests **246** / pass **236** / fail **10**(fail 10 = Windows path.sep 既有问题, 与本次改动无关; 与 A.29 记录基线一致, 不劣化)。
- **真机端到端(关键, 前次漏了这层)**: 临时 driver 用**真实 LocalJobRegistry + 真实 SSH(203.0.113.10/ubuntu)** 走完整 start→job_output/job_list→snapshotJsonValue + JSON.parse(JSON.stringify) 往返:
  `A read#1 text type=string="START-A\n"`; `job_output(A running) lossless OK`; `job_list(2 running) lossless OK`; `B wait=killed detail=signal: TERM`; `A wait=completed detail=exit code: 3`; `a.out="DONE-A"`; `job_output(A completed) lossless OK`; **RESULT: PASS**。远端 /tmp/dsh-ssh-e2e-* 已清理。
- 服务: 重启 3090(dsh-ssh-dev, 停旧 6920 → 新 **PID 34084**, 插件 profile 下 @dsh-ssh/dsh-ssh 是到 <repo>/packages/dsh-ssh 的 Junction, 改动自动生效); HTTP 200(http://127.0.0.1:3090/), web.err.log **空**, web.pid=34084。

**红线**: core 零修改; 未碰 PID 9604(dsh web); tools.js 仅有 startRemoteBackground 区域(本改未动); 远端仅 /tmp/dsh-ssh-jobs-* 可写且已清理。

### A.31 审计定位: 前端会话 ID 映射机制 + f1f0e1b2 会话排查结论(2026-08-19, 审计子代理, 只读)

> 目标: 定位并审阅 3090/dsh-ssh-dev 会话 f1f0e1b2-42a3-4204-adea-948f99f774e6(用户观察到的 web 会话 ID)。

**一、前端会话 ID ↔ host 存储映射机制(核心, 含行号; core 只读 <dsh-checkout>\node_modules\@deepseek-ai\)**

- **前端会话 ID == host SessionId == 落盘目录名, 无任何客户端缩短/映射**: dsh-host-apiproxy/lib/index.js **L2419** listVisibleSessionSummaries(直接透传 host session.id); dsh-client-connection/lib/client.js **L6280** 把 session.list 走 unary 直通。
- **落盘路径** = `<sessions-root>/<encodeSegment(cwd)>/<encodeSegment(sessionId)>/session.jsonl.zstd`; encodeSegment 对 [A-Za-z0-9._-] 原样保留、其余转 `~XXXX`(dsh-session-persistence-jsonl/lib/index.js **L83**(encodeSegment) / **L145**(sessionDir) / **L156**(logPath) / **L118**(projectKey))。**目录名 = sessionId 原样**, 是否带 `session-` 前缀取决于创建方式: host create/fork 生成 `session-<uuid>`(apiproxy index.js **L2519** create / **L2731** fork); 客户端 session.create 自定义 id 或**子代理会话**为裸 uuid(实测本审计子代理 id=d41cecf1-... 落盘即裸 uuid 目录, 对应当前正在 `--D-Code-AI-ddsh--/d41cecf1-.../session.jsonl.zstd`)。
- **api 通道有两条, 勿再混淆**(此前 /api/sessions/list 等 404 的根因):
  - **(A) ApiProxy "unary" 通道**: session.* / workspace.* / subagent.* / host.* / goal.* / … URL 用**点号方法名**, body=client-request 信封 `{type:"client-request",rpcId,method,payload}`。列出/取内容: `POST /api/session.list`(payload {})、`POST /api/session.history`(payload {sessionId,beforeSeq?,maxMessages?}); 子代理 `/api/subagent.list`(需 parentSessionId)/`/api/subagent.history`。实现: dsh-host-apiproxy/lib/index.js **UNARY_ROUTES L4608**、toFetchHandler **L4922-4980**、handleUnary **L4855**。
  - **(B) Typert 网关通道**: 有 typertRemote 命名空间的 host 服务(goals/commands/pluginInventory/**dsh-ssh 的 ssh**), URL=`/api/<namespace>/<method>`, body=`{"args":{...}}`(dsh-api-gateway/lib/index.js; dsh-client-connection/lib/index.js **L535-548** 先让已注册 typert interceptor 认领, 未认领回退 apiProxy)。`/api/ssh/listHosts` 走此通道; **sessions 不在 typert 命名空间 → 这就是 ssh 通、session 404 的根因**。

**二、f1f0e1b2 定位结论: 当前 3090/dsh-ssh-dev 实例查无此会话(证据充分, 已实测)**

- `POST /api/session.list`(3090)全部 sessionId: **不含** f1f0e1b2。
- `POST /api/session.history`(3090)对 `session-f1f0e1b2-...` 与裸 `f1f0e1b2-...` 均返回 **session-not-found**。
- 递归搜 <home>/.dsh 下 `*f1f0e1b2*`: **0 命中**(DSH_HOME 唯一、sessions 根唯一; node_modules/profiles 已排除)。
- 因 A.30 已将 3090 服务重启(旧 PID 6920 → 新 **PID 34084**, 见 A.30 L1527), **重启前的纯内存/UI 态会话(未落盘)不复存在** —— f1f0e1b2 极可能就是这一类(另一 profile/实例 web 展示 id、未落盘的子代理/内存会话、或已被清理), 而非可落盘的 host session。

**三、审阅发现(目标会话内容不可得 → 转向机制核验)**

- **目标会话正文无法审**(见二)。另: dsh-ssh **远端工作区会话在本地只是占位 stub** —— 实测 session-3a9c8191 / d96b255d / fec881b2 / 3d9251d4 解压后仅 ~270B 的 session-open 头、无对话正文(会话语料活在远端主机; 红线禁连远端)。→ 本地无远端会话正文可审, 属当前架构使然(M5 已知坑: 尚未把远端会话日志同步回本地)。
- **机制层核验(源码, 非实测)**: ① run_in_background 接入见 A.22: packages/dsh-ssh/tools.js startRemoteBackground(L371-395) → ctx.get('jobs').start({kind:'bash', run:createRemoteBashJobHooks}) 返回 {kind:'background', jobId}; backgroundEnabled 参数广告 tools.js L540。② job_output/job_list/job_kill 经 A.30 修复后为**同步 readOutput + run() 三键契约**, 真机 end-to-end PASS(A.30 L1525-1526)。③ 能力面注入(A+C 特性): packages/dsh-ssh/index.js `CAPABILITY_SECTION_NAME='dsh-ssh:capability-surface'`(L145) + injectCapabilitySurface(L162-163) 经官方 agent.ctx.systemPrompt.section 通道在 agent/created 对**远端 cwd** 会话注册(A.26)—— system prompt 是否真出现该段需读远端会话正文, 本地 stub 不可核验。
- **建议**: 若要审阅远端会话正文, 需在允许连接远端时读取, 或后续 M5 做"远端会话日志同步本地"; 同时在 3090 真机 GUI 用 /api/session.list 与界面显示 ID 逐项对照, 确认 f1f0e1b2 来源。


**红线**: 全程 core 零修改(仅只读); 未重启/干扰 3090(仅只读 API 探测); 未连远端 SSH。

### A.33 修复/复核: 远端 bash 后台任务"假完成 + 读不到输出"真机排查(2026-08-19, 子代理)

> 症状(任务书): 远端工作区里 bash run_in_background:true 启动长任务(sleep 600), 约 3.8s 就被上报 "completed, exit code 0", job_output 返回 "(no new output)" 读不到输出; 前台 bash(sleep 3)精确计时正常。目标: 远端后台任务真实驻留(sleep N 期内存活 status=running)、job_output 按增量读、job_kill 杀进程组。

**1. 结论(一句话根因 + 现状判定)**

- **当前仓库代码已满足全部验收标准, 无需再改生产代码**。任务书描述的"假完成/读不到输出"对应 **A.22 之前的旧设计**(done 错误依赖 spawn exec 通道 close 事件当成进程退出 → 通道在 echo $! 后即关 → 误报 completed)与 **A.30 之前的旧 readOutput**(async SFTP 读返回 Promise 使 job_output 报非 lossless JSON / 读不到输出)。这两坑已在 A.22(A.17 方案1(b)+ 红线① setsid/cd 内嵌 + 红线② kill 覆盖进程树)+ A.30(同步 buffered 游标 readOutput + run() 三键契约)修复; 本次用**真实 LocalJobRegistry + 真实 SSH** 端到端复核证实当前代码正确。
- 若真机仍见 3.8s 假完成, 是**运行中的服务进程早于修复加载了旧模块**(Node 不热更); dsh-ssh-dev profile 下 @dsh-ssh/dsh-ssh 是指向本仓库的 Junction, 重启该服务后加载的就是当前代码。

**2. 复核证据(当前代码, 出处 packages/dsh-ssh/src/remote-jobs.js 行号)**

- done 判定**不依赖 exec 通道 close**: 轮询 `isAlive()`(kill -0 probe, L103-110)+ `readStatusFile()`(status 文件, L112-122)收敛。进程 ALIVE + 无 status 文件 → 持续 sleep(pollMs) 轮询(L157-178), 绝不提前 resolved —— 这是"真实驻留"的来源。
- `$!` PID = setsid 起步的 bash(独立 session/进程组组长, PID==pgid), 非已退出的中间进程; 实测该进程长驻直至命令结束。
- 输出: 后台命令重定向到 log 文件(非 /dev/null), `refreshLog()`(L139-145)轮询经 SFTP 拉增量到本地 buffered, `readOutput()`(L147-151)**同步**切游标增量返回 → job_output 能读到 echo 增量。
- kill: `buildKillTreeCommand(pid)`(L55-57)= `kill -TERM -- -<pid>` 覆盖进程组 + `pkill -TERM -P` 补杀孙进程; cancel(L183-188)下发; 实测远端 ps 确认进程组无残留。
- **关键契约(A.30 续)**: 官方 registry 的 read() 不 await readOutput(dsh-jobs-local/lib/index.js L190)且 text 必须 string; 本实现同步缓冲+游标对齐(remote-jobs.js L16-22 注释)。

**3. 真机端到端实测(203.0.113.10/ubuntu, 仅 /tmp/dsh-ssh-verify-jobs 与 /tmp/dsh-ssh-e2e, 测完清理)**

- **全链路真实 LocalJobRegistry 驱动**(临时 driver, 已删): start(sleep 30) → read@2s text="HELLO\\n" status=running → read@5s status 仍 running(**非 completed**) → kill→killed(signal: TERM) → 远端 ps 进程组 NONE → RESULT: PASS。
- **test/live-jobs.mjs**(既有可复跑脚本): 2 并发任务 A(sleep 4 exit 3)/B(sleep 20) → readOutput 增量 START-A/B-START, cancel B→killed 且 ps NONE, 等 A→completed exit code: 3, 输出文件 DONE-A 落盘 → RESULT: PASS。
- **新增 test/live-background-verify.mjs**(本次新增, 可复跑): sleep 30 → @5s status=running(done pending) + readOutput="TICK-1\\n" → cancel→killed → ps 进程组 NONE → RESULT: PASS。

**4. 单测(packages/dsh-ssh/test/remote-jobs.test.js 新增 3 例回归守卫)**

- `长任务不假完成`: aliveCount=Infinity(进程永远 ALIVE)+ 无 status 文件 → done 在 250ms 内**必须 pending**(race 断言 settled=false), 再写 status 收敛 completed。直接钉死"通道关闭即假完成"的旧缺陷。
- `运行中读增量输出不会 settle`: 进程存活时 _refresh+readOutput 增量读不改变 done 状态。
- `cancel 后即使进程短暂仍存活也收敛 killed 且进程树无残留`: aliveCount=3(先 ALIVE×3 再 DEAD)模拟信号延迟, cancel 后收敛 killed + 杀进程组命令 + status/log 清理。

**5. 测试基线 & 红线**

- 全量 `node --test test/*.test.js`(packages/dsh-ssh)→ **tests 250 / pass 240 / fail 10**(改前 247/237/10; 净增 3 过, 无回退)。fail 10 = Windows path.sep 既有问题(tools-search / router / placeholder / remoteRoot 等), 与本次无关、不劣化。
- core 零修改; 远端零安装(仅 sshd exec + SFTP); 远端仅 /tmp/dsh-ssh-verify-jobs 与 /tmp/dsh-ssh-e2e 操作并已清理; 未触碰其他子代理的 /tmp/dsh-ssh-bench-* / dsh-ssh-m3b-* 残留。



## 附录 B: bash 工具卡片自定义 toolview(客户端覆盖, 修远端占位 cwd 显示)
**日期/验证**: 2026-08-19; 纯客户端 client.js 改动 + 逻辑单测 20/20, node --check 通过; 真机渲染待 GUI 重启核验。

**问题**: 远端工作区会话 cwd = 本地占位目录 `<root>/remote/<hostId>/<base64url(远端绝对路径)>`(M4, src/router.js encodeRemotePath)。官方 bash 卡片 BashRow(@deepseek-ai/dsh-client-ui-tool/lib/client.js:1146-1247) 把 cwd 最后一段经 primitives promptLabel(取路径最后一段)直接显示, 于是用户看到 base64(如 `L2hvbWUvdWJ1bnR1L29wZW5jb2RlLWFwaQ`)。

**宿主侧为何不能修(调研确认)**: presentCall 只拿 args(无会话/路由上下文, dsh-tool-bash/lib/index.js:143-147 只在 args.workdir 存在时才写 callView.cwd); workdir 缺失时终端卡片 fallback 到 sessionCwd(会话占位路径), 且路由**依赖** base64 段解码远端真实路径(目录名不能改) → 只能客户端 toolview。

**槽机制(源码出处)**:
- `tool.call.toolview` = keyed 槽(scope:session), 按 wire 工具名 key 派发: dsh-client-ui-tool/lib/types/client/contract/slots.d.ts:20-25。
- 官方 bash 行以 key:'bash' 默认 priority 0 注册(bashToolviewSample, client.js:1252-1266); 组件 props = owner 标准套件(session 作用域注入 useSessions/sessionId/t 等)。
- keyed 槽每个 key 单 cell, 最低 priority 渲染胜出(替换官方): dsh-client-ui-slots/lib/index.js register(options,component) 64-144 + entriesOfSlot 179-194(同 key 同 priority 会 throw, 故用 priority:-1)。
- 派发: dsh-client-ui-tool/lib/client.js ToolCall renderSlot("tool.call.toolview", owner, {entryKey:toolName, fallback:GenericToolCard}) L864-895。

**实现**(packages/dsh-ssh/client.js): key:'bash' priority:-1 注册 BashSshRow; 逐字复刻官方 BashRow(模型/渲染同步自 @deepseek-ai/dsh-client-ui-tool@0.1.0-rc.7, 与仓内 verbatim-copy 惯例一致), **唯一差异**: 渲染前把终端卡片的 card.cwd 经 sshDecodeRemoteCwd 解码(命中 `<...>/remote/<hostId>/<base64url>` → 可读远端绝对路径, 可带占位下子目录后缀); 本地不命中 → 原样返回, **显示逐字节不变(不回归)**。解码镜像 router 的可逆守卫(base64url 单段正则 + atob/TextDecoder(utf8,fatal) + 往返一致 + 需解码为 '/' 开头绝对路径 + hostId 合法 + 'remote' 锚点), 误判近乎不可能。

**验证**: node --check client.js 通过; 解码/模型单测 20/20(远端占位解码、base64url 往返、非法/非规范回退、本地路径逐字节不变、running/settled/failed 三种 block 的 title/summary/terminal cwd)。客户端无 browser 渲染测试(纯 client.js), 真机渲染待 GUI 重启。

**已知**: 若 workdir=占位路径下的子目录(非常见), sshDecodeRemoteCwd 会带后缀拼回, 结果正确; 本地路径与占位形态撞车的误判经 'remote'+hostId+可逆解码三重守卫排除。


---

### A.35 修复: 远端 bash 后台任务"秒完成零副作用"根因=远端 jobDir 从不建目录(2026-08-19, 子代理)

> 症状(任务书): 3090 真实服务(dsh-ssh-dev profile, standard preset + agent/created ⑤ hook 路由)远端工作区会话执行 bash run_in_background:true → 返回 "started background job bash-N", 数秒内变 completed/exit 0, job_output 永远 (no new output), 远端零副作用。而 test/live-background-verify.mjs(直连 createRemoteBashJobHooks + 真实 LocalJobRegistry + 真实 SSH)全过 —— **直连 harness 正常、真实服务语境失败**。A.33 结论"当前代码已满足"覆盖不到这条真实服务路径(它只做了直连复核, 未走 startRemoteBackground→jobs.start→agent/created 遮蔽的端到端)。

**1. 根因(一行)**

startRemoteBackground(packages/dsh-ssh/tools.js L371-395)用 defaultRemoteJobDir(hostId) = /tmp/dsh-ssh-jobs-<hostId> 作 jobDir 传给 createRemoteBashJobHooks, **但从不 mkdir 该目录**; buildSpawnCommand(src/remote-jobs.js L49-52)的 `><token>.log` 重定向在目录缺失时打开失败 → 后台进程秒死、log/status/副作用文件一律不落盘 → done 轮询(L157-178)首轮 isAlive=DEAD 且 readStatusFile=null → L165 `!alive||ec!==null` 压成 `completed 'exit code: 0'`。这正是"秒完成/exit 0/无输出/零副作用"的完整机制。

- **直连 harness 为何正常**: live-background-verify.mjs / live-jobs.mjs 在起 job 前显式 `conn.exec('mkdir -p <JOB_DIR>')`(self-created jobDir), 目录存在故重定向成功; 真实服务从不建目录, 于是两路径行为分叉。
- **官方 tool-bash 对照**: 官方 run()(dsh-tool-bash/lib/index.js L418-425)是本地进程缓存读 + 真实本地 shell, 无"/tmp 远端目录"概念, 不存在此坑 —— run/hooks 契约是一致的(形状均为 {cancel,done,readOutput}; dsh-jobs-local/lib/index.js L138 `spec.run()` 同步调用、L166 `hooks.done.then` settle), 是**远端实现独有**的启动静默失败。

**2. 修复(packages/dsh-ssh/src/remote-jobs.js, 两处)**

1. **spawn 前幂等建目录(root cause)**: createRemoteBashJobHooks 的 spawned IIFE 先 `await conn.exec('mkdir -p ' + shellQuoteSingle(jobDir), {timeoutMs:15_000})` 再 buildSpawnCommand 下发(L87-104, A.35)。单前台 exec、失败即抛 → spawned reject → done reject → registry force-fail 为 failed。不改 buildSpawnCommand(纯函数保持 setsid 首 token, 既有单测不变), 不改 run/hooks 契约。
2. **启动静默失败 surfaced as failed(掩蔽修复, 任务要求的防御)**: done 轮询非 cancelled 分支改为 `if (!alive && ec===null) status={status:'failed', detail:'background process exited before reporting an exit status (<statusPath>); spawn/startup failed'} else if (!alive || ec!==null) status={status:'completed', detail:'exit code: '+(ec??0)}`(L170-178)。**ec=null 且从未 alive 过绝不再报 exit 0** —— 只有 status 文件真实写入过才算正常退出。

**3. 复现/验证证据(真实组合端到端, 新增 scripts/verify-remote-bg-created.mjs)**

- 装配同 verify-agent-created.mjs(真实 cordis host + dsh-ssh-dev profile bundle + agent/created 钩子, 排除 web-app); 先把 /tmp/dsh-ssh-jobs-<hostId> rm -rf 制造"目录缺失"复现条件; 经 `remoteAgent.ctx.tools.get('bash', remoteAgent)` 以 run_in_background:true 调用, 真实 jobs registry 驱动(与 job_output/job_list/job_kill 同源)。
- **修复前**(同样"目录缺失")用 createRemoteBashJobHooks 直连复现: spawned 解析到 pid 但 ps NONE / kill -0 DEAD / jobDir 无任何文件 / done 280ms 内 races 到 `completed exit code: 0` —— 精确复现真实服务症状。
- **修复后**同一脚本(目录仍先删掉, mkdir 自动重建): `bash run_in_background result={kind:background, jobId:"bash-1"}`, @2s status=**running** output="TICK-1\n", @5s status=**running**(未假完成), 远端 ps 见 sleep 30 存活、jobDir 有 .log/side.txt(副作用落盘), jobs.kill → 立即远端 ps NONE(进程组已灭) → snapshot 收敛 **killed detail=signal: TERM**, after-kill ps NONE。**RESULT: PASS**。
- 远端证据只在 /tmp/dsh-ssh-* 与只读查看; 测完清理, ps 扫描 NONE + jobDir 已删; 临时脚本已删, 保留 verify-remote-bg-created.mjs 供回归。

**4. 回退基线 & 红线**

- 全量 node --test test/*.test.js(packages/dsh-ssh)→ tests **260** / pass **250** / fail **10**(改前 258/248/10; 净增 2 过 = remote-jobs.test.js 新增"先 mkdir 再 spawn" + "死而未写 status → failed"两例; fail 10 仍为 Windows path.sep 既有问题, 不劣化)。
- core 零修改; 未碰 dsh-web-app/其他 bundle; 远端零安装、仅 sshd exec+SFTP; 本地会话行为逐字节不变(本地 bash 不走此分支)。

### A.36 需求/实现: SFTP 禁用降级——exec 通道 base64 传输兜底(2026-08-19, 子代理)

> 任务书: SFTP 子系统被禁时自动降级到 exec 通道 + base64 + shell 内置命令(cat/ls/stat/test/mkdir/rm 等, TRAMP 式), 与 SFTP 路径语义对齐; 默认仍走 SFTP、只在不可用时触发降级; core 零修改、远端零安装、SFTP 可用时行为逐字节不变。

**1. 问题**
远端 sshd 若禁用 SFTP 子系统(Subsystem sftp 注释/禁用), 所有 ssh2 SFTP 文件操作全部失败: read/write/edit/read_image 的 sftp 分支(tools.js)、远端目录浏览/stat(remote.js listRemoteDir/statRemote)、remote-jobs 的日志/status 拉取与清理(remote-jobs.js readBytes/unlink)。

**2. 设计(决策记录见 .agents/notes/decisions/)**
- (1) 连接级统一访问入口 SshConn.fs()(src/ssh-core.js): SFTP 可用→返回 SftpWrapper(行为逐字节不变); 首次调用做能力探测 sftp()——成功即缓存; 失败(sftp-open/通道拒绝)→置 _sftpUnavailable=true 并返回 ExecFs(降级)。不缓存失败的 sftp 承诺(避免后续 sftp() 复用 rejected promise)。重连(pool.invalidate 新建 SshConn)自动重置探测(新连接字段归零)。测试/运维开关 cfg.forceExecFs 强制走降级(真机 no-sftp 模拟用, 不改远端 sshd)。
- (2) 降级层 src/exec-fs.js(新, ExecFs): 与 SftpWrapper 对齐的最小方法集 readBytes/readText/writeFileAtomic/stat/exists/listDir/unlink/mkdir/rename/rmdir。解析一律 locale 无关: stat 用 test -d/-f + stat -c 的 %s/%Y(不 parse 人类可读 ls); readdir 用 find -printf(机器可读); 二进制统一 base64。原子写: 同目录随机临时文件 base64 写 + mv -f 发布, 失败清理临时文件。错误 stage 前缀 execfs-(hostId/stage 照常)。
- (3) 上层调用点全部改走 conn.fs() 而非直接 conn.sftp(): tools.js 四工具、remote.js(listRemoteDir/statRemote)、remote-jobs.js(readBytes/unlink)。SFTP 可用时 fs() 返回 SftpWrapper → 原路径不动; 降级只在不可用时触发。
- (4) SftpWrapper.stat 补返回 mtime(statRemote 统一走 fs.stat 不丢 mtime; readRemoteText/write 只读 type/size, 向后兼容)。

**3. 实测坑(本实现命中的真实约束, 务必遵守)**
- exec 命令串有硬上限: ssh2 exec 把整条命令作为通道请求发出; 实测约 131072 字符时远端 shell 已 code=1、262144 报 exec-open 'Unable to exec'、349524 直接 'Not connected'(断连)。因此『写』的 base64 是经命令行参数下发→写分块必须小: DEFAULT_WRITE_CHUNK_BYTES=48KB 源(→64KB base64 字符 + 开销, 稳落安全区)。『读』的 base64 从 stdout 回传(命令本身简短)→读分块可取大: DEFAULT_READ_CHUNK_BYTES=256KB 源。
- tmp 路径禁用 node:path: 本机为 Windows 宿主时 path.join(dirname(远端POSIX路径), ...) 会产出反斜杠分隔的路径, 远端 Linux 会把它当单文件名落错目录。ExecFs 手写 POSIX dirname/basename(远端路径恒为斜杠风格)。(既有 SftpWrapper 同用 node:path.join 属既有行为未动; SFTP 可用时保持逐字节不变。)

**4. 改动文件清单**
- src/exec-fs.js(新增降级层)
- src/ssh-core.js(SshConn.fs() + 能力探测 + _sftpUnavailable + import; SftpWrapper.stat 补 mtime)
- tools.js / src/remote.js / src/remote-jobs.js(调用点 sftp.*→fs.*, conn.sftp()→conn.fs())
- test/exec-fs.test.js(新增 12 例: stat/readBytes 文本+二进制+大文件分块/writeFileAtomic 原子+多分块/unlink/mkdir/rename/listDir; SshConn.fs 探测 forceExecFs/sftp 抛错/sftp 正常/承诺不缓存)
- 测试 fake conn 补 fs(tools-remote / tools-sandbox / remote-jobs / remote 的 makePool/makeFakeConn/内联 conn)
- scripts/verify-execfs-fallback.mjs(新增, 真机 no-sftp 全链路验证, 可复跑)
- scripts/functional-live-test.mjs(B10-3 由『SFTP 不可用→read 报 sftp-open 错误』改为『→降级走 exec 正常读回』, 断言新语义)

**5. 验证结果**
- 单测: 全量 node --test test/*.test.js → tests 272 / pass 262 / fail 10(改前 260/250/10; 净增 12 过 = exec-fs.test.js; fail 10 仍为既有 Windows path.sep / preset-auto-install 沙箱问题, 不劣化, 与 A.33/A.35 同源)。
- 真机(203.0.113.10/ubuntu): 用 forceExecFs:true 开关模拟 SFTP 禁用(未动真实 sshd 配置), 对 /tmp/dsh-ssh-sftp-fallback 全链路 18/18 PASS——二进制/text base64 往返(与 SFTP 路径交叉互读一致)、stat 文件/目录/缺失、readdir 与 SFTP 结果一致、rename/unlink/mkdir、600KB 大文件分块写+读完整往返、后台任务(createRemoteBashJobHooks + 降级 conn)live 输出经 execfs 增量拉取 + completed + 终态 marker 持久读 + log/status 降级清理。测完已清理 /tmp/dsh-ssh-sftp-fallback 与 /tmp/dsh-ssh-jobs-fb(ls 确认 NONE)。

**6. 红线复核**
- core 零修改(仅本包 src/*); 远端零安装(仅 sshd exec + 系统自带 test/stat/find/mkdir/mv/rm + coreutils base64/dd); SFTP 可用时默认仍走 SFTP(fs()→SftpWrapper), 降级只在探测失败/forceExecFs 时触发; 本地工作区本地路径不触此分支。

### A.38 测试工程债清理: 修 10 个 Windows path.sep 基线失败 + 统一 live 配置 + 清残渣 (2026-08-19, 子代理)

> 任务书: 修长期被"既有问题"惯着的 10 个单测基线失败(可修测试断言或归一化, 不得改生产代码语义迁就 Windows; 确属生产代码 bug 则修生产代码并注明); 把 live/verify 脚本硬编码的主机 / HOST_ID uuid / 私钥路径统一到一处(全支持环境变量覆盖); 删 scripts/_repro-client-mount.mjs 等残渣。红线: core 零修改; 远端只动 /tmp/dsh-ssh-*。本次回写使用编号 A.38(最高实测 A 段为 A.36, A.37 保留给并行回写者, 碰撞安全)。

**1. 10 个基线失败归类与处置**(基线: tests 272 / pass 262 / fail 10; 修复后 272/272 fail=0。A.33/A.35/A.36 都把这批当"既有"惯着, 本次根治)

| 失败(测试文件) | 根因 | 处置 |
|---|---|---|
| toWorkdirRelative 显示 / 远程 glob 3 例 / 远程 grep 显示(tools-search.test.js, 共 5 例) | src/search.js 的 toWorkdirRelative 用平台 path.relative/sep 呈现远端 POSIX 路径 → Windows 下变 `sub\\a.ts`; 连带远程 glob 本地 matcher(`src/**/*.test.ts` 遇反斜杠不命中)、root 显示、grep path 显示全错 | **改生产代码**: toWorkdirRelative 改用 node:path 的 posix(远端路径恒为斜杠; Windows 显示反斜杠是真实 bug) |
| remoteRoot(2) + mapRemoteToLocal(1)(router.test.js) | 生产返回**本地原生路径**(带盘符/反斜杠, 语义正确), 测试硬编码 POSIX 串 | **修测试**: 加 toPosix 归一化(去盘符 + 反斜杠→斜杠)再断言 |
| resolveRemotePath 占位重定位(router.test.js) | posix.relative(placeholderCwd, …) 对 Windows 原生占位路径(非 posix 绝对)不命中 → 占位前缀重定位失效 | **改生产代码**: 非 posix 绝对分支改用平台 path.relative 判"位于占位根下", 命中则 rel.split(sep).join('/') 转 posix 再 join 远端 cwd |
| createPlaceholderDir DSH_HOME 尊重(m4-placeholder.test.js) | 同 remoteRoot: 生产落于本地根(正确), 测试硬编码 POSIX startsWith | **修测试**: toPosix 归一化 |
| 把包内 preset 同步到 home(两次幂等)(preset-auto-install.test.js) | 生产用 path.join 构造本地目标(正确); 测试硬编码 POSIX 路径/键, 且 mock readFile 未归一化读入路径 | **修测试**: 期望目标用 path.join 构造; mock readFile 键归一化到 POSIX |

边界结论: 凡映射到**本地占位目录 / 本地 home** 的返回值用平台 path.join(原生分隔符)是正确语义; 凡**呈现 / 解析远端 POSIX 路径**或做占位前缀重定向必须走 posix。修复后 Windows 与 POSIX 宿主行为一致(单测在 Windows 上 272/272)。

**2. 统一 live 配置 — test/live-config.mjs(A.38 新增)**
- 一处定义 host / port / user / hostId / keyPath / remoteRoot; 全部支持环境变量覆盖: DSH_SSH_TEST_HOST / DSH_SSH_TEST_PORT / DSH_SSH_TEST_USER / DSH_SSH_TEST_HOST_ID / DSH_SSH_TEST_KEY_PATH / DSH_SSH_TEST_REMOTE_ROOT。
- 默认 = 当前可用真机配置: ubuntu@203.0.113.10:22, 私钥 id_rsa(默认值为 ~/.ssh/id_rsa, 由 ssh-core 的 expandHome 经 os.homedir() 解析), hostId 00000000-0000-4000-8000-000000000000, remoteRoot=/tmp/dsh-ssh-test-root。
- 导出 liveConfig + liveHostConfig()/secondaryHostConfig(); 所有 live/verify/bench 脚本改从这里读: test/{live-jobs,live-background-verify}.mjs、scripts/{bench,live-smoke,tools-live-smoke,sandbox-live-verify,verify-execfs-fallback,verify-agent-created,verify-remote-bg-created,functional-live-test}.mjs(scripts 侧用相对导入 ../test/live-config.mjs)。顺带修掉此前密钥默认不一致(id_rsa 与 id_ed25519 并存)与主机/uuid/密钥路径散落各处的问题。

**3. 残渣清理**
- 删 scripts/_repro-client-mount.mjs(头注自述"复现后删除")、scripts/_probe-e2e.mjs; 全仓扫描确认无其它 _repro / _tmp 残渣。
- 注: scripts/_probe3.mjs 是并行 e2e-web 子代理的进行中探针(与 scripts/e2e-web-3090.mjs 同源, 端口 3090 会话), 为不打断其进行中进程本次未删, 待其收尾后再清。

**4. 验证**
- 单测: node --test test/*.test.js(packages/dsh-ssh)→ tests 272 / pass 272 / fail 0(修复 10; 总数不变因未删/未增单测)。
- 真机: test/live-background-verify.mjs → RESULT: PASS(统一配置直连 ubuntu 后台任务 sleep30, @5s 仍 running、job_output 读到 TICK-1, kill 后进程组灭, 清理); scripts/live-smoke.mjs → LIVE-SMOKE-OK(证实 scripts/ 侧 ../test/live-config.mjs 相对导入路径同样可用)。全部改动 .mjs 经 node --check 通过。
- 红线: core 零修改(仅本包 src/{search,router}.js 生产修复 + test/* + scripts/* + 新增 live-config); 远端只动 /tmp/dsh-ssh-*(测完已清理)。

**备注**: 与 A.36 的"fail 10 仍为既有 Windows path.sep 问题"表述互为修正——本条目即这批问题的根治记录。

### A.39 实施: 3090 全工具 E2E —— scripts/e2e-web-3090.mjs (2026-08-19, 子代理)

> 任务书: 通过 3090 的 HTTP API 驱动真实 web-app 会话, 对远端占位工作区(00000000-...0/L3RtcC9kc3NoLWUyZS13ZWI = base64url('/tmp/dsh-ssh-e2e-web'))跑 8 组工具用例。单文件、可复跑、断言失败 process.exit(1)。红线: 不重启/不停止 3090; 只创建 scripts/e2e-web-3090.mjs、删除 _probe3.mjs; 输出纪律(轮询不打原始 JSON, 只累计计数+关键摘要)。

**0. 结果**: node scripts/e2e-web-3090.mjs 二轮实跑 → 8/8 全绿(fail=0, 退出码 0)。首轮 7/8 因断言大小写 bug 误报(见 §4)。_probe3.mjs 已删; git 新增仅 e2e-web-3090.mjs。

**1. 信封与 API(已验证)**: base=http://127.0.0.1:3090; POST /api/<method> 信封 {"type":"client-request","rpcId":"x","method":"<m>","params":{},"payload":{...}}。
- session.create {cwd,agentPreset:"standard"} → result.value.sessionId
- session.selectModel {sessionId,provider:"fusion-router",model:"deepseek-v4-flash"}(必需, 否则默认模型不确定)
- session.prompt {sessionId,mode:"queue",content:[{type:"text",text}]}
- session.history {sessionId} → result.value.events, 每项 {event:{type,seq,data}}
单回合判定: 轮询(间隔3s,上限150s)新增事件出现 turn/end。每用例独立开 session(隔离后台任务状态与模型行为)。

**2. 工具事件解析**: tool/call.data={callId,name,arguments(JSON串)}; tool/result.data.message.content[0]={type:"tool-result",toolCallId,isError,content:[{type:"text",text}]}。用 callId 把 call 与 result 配对成 {name,isError,text}。

**3. 8 用例**(cwd=占位):
1 bash 前台 hostname && cat note.txt → isError=false 且输出含 note.txt 内容("hello dsh-ssh e2e")
2 write /tmp/dsh-ssh-e2e-web/e2e-write.txt → 无 isError
3 read 读回 → 含 "line one"
4 edit old "line one"→"line one Updated" → 结果含 "updated"(注意大小写, 见§4)
5 glob *.txt → ≥2 命中
6 grep "dsh-ssh e2e" → 命中
7 后台链: bash run_in_background=true(见§5)→job_list running→job_output 含 TICK→job_kill 成功; jobId 从 "started background job <id>" 正则提取
9 清理: bash rm -f e2e-write.txt e2e-probe.txt, 保留目录(ls 仍含 note.txt)

**4. 踩坑教训**:
- edit 工具结果文本是 "The file ... has been updated successfully."(小写 updated); 若断言 /Updated/(大写)会误判 FAIL。一律 case-insensitive /updated/i。
- 事件轮询必须用 ingested 游标(baseline=已处理事件数)只取增量, 否则历史累积事件被重复统计/误判新回合。

**5. 后台任务时序**: 任务书原始命令 5x5s=25s, 在"start 回合模型生成+轮询延迟+下一回合模型生成"耗时下 job_list 时已 completed(实跑复现"completed")。改为 12x5s=60s 保证 job_list 时仍 running, TICK 语义不变。

**6. 输出纪律落地**: 脚本只打印汇总表(≤60 行); 轮询不打原始 JSON。openSession/makePoller/findBy 复用; E2E_BASE 环境变量可覆盖服务地址。

**7. 复跑**: node scripts/e2e-web-3090.mjs(先确保 3090 在线)。退出码 0=全过 / 1=有失败。






### A.40 修复: 路由工具 escalation 字段条件暴露 —— 远端升级语义为"无效", 字段只在 escalationModes.length>0 时入 schema (2026-08-20, 子代理; 任务书: 修路由工具 schema 缺陷)

> 任务书红线: core 零修改 / 本地路径委托行为不变 / sandbox 三模式拦截语义(policy.js)不变。

**0. 真实事故回放(触发此任务的根)**:
- 场景: 远程工作区会话(sandbox=danger-full-access)里, subagent 给 bash 工具**反复传** `sandbox_permissions`/`justification`, 每次工具**硬报错死循环**:
  ```
  sandbox escalation to "<mode>" is not strictly wider than this call's current "danger-full-access" mode
  ```
- 逐回合模型看不到字段已无意义, 一直重试 → 工具链瘫痪。
- **根因**: 我们 tools.js 的 `buildRoutedToolDefinitions`(原 L509-510)用"宿主是否挂了 sandbox backend"(`ctx.get('shell'|'fs')?.sandboxMode === undefined`)来算 `bashEscalationModes`/`fsEscalationModes` —— 远端部署下后端总是挂着的(danger-full-access 也是"挂载"), 于是 `escalationModes=ESCALATION_TARGETS`(非空)→ schema 无条件写死了 `sandbox_permissions`/`justification` → 模型照 schema 传参 → 执行时 `approveEscalation` 判"不是严格更宽"(danger-full-access 已是顶)→ 每次报错。

**1. 根因核实结论(对照官方源码)**:
- 官方 **dsh-tool-fs**(`@deepseek-ai/dsh-tool-fs/lib/index.js`)与 **dsh-tool-bash**(`@deepseek-ai/dsh-tool-bash/lib/index.js`):
  - schema 字段只在 `escalationModes.length > 0` 时写入: fs L617(`...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {}`)与 L771(edit 同); bash L285(同款条件展开)。
  - `escalationModes = 能力事实`: fs L1082-1083 `defaultMode = ctx.fs.sandboxMode; escalationModes = defaultMode === void 0 ? [] : ESCALATION_TARGETS`; bash L221-222 同款。
  - **danger-full-access 下官方同样报错(非"忽略继续")**: `approveEscalation`(`@deepseek-ai/dsh-sandbox/lib/index.js` L92-111)先判 `WIDER_MODES[effectiveMode].includes(mode)`, danger-full-access 不在任何更宽表内 → 抛 "is not strictly wider"。故任务书 §3 结论:**官方也报错 → 保持一致, 只修 schema 暴露, 不实现"忽略继续"**。
  - escalationModes=[] 时模型硬传字段 → 官方报同形文案: fs L1123 "sandbox_permissions is not available in this composition (no sandboxing filesystem to escalate)"; bash L239 "...(no sandboxing executor to escalate)"。
  - 官方 mode fence(standing policy)来自 `sandboxPolicy.resolve(...)`, 与 escalationModes **解耦**(fs L1121-1122: 无升级参数就直接返回 standingPolicy)。

**2. 语义结论(写进设计的核心)**:
- **远端路由语境下 escalation 无意义**: 我们的"远端升级"即便审批通过, 也只是放宽**本地 executor**(`ctx.get('shell')/get('fs')` 委托的本地执行器), 对**远端(SSH)路径/命令零作用**。远端无本地 sandbox runner。→ **凡是为 remote cwd 路由注册的工具, escalationModes 必须为 `[]`**(schema 隐藏这两个字段), 与该后端是否挂载无关。
- 这与官方"escalationModes 只看是否有 confining backend"不矛盾: 官方工具只服务本地, 挂载即业务上可升级; 我们的路由工具服务远端时, 业务上**不可升级**。
- **三模式拦截语义与升级彻底解耦**: 有效模式( read-only / workspace-write / danger-full-access )恒由 `resolveRemoteSandboxMode` 决定, 与 escalationModes 无关; escalationModes 只控制"升级杠杆"(广告 + approveEscalation)。

**3. 修法(改动文件)**:
- `packages/dsh-ssh/tools.js`:
  1. `buildRoutedToolDefinitions`: 新增配置 `config.remoteRouting === true` → `bashEscalationModes=[]`/`fsEscalationModes=[]`(字段隐藏); 默认 false 保持现状(preset 挂载路径 local 委托的升级语义与官方逐字一致)。对齐官方"仅 escalationModes.length>0 才入 schema"(字段展开本就按 `...escalationModes.length > 0 ? {...} : {}`, 现在把 escalationModes 从源头管住)。
  2. `resolveRemoteEffectiveMode`: 把 mode fence 与 escalation **解耦** —— 先 `resolveRemoteSandboxMode` 取 standingMode, 无升级参数即返回它(三模式拦截原样保留); 有升级参数且 `escalationModes.length===0` → 抛官方同形 "sandbox_permissions is not available in this composition (no sandboxing executor/filesystem to escalate)"; 否则才 `approveEscalation`。修复了旧实现里 escalationModes=[] 时"返回 null、跳过 fence"的潜在漏洞。
- `packages/dsh-ssh/index.js`: `installToolRoutingHook` 里 `registerRoutedTools(agent.ctx, selected, { ...opts.config, remoteRouting: true })` —— 钩子只服务 remote cwd 会话/subagent, 强制关闭升级广告。
- `test/tools-sandbox.test.js`: 用 `apply(ctx, {remoteRouting:true})`(钩子等价形态)测远端; 断言三模式拦截保留、远端升级"不可用"报错; 新增 schema 条件暴露断言(remoteRouting→隐藏 / preset+backend→暴露 / 无 backend→隐藏); 保留 preset 挂载下升级仍可用(本地委托语义)的用例。
- `test/tool-routing-hook.test.js`: 补 subagent 语境两用例 —— (a) subagent 继承会话远端 cwd → 钩子遮蔽全七工具且 bash/write/edit escalation 字段隐藏(用带 sandbox backend 的 mock 证明 remoteRouting 确实在起作用, 否则漏回归); (b) subagent 本地 cwd → 钩子零介入。

**4. 验证**: `node --test test/*.test.js` → **280 tests, pass 280, fail 0**(基线 272 + 本次 8 个新用例, 全绿)。
- 产出物: tools.js / index.js / tools-sandbox.test.js / tool-routing-hook.test.js(仅此四文件, core 零改动)。

### A.42 删除: standard-ssh preset 全量移除(方案⑤后冗余) (2026-08-20, 子代理)

> 任务书: 方案⑤(agent/created 钩子按 cwd 路由, preset 无关, A.18)落地后 standard-ssh preset 完全冗余, 用户确认"这块都删掉"。包名已是 @dsh-ssh/dsh-ssh。

**删除范围(全部落地)**:
1. packages/dsh-ssh/preset/(agent.cordis.yml, preset.yml)整个目录删除。
2. packages/dsh-ssh/index.js 中 preset 自动同步逻辑全删: PRESET_ID/PRESET_FILES 常量、installBundledPreset()(含 autoInstallPreset 守卫与 apply() 内调用块)、随包 fileURLToPath/mkdir/readFile/writeFile 导入(仅剩 rm 供 placeholder cleanup); apply() 日志去掉 "preset auto-sync"。
3. packages/dsh-ssh/scripts/install-preset.mjs 删除。
4. packages/preset-standard-ssh/ 整个包删除(上游快照/build/validate/install-preset)。
5. packages/旧 scope 包/ 整个删除 —— 已先确认其内容仅为 preset 副本(与原 dsh-ssh/preset 两文件字节数一致: agent.cordis.yml 14200 / preset.yml 214)。
6. packages/dsh-ssh/test/preset-auto-install.test.js 删除; test/tools-sandbox.test.js 中 "preset 挂载 / standard-ssh preset" 措辞改为 "本地委托模式(remoteRouting=false)"。
7. packages/dsh-ssh/tools.js 的 apply()(原"preset 挂载路径 / standard-ssh 回退")经读码判断: 生产链(index.js)已不调用它(只用 registerRoutedTools 走 agent/created 钩子), 但 apply() 仍被 6 个测试/实机脚本 import 作为"本地委托模式(remoteRouting=false)"的注册助手(tools-local/remote/search/sandbox.test.js、functional-live-test.mjs、sandbox-live-verify.mjs) —— 属"还承担其它用途", 故保留 apply(), 注释改为"本地委托模式注册助手, 随包 preset 已删, 生产路由统一走 index.js 钩子"。未盲删。
8. packages/dsh-ssh/package.json 的 files 白名单去掉 "preset" 条目(留 scripts)。
9. 文档: agents.md(§3 改工具路由/方案⑤ 叙述 + 历史一段; §5 树去 preset/ 行; §9 删 preset 同步/验证命令; baseline 272→286)、packages/dsh-ssh/README.md(最小删除清理: 卸载说明去 preset、测试覆盖列表去 preset-auto-install、脚本清单删 install-preset 行; baseline 272→286, 余下待整体重写)。根 README.md 仍有 standard-ssh/install-preset/autoInstallPreset 引用 —— 任务书 §9 未列入处理范围(preset 相关文档待整体重写), 未改动, 列入残留清单。
10. 不碰磁盘 <home>/.dsh/.agent-presets/standard-ssh 已同步副本(主代理另行清理)。

**验证**: node --test test/*.test.js → 286 tests, pass 286, fail 0(原 287 去掉 preset-auto-install 1 例); node packages/dsh-ssh/scripts/client-selfcheck.mjs → OK(exit 0)。残留 grep standard-ssh|autoInstallPreset|install-preset 仅剩: agents.md §3 历史叙述(刻意保留一句)、根 README.md(L17/39/40/46/87, 未纳入任务范围)、及本笔记历史条目(A.4/A.8/A.19/A.26 等, 属历史事实不改)。core 零修改; 方案⑤ 路由能力无回退(e2e/路由测试保持绿)。

**理由**: 方案⑤(agent/created 钩子按会话 cwd 遮蔽七同名工具, 见 A.18/A.27/A.40)与 preset 无关, 官方 standard preset 即可; standard-ssh preset(含 install-preset 自动同步 / 产物包 / 旧 scope 副本)成为死代码与维护负担, 全删。

---

### A.41 改名: 项目 dssh → dsh-ssh + npm scope 旧 scope → @dsh-ssh (2026-08-20, 补记)

> 编号说明: 本条为补记(改名子代理未回写), 时序上先于 A.42; 按 §6.4 保留 A.42 编号不动。

**背景**: 用户决定项目完全改名 dsh-ssh（GitHub org/repo 已改 dsh-ssh/dsh-ssh）; npm scope 旧 scope → @dsh-ssh, 包名 @dsh-ssh/dsh-ssh。

**改动(两批)**:
1. dssh → dsh-ssh: 代码标识(dsh-ssh:capability-surface)、settings 命名空间 dssh-hosts → **dsh-ssh-hosts 带迁移**(src/settings.js LEGACY_HOSTS_NAMESPACE 只读回退; saveHost/deleteHost 首次编辑整体迁入新命名空间防孤儿化; test/settings-migration.test.js 7 例)、环境变量 DSSH_TEST_*/DSSH_REMOTE_ROOT/DSSH_VERIFY_SKIP_SSH → DSH_SSH_TEST_* 等、远端默认目录 /tmp/dssh-* → /tmp/dsh-ssh-*、全部文档/笔记(笔记由主代理逐模式 replace_all, L493 历史命令记录保留原样)。
2. 旧 scope → @dsh-ssh: package.json name/repository.url、cordis.patch.yml bundle id、代码日志前缀、根 package.json(name=dsh-ssh, plugin:add 修 profile 名与路径)、LICENSE 版权、删除重复的旧 .github/workflows/publish.yml(保留带测试门禁的 release.yml)。

**验证**: 单测 287/287 fail=0(含迁移 7 例); client-selfcheck OK(id=@dsh-ssh/dsh-ssh)。

---

### A.43 去本地化: 测试/脚本硬编码统一收编到 live-config.mjs (2026-08-21, 子代理)

**背景**: 测试与脚本此前混入本机硬编码值(3090 端口 / 本地绝对路径 / DSH core 路径 / profile 名), 好项目不应绑定单机。按 agents.md §7.2(测试不得绑定特定机器, 一切环境相关值经 test/live-config.mjs 读取并支持 DSH_SSH_TEST_* 覆盖)收编。

**收编清单(硬编码 → env)**, 全部落入 packages/dsh-ssh/test/live-config.mjs:

| 硬编码旧值 | env 出口 | 默认值(当前开发机仍可用) |
|---|---|---|
| 3090 端口/base URL(scripts/e2e-web-3090.mjs 的 base 与占位 cwd) | DSH_SSH_TEST_E2E_BASE(兼容旧 E2E_BASE) | http://127.0.0.1:3090 |
| 占位根 <home>/.dsh/remote | DSH_SSH_DSH_HOME 推导(placeholderRoot = dshHome/remote) | <os.homedir()>/.dsh/remote |
| DSH core 目录 <dsh-checkout>(两 verify 脚本的 CORE) | DSH_SSH_DSH_NODE_MODULES(resolveDshNodeModules 探测: env → 常见安装点 → npm 全局 prefix) | 探测命中当前机器路径 |
| DSH_HOME <home>/.dsh(两 verify 脚本 process.env.DSH_HOME) | DSH_SSH_DSH_HOME(resolveDshHome, 默认 os.homedir()/.dsh) | <os.homedir()>/.dsh |
| profile 名 dsh-ssh-dev(两 verify 脚本 loadProfile) | DSH_SSH_TEST_PROFILE | dsh-ssh-dev |
| 仓库绝对路径 file://<repo>/packages/dsh-ssh/{tools,src/router}.js(两 verify 脚本 import) | 改为 new URL('../xxx', import.meta.url) 相对到仓库内 | 仓库内相对解析 |

**其它脚本**: e2e-web-3090 占位 cwd 改为 `path.join(liveConfig.dshHome,'remote',liveConfig.hostId, Buffer.from(REMOTE,'utf8').toString('base64url'))` 动态计算, 不再写死用户/主机; 各 live/verify/bench 脚本头部补英文 PREREQ + 换机器说明(export DSH_SSH_TEST_* / DSH_SSH_DSH_*)。

**单测本地路径**: test/*.test.js 无机器绑定硬编码; 现存 <home>/project 等是路由逻辑的可移植 POSIX 绝对路径 fixture(远端/本地路由判定需要绝对路径), 非本机绑定, 不改。

**验证**: node --check 全改动脚本通过; node --test test/*.test.js = 286 pass / 0 fail(基线不回退); scripts/live-smoke.mjs 实跑 LIVE-SMOKE-OK(仅读远端 /tmp, 无残留需清理)。出处: packages/dsh-ssh/{test/live-config.mjs, scripts/*.mjs}。

---

### A.44 清理: packages/dsh-ssh 代码注释去过程化 + 英文化 (2026-08-21, 子代理)

**背景与规则**(按 agents.md §7.1 / §4.1): 代码注释此前混入大量过程化引用(M1–M5 / 方案⑤ / 内部方案一二级编号 A.xx / D-xx / F-xx / "修复/补充/曾经/以前/实测坑/定案/旧代码" 等历史叙述), 不了解项目历史的人无法读懂。本轮将所有代码注释清理为"当前行为 + 不变 why"的英文说明; 仅保留两类: ① 当前行为必要说明; ② 不随代码自明、长期成立的 why(外部契约、参数来源、官方源码行号出处如 dsh-jobs-local/lib/index.js L190)。**运行时字符串一律不动**(i18n 语言包 / schema description / 错误与日志文案, 即使含中文或方案字样也保持原样)。

**改动范围**(packages/dsh-ssh 全部代码文件, 不含 test/ 与 scripts/ — 另一子代理处理; 不动 .agents/ 与 agents.md/README):
- 顶层: index.js / tools.js / client.js
- src/: ssh-core.js / remote.js / search.js / router.js / exec-fs.js / remote-jobs.js / settings.js / placeholder.js / policy.js
- lib/: hosts-model.js / typert-contribution.js

**统计**: 清理约 14 个文件、数百条中文/过程化注释; 全部改写为英文当前行为说明。过程化引用点(粗略): Mx/A.xx/D-xx/方案⑤/F-xx/修复/补充/曾经/旧代码/实测坑/定案 等被逐一移除, 保留的事实性出处为官方源码行号(如 dsh-sandbox 威胁模型、dsh-tool-bash 契约行号等)。

**注意事项**: A.43 已被"测试/脚本去本地化"子代理占用(2026-08-21), 故本轮按"尾部最大号+1"编号为 **A.44**(并发回写不覆盖既有条目, 见 §6.4 另注)。

**验证**: 逐个文件 node --check 全过; node --test test/*.test.js = **286 pass / 0 fail**(基线不回退); node packages/dsh-ssh/scripts/client-selfcheck.mjs = **client.js static self-check OK**(id=@dsh-ssh/dsh-ssh, inject=[slots,workspaces,locale,remote], requires=[react,@deepseek-ai/dsh-client-ui-primitives])。grep 复核: 全代码文件已无任何 // 或 /* 注释含中文, 残余中文行均为运行时字符串(i18n dict 值 / 错误日志 / description 文案)。



# Agent Note: SSH 主机配置 CRUD 走自建 Typert 远程
Status: implemented

## Problem
- 设置页要 CRUD SSH 主机配置并安全存储口令/私钥;F2 测试连接要复用真实 SSH 握手。初期走官方 `api.settings`(describe/update/mutate),用户实测报 `settings namespace "dsh-ssh-hosts" is not exposed to configuration clients`。
- 且 settings 存储形状(hosts array vs dict)决定「口令留空=保持已存」能否表达。

## Decision
- **CRUD 全走自建 Typert 远程**(testConnection 同款通道):宿主 `SshRemoteService extends Service`(key 'ssh')+ `bindTypertRemote` + `ctx.typert.register(HOST_TYPERT_CONTRIBUTION)` 注册严格 descriptor(src-json codec);客户端 `ctx.remote.$mount(CLIENT_TYPERT_REMOTE)` + 调 `ctx.remote.ssh.{listHosts,saveHost,deleteHost,testConnection,...}`。--- 这是 settings 子系统的硬边界:第三方插件的命名空间 CRUD 只能走 Typert(api.settings 只对白名单命名空间开放,`WEB_SETTINGS_NAMESPACES` / `PRODUCT_SETTINGS_NAMESPACES` 不含第三方)。
- **settings 形状 = hosts dict(id → HostConfig),非数组**。理由:官方 settings merge 对对象递归合并、对数组整体替换;数组下「口令留空=保持已存」无法表达(替换数组会删掉未回显的口令);dict 省略 `auth.password` 即保留,删除走 mutate unset `['hosts',<id>]`(字符串路径合法)。
- 客户端 key codec 约束:客户端 `$mount` 强制 strict codec(requireStrictCodec)→ 用 passthrough schema(parse=identity,值已在宿主侧校验);宿主侧可用 src-json。两侧 codec 不对称是设计使然。
- 宿主 `saveHost`:mergeHostPatch 合并patch(口令缺省/空串=保持已存;auth.type 切 key=清 password) + validateHostConfig 宿主侧复验 + 一次 settings.mutate set-op 整条目替换 + expectedRevision 乐观并发;过期 revision → SETTINGS_CONFLICT。`listHosts` 用 redactHosts 剥除 auth.password 返回 {hosts, secrets:[{path,set}], revision, writable}。
- 客户端 `ctx.inject(["remote.ssh"], sshCtx => ...)` 子 fiber 捕获引用(避免自引用死锁:主 fiber apply 内 $mount 注册 remote.ssh,不能在主 inject 声明)。

## Alternatives considered
- 继续用 api.settings:被白名单机制证伪(settings-not-exposed)。若上游把 expose 声明下沉到 settings.register()(deferred work,:885-887),届时可再评估回退。

## Consequences
- 设置页设置区槽(settings.section)只做渲染;持久化/读写在 Typert 通道;卸载后槽/remote 贡献/locale 随 fiber 清理。
- 后续任何「宿主读写 + 客户端 UI」的能力(M4 目录浏览、TOFU 信任)都沿用该 Typert 通道。
- 测试连接的空口令(保持已存)在表单试连场景下无法使用未输入的已存 secret,是「表单内不可见 secret」语义使然(记录在案)。

## 出处
- archived/a-series-log.md A.3(M2b 设置页 + dict 形状)、A.7(迁移到 Typert)。
- dsh-host-apiproxy@lib/index.js:888(WEB_SETTINGS_NAMESPACES)、:1001(PRODUCT_SETTINGS_NAMESPACES)、:2410-2421(notExposed)、:880-887(deferred work);dsh-settings@lib/index.js:235(mergeLayers)/434(mutate)、hosts-model.js。

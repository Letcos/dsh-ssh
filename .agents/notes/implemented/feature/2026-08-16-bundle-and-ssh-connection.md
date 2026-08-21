# Agent Note: bundle 三件套脚手架与 SSH 连接层
Status: implemented

## Problem
- 把项目做成一个可被 `dsh plugin` 安装、卸载后 DSH 完全复原的纯附加插件 bundle,需要先摸清官方 bundle 通道的声明与安装链路。
- 需要一套 ssh2 连接池(exec + SFTP)承载远端执行,并把 SSH 主机配置持久化到 DSH settings。

## Decision
- **bundle 三件套**(官方 /develop/basic/publish 契约):`package.json` 声明 `dsh:{bundle:{patch:"./cordis.patch.yml"}}`(有客户端再加 `dsh:{client:{platform:"web",inject:[...]}}` 与 `exports["./client"]`)+ `cordis.patch.yml`(insert 行数组,行按包名引用)+ 宿主半 `index.js` / 客户端半 `client.js`。
- **安装链路**:`dsh plugin --profile <name> add <本地路径|npm|github>` 在 profile 目录内转发 pnpm;首次 add 自动 initProfile(`dsh.profile.bundles=[@deepseek-ai/dsh-base]`),凡声明 `dsh.bundle.patch` 的依赖自动追加进 bundles;`dsh --profile <name> --dump-config` 打印组合树验证 bundle 进树,`remove` 干净卸载。
- 暴露给配置客户端的 settings 命名空间是**硬编码白名单**(WEB_SETTINGS_NAMESPACES,见 settings-crud note),插件命名空间经 api.settings 不可用;宿主侧用 `ctx.settings.register(ns, schema, {applies:'live', ...})` 注册,`ctx.settings.get(ns)` 读完整 resolved 值。
- **ssh-core**:ssh2 v1.17 直接使用(不用 node-ssh / ssh2-sftp-client);连接池 caching + 容量上限,`hostVerifier` 校验 known_hosts;exec 通道收集 stdout/stderr/exitCode/signal;SFTP 封装 stat/readBytes/readText/writeFileAtomic/listDir/unlink/rmdir。
- **技术栈 D7**:全程 plain JS(ESM + JSDoc),不引入 TypeScript/tsdown/bundler。
- 依赖解析:ESM 按真实路径向上解析 peer;`link:` 安装的 bundle 在真实启动时需仓库根 `pnpm install --frozen-lockfile` 把 peer(ordis/dsh-fs/settings/shell/tools/typert… )落入包 node_modules(仅 --dump-config 不会暴露此问题,它不 import 插件源码)。
- `dsh web` 是 `--profile web` 的硬编码别名;自定义 profile 起独立 Web 服务用 `dsh --profile <name> --port N`(需先 `dsh plugin add @deepseek-ai/dsh-web-app@next`,latest 版本带未发布私有依赖)。

## Alternatives considered
- 用 node-ssh / ssh2-sftp-client 封装:丢掉对流式读/并发/原子 rename 的底层控制,且不解决 SFTP 被禁的根本问题 → 选 ssh2 直用(D1)。
- TS + tsdown 构建链(core 仓库做法):外部 bundle 规模小,构建引入版本耦合;官方教程即 plain JS → 选 plain JS(D7)。

## Consequences
- 卸载后 DSH 逐字节复原(纯附加:bundle 声明 + settings namespace + 工具,无 core 改动)。
- `settingsNamespace` 不允许点号(强制 `/^[a-z][a-z0-9-]*$/`),命名空间用 `dsh-ssh-hosts`。
- Windows 本地 add 需在 profile `.npmrc` 写 `ignore-workspace-root-check=true`(profile 是 pnpm workspace root,直接 add 报 ERR_PNPM_ADDING_TO_ROOT)。

## 出处
- archived/a-series-log.md A.1(脚手架/安装链路)、A.2(ssh-core/settings 命名空间)、A.8(Windows 安装)、A.9(web-app 加装 + link: peer 解析)、A.3(settings 调研);D7 见 requirements §6。
- 官方 /develop/basic/publish;dsh-agent-presets/lib/index.js dump-config;bin.js:96(parseDshArgs plugin 分支);dsh-app-boot initProfile。

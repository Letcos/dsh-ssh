# Agent Note: 测试工程债与统一 live 配置
Status: implemented

## Problem
- 长期被「既有失败」惯着的 10 个 Windows path.sep 基线单测失败;live/verify 脚本把主机 / HOST_ID uuid / 私钥路径等硬编码散落各处,绑定本机无法移植。

## Decision
- **修 10 个基线失败(tests 272 / pass 262 → 272/272 fail=0)**。边界结论:凡映射到**本地占位目录/本地 home** 的返回值用平台 path.join(原生分隔符)是正确语义;凡**呈现/解析远端 POSIX 路径**或做占位前缀重定向必须走 posix。据此:`toWorkdirRelative` 改走 node:path 的 posix(远端路径恒为斜杠,Windows 显示反斜杠是真实 bug,改生产代码);`resolveRemotePath` 占位重定位改用平台 path.relative 判位于占位根下、命中则转 posix 再 join 远端 cwd(改生产代码);其余(remoteRoot/mapRemoteToLocal/createPlaceholderDir/preset 同步)属本地语义正确但测试硬编码 POSIX → 修测试(toPosix 归一化)。
- **统一 live 配置 `test/live-config.mjs`**:一处定义 host/port/user/hostId/keyPath/remoteRoot,全部支持环境变量覆盖 `DSH_SSH_TEST_HOST/PORT/USER/HOST_ID/KEY_PATH/REMOTE_ROOT`;默认 = RFC 5737 TEST-NET-3 保留示例地址 203.0.113.10(公网永不路由, 仅供文档占位); 真实主机必须由 DSH_SSH_TEST_HOST 显式指定。所有 live/verify/bench 脚本(bench/live-smoke/tools-live-smoke/sandbox-live-verify/verify-*/functional-live-test，远端后台验收由 `scripts/verify-remote-bg-created.mjs` 覆盖)改从这里读,顺带修掉私钥默认不一致(id_rsa vs id_ed25519)。
- **收编其余硬编码**(A.43):e2e 端口/base、占位根、DSH core 目录、DSH_HOME、profile 名、仓库绝对路径全部入 live-config 或 env(`DSH_SSH_TEST_E2E_BASE` 兼容 E2E_BASE、`DSH_SSH_DSH_NODE_MODULES`、`DSH_SSH_TEST_PROFILE`);脚本头部补英文 PREREQ + 换机器说明。
- **残渣清理**:删 `_repro-client-mount.mjs`、`_probe-e2e.mjs` 等一次性脚本。

## Alternatives considered
- 不得改生产代码语义迁就 Windows——确属生产 bug(远端 POSIX 呈现)才改生产,否则只改测试断言/归一化。

## Consequences
- 单测基线 fail=0 且 Windows/POSIX 行为一致;live 脚本在任意机器可通过 DSH_SSH_TEST_* 覆盖指向自有机。
- 测试不得绑定特定机器(agents.md §4.2)成为规则;新增依赖加密/本地状态的测试必须有跳过/降级策略。
- **隐私红线(2026 后续)**: 仓库内不硬编码任何真实服务器地址;无真实主机(DSH_SSH_TEST_HOST 未设或仍为示例地址)时, live/e2e 脚本经 `requireRealHost()` 打印 `[skip]` 并以退出码 0 跳过, 绝不连网。历史流水(.agents/notes/archived)中的真实地址已脱敏为 203.0.113.10。

## 出处
- archived/a-series-log.md A.38(10 个基线失败 + live-config)、A.43(去本地化收编)。
- 本仓库 packages/dsh-ssh/test/{live-config.mjs, tools-search, router, m4-placeholder, preset-auto-install}.test.js、src/{search,router}.js;agents.md §4.2 测试规则。

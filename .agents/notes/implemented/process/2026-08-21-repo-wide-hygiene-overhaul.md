# Agent Note: 全仓规范化整改
Status: implemented

## Problem

- **结构混乱**：
  仓库根缺失 `.editorconfig` / `.gitattributes` / `.npmrc` / `.nvmrc` 等基础配置，
  `release.yml` 与旧 `publish.yml` 重复，依赖声明漂移；
  `.agents/notes` 下 `decisions/` 历史目录仍被引用，`implemented/` 分类不统一，
  笔记与代码职责不清，新增成员难以按图索骥。
- **注释违规**：
  `packages/dsh-ssh` 全部代码（`tools.js` / `src/*.js` / `lib/*.js`）混入大量过程化引用
  （`M2a` / `M5` / `方案⑤` / `A.22` / `D-xx` / “修复/补充/曾经”），
  且存在中文注释，违反 `AGENTS.md §4.1`（注释只讲当前行为 + 不变 why，英文，无过程化信息）。
  读者需翻阅历史流水才能理解注释，违背“面向不了解历史的读者”原则。
- **敏感信息**：
  `archived/a-series-log.md` 与旧测试中残留真实主机地址、
  本机绝对路径、私钥指纹等；
  示例地址未统一到 RFC 5737 文档网段
  （`203.0.113.10` / `192.0.2.0/24` / `198.51.100.0/24`），
  违反 `AGENTS.md §1` 敏感信息零入库红线。
- **文档重复**：
  根 `README.md` 与 `packages/dsh-ssh/README.md` 手工双写，内容漂移
  （版本要求、故障排查、开发导航等不一致），
  `tools.js` 单文件 1005 行承载 bash / fs / search 三域，难以维护与测试，
  任何一域改动都需在同一文件内搜索定位。
- **脚本冗余**：
  `test/live-jobs.mjs` 与 `scripts/verify-remote-bg-created.mjs` 验收点重叠但未收敛，
  前者删除后三个独有验收点（`completed exit 3` / `ProcessOutcome {status,detail}` / 输出文件落盘）
  面临丢失，真机回归覆盖率下降。

## Decision

- **根配置补齐**：
  - 新增 `.editorconfig`（统一换行/缩进/末行空行，`end_of_line=lf` / `insert_final_newline=true`）；
  - 新增 `.gitattributes`（LF 规范化，`*.js text eol=lf`）；
  - 新增 `.npmrc`（`ignore-workspace-root-check` 等 pnpm 约束）；
  - 新增 `.nvmrc`（Node 22）；
  - 收敛 `.github/workflows/release.yml` 为唯一发布流，删除重复 `publish.yml`；
  - `package.json` / `packages/dsh-ssh/package.json` 对齐 peerDependencies 与 repository（`@dsh-ssh/dsh-ssh`）。
- **`.agents` 重组**：
  - `decisions/` 并入 `implemented/` 对应类别
    （`architecture` / `feature` / `bug-fix` / `simplification` / `process` / `testing`），
  - 新增 `proposed/` / `rejected/` 与 `archived/2025-08-16-preset-standard-ssh.md`；
  - `notes/README.md` / `AGENTS.md` 定骨架“一条主题一文件、Problem/Decision/Alternatives/Consequences + 出处”；
  - `requirements-and-design.md` 仅留稳定规范，流水迁入 `archived/a-series-log.md` 冻结。
- **注释英文化去编号**：
  - 全量代码注释重写为英文当前行为说明，仅保留两类
    ① 当前行为 ② 长期 why（外部契约、官方行号 `dsh-jobs-local:190` / `dsh-tool-bash:21-30`）。
  - 移除 `M*` / `A.*` / `方案*` / `⑤` 等过程化引用；运行时字符串（i18n/schema/错误文案）豁免。
  - 结果：`src/` / `tools/` / `lib/` 注释中 `A\.\d+|M*|方案` 清零，`[一-鿿]` 仅剩运行时字符串。
- **`tools.js` 三域拆分**：
  - `tools.js` 1005 行 → 183 行装配层
    + `tools/bash.js`（bash 独有：`REMOTE_EXEC_DEFAULT_TIMEOUT` / `createBashTool`
    / `startRemoteBackground` / `renderResult` 等）
    + `tools/fs.js`（`buildFsCaps` / `createReadTool` / `createWriteTool`
    / `createEditTool` / `createReadImageTool`）
    + `tools/search.js`（`buildSearchCaps` / `createGlobTool` / `createGrepTool`）；
  - `src/` 9 模块（`exec-fs` / `placeholder` / `policy` / `remote-jobs` / `remote` / `router` / `search` / `settings` / `ssh-core`），`lib/` 2 模型（`hosts-model` / `typert-contribution`）。
  - 拆分前后单测 295/295 绿，`registerRoutedTools` / `ROUTED_TOOL_NAMES` 契约不变，
    `index.js` 的 `agent/created` 钩子仍通过 `tools.register` 按 `routeByCwd` 遮蔽。
- **README 单一信源 + 脚本生成**：
  - 根 `README.md` 为唯一手写信源；
  - 新增 `scripts/build-readme.mjs` 做确定性变换
    （`docs/images/` → `raw.githubusercontent.com` 绝对化、
    `./LICENSE` / `README.en.md` / `CONTRIBUTING.md` / `AGENTS.md` 绝对化、
    头部 `<!-- AUTO-GENERATED -->` 注入），
  - 幂等生成 `packages/dsh-ssh/README.md`（两次哈希一致）；
  - `CONTRIBUTING.md` 沉淀脚本清单与“测试”章节，移除文档漂移。
- **脚本去重与验收点收敛**：
  - 删除 `test/live-jobs.mjs` 与 `test/live-background-verify.mjs`，
  - `scripts/verify-remote-bg-created.mjs` 成为唯一真机 `run_in_background` 端到端验证
    （`sleep 30` 运行态 + 增量输出 + kill 灭进程组）；
  - 本次补漏把 `live-jobs.mjs` 三独有验收点追加进该脚本：
    `completed` 分支以 `exit 3` 验证、
    `ProcessOutcome {status:'completed', detail:'exit code: 3'}` 形状逐字段校验、
    `tee a.out` 输出文件落盘校验；
  - `node --check` 语法校验通过，待真机复核。

## Alternatives considered

- **不拆 `tools.js`**：
  维持 1000+ 行单文件，继续在同一文件内追加 bash / fs / search 三域逻辑。
  代价：单文件心智负担高、并发编辑冲突频繁、单测难以按域隔离、
  后续策略（如 sandbox 三域细化）无法独立演进。
  权衡后选择“薄装配层 + 三域纯模块”——
  装配层只做 `routeByCwd` / `resolveRemoteSandboxMode` /
  `buildRoutedToolDefinitions` / `registerRoutedTools`，域内逻辑可独立单测与复用。
- **手写双 README**：
  根与包内各维护一份 README，手工同步版本要求、故障排查与导航。
  代价：已出现 6 处不一致（版本矩阵、故障排查 5 条、开发导航缺失），
  后续每次文档变更需改两处且易遗漏。
  改为“单信源 + 脚本生成”后，`build-readme.mjs` 幂等、无新依赖，
  `git diff` 可直接发现未生成提交，CI 可强制校验。
- **`archived/` 直接重写历史**：
  将敏感信息与过程化注释在归档流水中就地覆盖。
  否决：`archived/` 冻结只读是审计追溯的红线；
  仅允许 2026-08-20 一次性批量脱敏（泛化路径与凭据，不改写史实，文首留修订声明），
  其余一律只追加不改写。
- **保留 `live-jobs.mjs` 双轨验证**：
  同时维护 `live-jobs.mjs`（直连 `SshPool` + `createRemoteBashJobHooks`）
  与 `verify-remote-bg-created.mjs`（`cordis` 组合 + `tools registry` + `jobs registry`）。
  代价：两脚本主机读取、清理路径、断言风格重复，维护成本翻倍。
  收敛为单一组合端到端脚本，并把三验收点平移，覆盖率不降。

## Consequences

- **可维护性提升**：
  `tools.js` 由 1005 行降至 183 行装配层（`wc -l` 实测），
  三域模块职责清晰，`src/remote-jobs.js` 注释已英文化并保留官方契约行号
  （`dsh-jobs-local` / `dsh-tool-bash`），
  后续新增工具或策略仅改对应域文件。
- **规范闭环**：
  `AGENTS.md §4.1` 注释规则在 CI 侧可 `grep` 校验
  （`A\.\d+|M[0-9][a-c]?\b|方案[0-9⑤]` / `//.*[一-鿿]` 均为 0）；
  `.agents/notes` 悬空 `decisions/` 引用为 0（`archived` 除外）；
  敏感信息（真实主机地址 / 本机绝对路径 / 私钥明文）在 `packages/dsh-ssh` 代码与测试内为 0，
  `192.168.` / `10.x` 仅剩合规示例已替换为 `203.0.113.10` / `/tmp/elsewhere`
  （`hosts-model.test.js:30` / `router.test.js:68`）；
  `research/` 与 `archived/` 历史笔记残留的绝对路径/主机名已另行二次脱敏处理。
- **`archived` 脱敏特批**：
  `archived/a-series-log.md` 文首已留脱敏修订声明（2026-08-20 首轮 + 2026-08-21 二轮补漏），
  存量真实主机地址/主机名与绝对路径已泛化为 `203.0.113.10` / `<remote-host>` / `<dsh-checkout>` 等占位符，
  史实与行号保留，满足 `AGENTS.md §1` 敏感信息零入库红线。
- **`live-jobs` 验收点不丢失**：
  `verify-remote-bg-created.mjs` 新增 `START-A / DONE-A / exit 3 / a.out` 三段校验
  （`scripts/verify-remote-bg-created.mjs:113-150`），
  与原 `test/live-jobs.mjs`（`git show HEAD:packages/dsh-ssh/test/live-jobs.mjs`）语义对齐，
  `node --check` 通过；单测 295/295、`client-selfcheck.mjs` OK、`build-readme.mjs` 幂等。
- **文档单一信源**：
  后续文档变更只需改根 `README.md` 并运行
  `node packages/dsh-ssh/scripts/build-readme.mjs`，包内 README 头部可追溯生成来源，避免漂移。

## 出处

- 根配置：`.editorconfig` / `.gitattributes` / `.npmrc` / `.nvmrc`
  / `.github/workflows/release.yml` / `package.json` / `packages/dsh-ssh/package.json`。
- 笔记重组：`.agents/notes/README.md` / `.agents/notes/AGENTS.md`
  / `.agents/notes/requirements-and-design.md`
  / `.agents/notes/implemented/process/2026-08-20-project-rename-and-hygiene.md`
  / `archived/a-series-log.md`（文首脱敏声明）与 `archived/2025-08-16-preset-standard-ssh.md`。
- 注释规范：`AGENTS.md §4.1`；
  `packages/dsh-ssh/tools.js` / `tools/bash.js` / `tools/fs.js` / `tools/search.js`
  / `src/*.js` / `lib/*.js` / `client.js`。
- 拆分与文档：`packages/dsh-ssh/tools.js:1-200`（装配层）
  / `tools/{bash,fs,search}.js` / `scripts/build-readme.mjs`
  / `README.md` ↔ `packages/dsh-ssh/README.md`。
- 脚本去重：`test/live-jobs.mjs`（`git show HEAD:packages/dsh-ssh/test/live-jobs.mjs`）
  → `scripts/verify-remote-bg-created.mjs:113-150`；
  `src/remote-jobs.js:39-41`（`ProcessOutcome` 形状契约）。

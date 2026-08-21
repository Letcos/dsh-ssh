# AGENTS.md

> dsh-ssh 是一个 DeepSeek Harness(DSH) 插件项目, 让 DSH 获得 SSH 远程工作区能力: 把另一台机器的目录当作工作区, 其中的 bash / 文件读写 / glob / grep 全部在远端机器上执行, 本地体验与纯本地工作区一致。
>
> 本文件是代理的**总入口**, 只放上手所需的最少信息; 架构细节与调研一律下沉到 [.agents/notes](./.agents/notes)(见 §5)。

## 1. 硬约束(红线, 违反任意一条的改动一律拒绝)

- **DSH core 零修改**: 不碰 DSH core 与任何 core 包; 只通过官方公共契约(tools.register / settings / slots / Typert / preset 加载器)做纯附加。
- **远端机器零安装**: 远端只依赖 sshd 自带能力 —— exec 通道跑命令 + SFTP 传输文件; 不允许要求远端装 agent / 服务 / 内核模块。
- **纯附加、可插拔**: 全部产物 = 通过官方 bundle 通道安装的插件包(工具路由经 agent/created 钩子, 无独立 preset); 卸载后 DSH 完全恢复原样。
- **本地工作区行为完全不变**: 本地路径的请求仍走宿主 ctx.shell / ctx.fs / ctx.subprocess, 与未装插件时逐字节一致。
- **DSH 升级自适应**: core 零改动即天然兼容升级; 路由实现挂在 host 插件钩子(agent/created)上, 不依赖任何 preset 副本, 无上游 preset 同步维护点。
- **敏感信息零入库**: 真实服务器地址/主机名、本机绝对路径(含用户名)、私钥路径、凭据等一律不写进代码/注释/文档/笔记; 示例值一律用 RFC 5737 文档地址(如 203.0.113.10)与通用占位符。

> 工具路由 / bundle 通道 / UI 通信等架构结论、已知坑与设计取舍的权威记录见
> [.agents/notes/requirements-and-design.md](./.agents/notes/requirements-and-design.md)(稳定规范)与 [.agents/notes/implemented/](./.agents/notes/implemented/)(逐条取舍);
> 原始验证流水见 [.agents/notes/archived/](./.agents/notes/archived/)。动代码前先复核。

## 2. 仓库结构

```
dsh-ssh/
├── AGENTS.md                        # 本文件: 总入口
├── README.md / README.en.md         # 对外项目说明（中/英）
├── CONTRIBUTING.md                  # 开发者文档（脚本清单与「测试」章节）
├── docs/images/                     # 文档资产（设置页/工作区截图）
├── .github/workflows/               # CI（release.yml）
├── .agents/                         # 协作资料(见 §5)
│   ├── README.md                    # .agents 总览
│   └── notes/                       # Agent Notes(组织规范见 notes/README.md)
│       ├── README.md                #   notes 组织规范
│       ├── AGENTS.md                #   notes 操作规则
│       ├── requirements-and-design.md   #   稳定规范(背景/硬约束/架构/模块/风险)
│       ├── implemented/             #   已落地/已决策 note(按类分目录)
│       ├── proposed/                #   待决策提案
│       ├── rejected/                #   已否决方案
│       ├── research/ design/        #   外部调研 / 设计规格
│       └── archived/                #   冻结历史流水(只读)
└── packages/dsh-ssh/                # 全部实现(@dsh-ssh/dsh-ssh, plain JS, 无构建)
    ├── index.js / tools.js          # 薄入口
    ├── client.js
    ├── cordis.patch.yml             # bundle patch
    ├── tools/                       # 拆分产物（bash.js / fs.js / search.js）
    ├── src/                         # 9 个 js（exec-fs.js / placeholder.js / policy.js / remote-jobs.js / remote.js / router.js / search.js / settings.js / ssh-core.js）
    ├── lib/                         # 2 个纯模型（hosts-model.js / typert-contribution.js）
    ├── scripts/                     # 11 个脚本（bench.mjs / build-readme.mjs / client-selfcheck.mjs / e2e-web-3080.mjs / functional-live-test.mjs / live-smoke.mjs / sandbox-live-verify.mjs / tools-live-smoke.mjs / verify-agent-created.mjs / verify-execfs-fallback.mjs / verify-remote-bg-created.mjs）
    ├── test/                        # 单测（21 个 *.test.js + live-config.mjs）
    └── README.md                    # 产品页（面向用户）
```

## 3. 常用命令

依赖安装（仓库级 pnpm workspace）：

```bash
pnpm install
```

单元测试（基线: fail=0）：

```bash
cd packages/dsh-ssh && node --test test/*.test.js
```

客户端静态自检（从仓库根运行: client.js 契约/遮蔽 priority/Typert 描述符）：

```bash
node packages/dsh-ssh/scripts/client-selfcheck.mjs
```

真机 live/verify（统一从 test/live-config.mjs 读主机，可用 DSH_SSH_TEST_* 环境变量切换）：

```bash
cd packages/dsh-ssh && node scripts/live-smoke.mjs               # 建连+exec+SFTP 冒烟
cd packages/dsh-ssh && node scripts/functional-live-test.mjs     # 功能+兼容性实测
cd packages/dsh-ssh && node scripts/verify-agent-created.mjs     # agent/created 遮蔽验证
cd packages/dsh-ssh && node scripts/e2e-web-3080.mjs             # 全工具 E2E(E2E_BASE 可覆盖)
```

安装/卸载插件 bundle（用隔离测试 profile dsh-ssh-dev，勿污染 web profile）：

```bash
dsh plugin --profile dsh-ssh-dev add <本仓库 packages/dsh-ssh 的本地路径>
dsh plugin --profile dsh-ssh-dev remove @dsh-ssh/dsh-ssh
dsh --profile dsh-ssh-dev --dump-config     # 校验 patch 是否进入组合
```

## 4. 代码注释与测试规范

### 4.1 注释规则

- 注释面向不了解项目历史的读者, 用于解释**当前**代码的行为与"为什么", 而非记录过程。
- 只保留两类注释: (1) 对当前行为的必要说明; (2) 不随代码自明的、长期成立的"为什么"——外部契约、参数来源、非显然的约束。
- **禁止在注释里写入过程化信息**: 里程碑编号、内部方案编号、笔记条目号(如 A.42)、以及"修复/补充/曾经"式的历史叙述。这类内容归属 [.agents/notes](./.agents/notes) 与 `git log`，不应出现在代码注释中。
- 代码注释一律使用英文; 面向运行时用户的字符串(错误文案、日志)不在此列, 不受英文限制。

### 4.2 测试规则

- 测试与脚本不得绑定特定机器: 一切环境相关值(端口、主机、密钥、绝对路径、profile 名)必须通过 `test/live-config.mjs` 读取, 并允许被 `DSH_SSH_TEST_*` 环境变量覆盖。
- 仓库内只允许出现"当前默认开发机"一组的默认值, 且该默认值必须可被覆盖。
- 新增依赖加密或本地状态的测试, 必须有跳过或降级策略, 保证无真机/无凭据时单测基线仍全绿。
- 单测基线必须 `fail=0`; 不允许以"既有失败"为常态或长期容忍失败用例。

### 4.3 笔记组织

- 笔记目录结构与条目组织规则见 [.agents/notes/README.md](./.agents/notes/README.md)，操作规则见 [.agents/notes/AGENTS.md](./.agents/notes/AGENTS.md)。

## 5. 协作规范

1. 开工前必读: 根目录 [AGENTS.md](./AGENTS.md) + [.agents/notes](./.agents/notes) 下与本任务相关的笔记。
2. 任务优先拆给**子代理并行推进**; 独立执行用 **deepseek-v4-flash**, 需承接完整上下文的用 fork 型子代理。
3. 子代理任务结束, 把**关键结论 / 已验证事实 / 踩坑**回写到 [.agents/notes](./.agents/notes)(注明出处: URL 或源码路径)。
4. 笔记并发回写: 以追加为主, 冲突时保留双方条目并标注, 不覆盖他人结论。
5. 违反 §1 硬约束的改动一律拒绝; 发现约束冲突时停下并报告, 不自行放宽。
6. 笔记中的"已验证"必须注明出处; 未验证的猜测标注"待验证"。

### 5.1 Git 规范

- Commit message 一律英文, 用 Conventional Commits: `feat|fix|docs|refactor|test|ci|security: <summary>`; 一句话说清改了什么, 不写过程叙述。
- 单测 `fail=0` 才能提交; 提交前跑 `node --test test/*.test.js`。
- 直接推 `main`; 改写历史(amend/force push)只在用户明确要求时做。

## 6. 文档导航

- 用户 → [README.md](./README.md)
- 开发者 → [CONTRIBUTING.md](./CONTRIBUTING.md)
- 架构规范 → [.agents/notes/requirements-and-design.md](./.agents/notes/requirements-and-design.md)
- 协作资料 → [.agents/README.md](./.agents/README.md)

## 7. 参考(精简)

- **项目说明**: `README.md`; 脚本与测试详见 `CONTRIBUTING.md`。
- **官方文档**(VitePress, 根 locale 即简体中文): https://deepseek-harness.github.io/deepseek-harness/
  - 开发入门: https://deepseek-harness.github.io/deepseek-harness/develop/basic/
  - 能力接缝总览: https://deepseek-harness.github.io/deepseek-harness/reference/capability-seams
  - 子系统(settings / typert / workspace / shell / filesystem): https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/
- **本地 DSH checkout(只读参考)**: 安装路径见 `package.json` 中 @deepseek-ai/dsh 的位置; **禁止修改**。

---

**开始任何任务前, 先读 AGENTS.md 与相关笔记, 再动手。**

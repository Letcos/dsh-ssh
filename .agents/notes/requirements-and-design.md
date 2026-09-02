# dsh-ssh 需求与实现设计(权威笔记)

> 本文属稳定规范层（Reference）；使用教程见 README.md，开发操作见 CONTRIBUTING.md，逐条决策取舍见 implemented/

> **性质**: 本项目需求与实现思路的权威长期笔记(只留稳定规范); 设计与实现以此为准。各里程碑的详细验证流水已归档, 见 .agents/notes/archived/a-series-log.md。
> **状态**: M1–M5 全部达成。实现已稳定: 方案⑤ 工具路由(agent/created 钩子遮蔽)、bash 必注册、远端后台任务、TOFU、SFTP 降级、能力面、UI/UX、测试体系(E2E)均已落地。具体设计取舍与出处见 .agents/notes/implemented/(每条 A 条目的提炼结论)。
> **最后更新**: 2026-08-20(笔记重组: 附录 A/B 流水迁入 archived/, 设计取舍沉淀到 implemented/)
> **维护者**: 主代理 + 各子代理任务结束时回写(规则见 §10)
> **关联文件**: AGENTS.md(总入口)、.agents/notes/README.md(组织规范)、.agents/notes/implemented/(已实现决策 note)、.agents/notes/research/(外部调研)、.agents/notes/archived/(冻结历史流水)

---

## 1. 背景与目标

### 1.1 用户原始需求(原话要点)

1. 设置页面可添加另一台机器的 SSH 配置;
2. 创建/选择工作区时可加载另一台机器的目录;
3. 工作区内的 sh 工具(bash)、文件读写(read/write/edit/read_image)、glob/grep 全部在远端机器执行;
4. 远端机器不需要安装任何额外服务;
5. 方便切换不同运行机器。

即: 把 DSH 从"只能操作本机"扩展为"可操作任意一台有 sshd 的机器", 且远端零安装、切换无感。

### 1.2 痛点分析

- **现状与同类方案的问题**: DSH 所有工作区工具(bash / 文件 / 搜索)都绑定本机文件系统与进程, 跨"本地 Mac + 远程 Linux 工作站"只能手工 scp/sftp 搬运; VS Code Remote、remote agent/daemon 都要求远端装服务或内核模块(违反零安装); sshfs/FUSE 要本地内核扩展(脆弱、需管理员权限); 手动同步则丢失工作区连续性。
- **本项目目标**: 仅凭远端 sshd 自带的 exec 通道(跑命令)+ SFTP(传文件), 让 DSH 获得与本地一致的远程工作区体验; 本地只多一个可插拔插件包(工具路由经 agent/created 钩子，无独立 preset)，卸载后 DSH 完全恢复原样。

---

## 2. 需求清单

### 2.1 功能需求(F1–F9)

| 编号 | 需求 | 验收要点 |
|---|---|---|
| F1 | SSH 主机配置 CRUD | 设置页可添加/编辑/删除主机(host/port/user/认证方式/别名), 持久化到 DSH settings; 刷新/重启后保留 |
| F2 | 测试连接 | 设置页一键测试: 走真实 SSH 握手 + exec 一条无害命令(如 echo), 展示远端 banner / 明确错误 |
| F3 | 凭据安全存储 | 口令、私钥口令等敏感字段不落明文(见 §8); 私钥路径引用本地文件 |
| F4 | 远端目录浏览 | 创建工作区时可浏览远端目录树(列表/进入/返回/家目录展开), 选择目标目录 |
| F5 | 工作区创建/选择/切换 | 远端目录可创建为工作区; 本地与远端工作区共存; 会话级切换"运行机器"(本地 ↔ 任一远端) |
| F6 | bash 远端执行 | 远端工作区内 bash(sh 工具)在远端 shell 执行, 以远端目录为 cwd, stdout/stderr/退出码正确返回 |
| F7 | 文件工具远端执行 | read / write / edit / read_image 在远端文件系统上执行, 语义与本地一致(含原子写、edit 增量) |
| F8 | glob/grep 远端执行 | glob / grep 在远端文件系统上执行, 语义尽量对齐本地 rg(过滤/忽略/二进制/超时) |
| F9 | 断线提示与自动重连 | 连接中断时工具调用给出明确提示(不静默失败); 网络恢复后自动重连, 会话内不丢上下文 |

### 2.2 非功能需求

| 编号 | 需求 | 说明 |
|---|---|---|
| N1 | 远端零安装 | 远端只依赖 sshd 自带的 exec + SFTP; 不允许要求装 agent/服务/内核模块 |
| N2 | DSH core 零修改 | 不碰 core 包; 只通过官方公共契约纯附加(见 §3.1) |
| N3 | 纯附加、可插拔 | 卸载插件 + 移除 preset 后 DSH 完全恢复原样 |
| N4 | 本地工作区行为完全不变 | 本地路径的请求仍走宿主 ctx.shell / ctx.fs / ctx.subprocess, 与未装插件时一致 |
| N5 | 升级自适应 | 路由挂在 host 插件钩子 agent/created，不依赖任何 preset 副本，无上游 preset 同步维护点 |
| N6 | 性能可接受 | 单条命令往返额外延迟在亚秒级; 大目录列举/搜索走远端单命令批量完成, 不做逐文件往返 |
| N7 | 错误可诊断 | 失败信息含 hostId、远端命令原文、远端退出码/输出尾部, 便于定位 |

### 2.3 明确不在范围

- **FUSE 挂载**(sshfs/macFUSE 等本地内核扩展)——见 §3.3;
- **透明替换所有会话的 fs/shell 服务**——只做工具层路由(§3.2);
- **远端 LSP / 远端 agent / 进程守护 / 文件监听(watch)**;
- **交互式远端终端(PTY 全屏应用)**——dsh-ssh 自身工具仍只保证非交互命令; 另暴露 `SshConn.shell()`(ssh2 PTY 通道, 单次重连重试)供消费者(如 dsh-better-sidebar 终端)构建交互终端, 交互/全屏语义由消费者自担(见 `implemented/feature/2026-08-29-ssh-shell-channel.md`);
- **Windows 远端完整支持 / 多跳代理(ProxyJump)**——优先 Linux/macOS; Windows 差异与 ProxyJump 视 M5 打磨结果文档化限制。

---

## 3. 硬约束与已排除路线

### 3.1 硬约束(违反任何一条的改动一律拒绝)

1. **DSH core 零修改**: 不碰 DSH core 安装目录与任何 core 包; 只通过官方公共契约(工具注册 / settings / 槽 / Typert / preset 加载器)做纯附加。
2. **远端机器零安装**: 仅 sshd 的 exec 通道 + SFTP。
3. **纯附加、可插拔**: 全部产物 = 通过官方 bundle 通道安装的插件包(工具路由经 agent/created 钩子，无独立 preset)；卸载后 DSH 完全恢复原样。
4. **本地工作区行为完全不变**: 本地路径请求仍走宿主 ctx.shell / ctx.fs / ctx.subprocess。
5. **DSH 升级自适应**: core 零改动即天然兼容; 路由实现挂在 host 插件钩子(agent/created)上，不依赖任何 preset 副本，无上游 preset 同步维护点。

### 3.2 已排除路线: 透明替换 host 单例服务

调研结论(详见 .agents/notes/research/2026-08-20-dsh-official-reference.md): fs / subprocess / shell / directoryPicker 都是 **host 单例服务**, 挂在主机组合上; 透明替换必须改主机组合 = 修改 core, 违反硬约束 1, 直接排除。执行链归属如下:

| 能力 | 调用链 | 服务归属 | 附加替换? |
|---|---|---|---|
| bash(sh 工具) | tools.bash → ctx.shell → ctx.subprocess → child_process.spawn | host 单例 shell/subprocess | 否(需改主机组合) |
| read/write/edit/read_image | tools → ctx.fs(读/写/stat/原子写) | host 单例 fs(dsh-fs-local) | 否 |
| glob/grep | tools → ctx.subprocess + 本地 rg | host 单例 subprocess + 本地依赖 | 否 |
| 工作区创建/切换 | ctx.workspaceRegistry / ctx.directoryPicker / apiProxy | host 单例 | 否 |
| 目录选择 UI | sidebar.workspaces.directoryFlow / conversation.hero.workspace.directoryFlow | 槽(可注入) | 是 |
| 设置页 | settings.section 槽 + ctx.settings 命名空间 | 槽 + 命名空间 | 是 |
| 工具注册 | preset 组合文件 tools 行(经 tools.register) | preset 加载器 | 是 |
| Host↔Client 通信 | TypertRemoteService + @Remote | @deepseek-ai/dsh-typert-protocol | 是 |

结论: 唯一可行的替换点是 **工具层**(preset 组合文件里的工具行)——工具本身按会话 cwd 路由, 本地路径委托宿主 ctx.*, 远端路径走 SSH。其余可附加点(设置槽、目录流程槽、Typert)全部保留。

### 3.3 已排除路线: sshfs/FUSE 主路径

- **风险/结论**: macFUSE 是本地内核扩展, 需安装 + 管理员权限, 升级脆弱, 违背"纯附加、可插拔", 挂载故障难诊断且拖垮本地文件系统路径 → 不作主路径、不作依赖; 文件操作全部走 ssh2 的 SFTP 通道(用户态, 无内核依赖)。

### 3.4 已排除路线: TRAMP 式纯 shell 解析主路径

- **含义**: 像 Emacs TRAMP 那样, 用 ssh host cat/echo/sed 拼 shell 命令完成所有文件操作。
- **问题/结论**: 每个文件操作都是 shell 拼接(转义面大、易注入); 无标准 rename/stat/mkdir/读偏移语义; 二进制与原子写难做; 性能差 → 仅作 SFTP 被禁时的降级方案(P3 之后评估); 主路径 = SFTP。

---

## 4. 总体架构

### 4.1 两层纯附加

1. **插件 bundle dsh-ssh**: 宿主侧 ssh2 连接池(exec + SFTP、known_hosts 校验、自动重连)、SSH 主机配置(settings 命名空间)、Typert 远程目录浏览服务、客户端 UI 行(设置页 + 目录流程槽)。经官方 bundle 通道安装(dsh plugin add, 包声明 "dsh": {"bundle": {"patch": "./cordis.patch.yml"}})。
2. **preset standard-ssh**(已移除): 早期用 agentPresets.copy('standard','standard-ssh') 复制官方 preset 并替换工具行、按会话 cwd 路由。**方案⑤ 落地后改为 preset 无关**: host 插件监听 agent/created 钩子, 仅对远端占位 cwd 会话在该 agent scope 注册 7 个同名路由工具遮蔽官方实现(见 implemented/feature/2026-08-19-preset-independent-tool-routing.md)；standard-ssh preset 因冗余被整体删除（见 implemented/simplification/2026-08-20-remove-standard-ssh-preset.md）。

> patch 层顺序(官方 /develop/basic/publish): 空根 → profile bundles → profile 自身 cordis.patch.yml → $DSH_HOME/cordis.patch.yml → --patch overlay; 按 id 覆盖行时**整个 config 被替换**(须重述全部键)。dsh-ssh 的 bundle patch 只做 insert 行, 无此问题。

> 已验证: agentPresets.copy(from, id, name) 存在于 dsh-agent-presets/lib/index.js:1045; preset 组合文件名常量 COMPOSITION_FILE = "agent.cordis.yml"(同包 lib/index.js:146)。bundle 声明格式("dsh":{"bundle":{"patch":"./cordis.patch.yml"}} 等)见官方 /develop/basic/publish 与本仓库 packages/dsh-ssh/package.json。

### 4.2 同名工具按 cwd 路由

- 工具 ID 与官方完全同名(bash/read/write/edit/read_image/glob/grep)→ agent 无需感知、prompt 无需改动、行为无缝。路由键 = 会话 cwd(即 session.header.cwd, 普通绝对路径): **本地路径**(不在占位前缀下)→ 委托宿主 ctx.shell / ctx.fs / ctx.subprocess, 与未装插件时逐字节一致(硬约束 4); **远端占位路径**(~/.dsh/remote/<hostId>/... 之下)→ 路径换算回远端绝对路径, 走 SSH(exec/SFTP)。

### 4.3 远端工作区 = 本地占位目录的普通 workspace 记录

- 创建远端工作区时, 本地只生成一个**占位目录** ~/.dsh/remote/<hostId>/<path 编码>, 走 DSH 现有的 workspaceRegistry 流程登记。**占位目录必须真实存在且勿用符号链接**: workspaceRegistry.create() 会 fs.realpath 并拒绝不存在的路径(源码核对: @deepseek-ai/dsh-workspace; 官方文档 /reference/subsystems/workspace)。
- session.header.cwd 仍指向该占位目录(普通绝对路径)→ **sessions / workspaceRegistry / apiProxy 全部零改动**; 占位↔远端映射由 dsh-ssh 维护, 占位目录内不落业务数据, 只有映射元数据(§8.1 已决策·占位目录路径编码)。

### 4.4 UI 与通信

- **设置页主机配置**: settings.section 槽(kind single, scope root; 出处: @deepseek-ai/dsh-client-ui-settings@lib/types/client/contract/slots.d.ts:67, 调研子代理核对); 数据经 ctx.settings 持久化到 ~/.dsh/settings.yaml 的 dsh-ssh-hosts 命名空间(settingsNamespace 强制 kebab-case, 点号被拒——M2a 实测)。
- **远端目录浏览**: Host 侧暴露 Typert 远程服务, Client 侧在 sidebar.workspaces.directoryFlow / conversation.hero.workspace.directoryFlow 槽注入目录选择 UI(槽名定义源: @deepseek-ai/dsh-client-ui-workspace@lib/types/client/contract/slots.d.ts L48-62; owner 契约: occupant 拥有从 open 到 onPicked(path)/onCancel/onError 的完整交互, busy 期间禁用提交)。
- **Host↔Client**: TypertRemoteService + @Remote(已验证导出: dsh-typert-protocol/lib/index.js:53,140 → TypertRemoteService / Remote / RemoteScope / bindTypertRemote / remoteMethods)。

### 4.5 架构图(ASCII)

```
┌────────────────────────── DSH Host(本地机器) ──────────────────────────┐
│  ┌────────────┐   agent/created 钩子按会话 cwd 遮蔽 7 工具              │
│  │ agent loop │──▶ bash/read/write/edit/read_image/glob/grep(同名路由工具)│
│  └────────────┘       │ 远端会话在 agent scope 注册同名工具遮蔽官方实现   │
│              ┌────────┴─────────┐                                     │
│              ▼                  ▼                                     │
│      本地路径(委托宿主)     远端占位路径                                 │
│   ctx.shell/ctx.fs/     ┌──────────────────┐                          │
│   ctx.subprocess        │ dsh-ssh bundle    │                          │
│   (行为逐字节不变)        │  ssh-core 连接池    │                          │
│                         │  ├─ exec(命令)     │                          │
│                         │  └─ SFTP(文件)     │                          │
│                         └────────┬─────────┘                          │
│                                  │ ssh2 单连接复用                     │
└──────────────────────────────────┼───────────────────────────────────┘
                                   ▼
                        ┌────────────────────┐
                        │ 远端 sshd(零安装)    │
                        │ exec 通道 + SFTP    │
                        │ 文件系统 / shell     │
                        └────────────────────┘

  远端工作区 = 本地占位目录 ~/.dsh/remote/<hostId>/<path 编码>(普通 workspace 记录)
  UI: settings.section 槽(主机 CRUD) + directoryFlow 槽(远端目录浏览)
      目录数据经 TypertRemoteService(@Remote)从 Host 拉取
```

---

## 5. 模块划分与接口草稿

### 5.1 建议仓库结构

```
dsh-ssh/
├── AGENTS.md                        # 总入口
├── README.md                        # 对外项目说明
├── CONTRIBUTING.md                  # 开发者文档（脚本清单与「测试」章节）
├── .agents/                         # 协作资料
│   ├── README.md                    # .agents 总览
│   └── notes/                       # Agent Notes
│       ├── README.md                #   notes 组织规范
│       ├── AGENTS.md                #   notes 操作规则
│       ├── requirements-and-design.md   #   稳定规范
│       ├── implemented/             #   已落地/已决策 note
│       ├── research/ design/        #   外部调研 / 设计规格
│       └── archived/                #   冻结历史流水(只读)
└── packages/dsh-ssh/                # 全部实现(@dsh-ssh/dsh-ssh, plain JS, 无构建)
    ├── index.js / tools.js / client.js
    ├── tools/                       # 拆分产物(bash.js / fs.js / search.js)
    ├── src/  lib/  scripts/  test/
    └── README.md                    # 产品页（面向用户）
```

### 5.2 ssh-core: 连接池 / exec / SFTP / known_hosts / 重连

```ts
interface HostConfig {                 // 与 settings schema 对应(见 src/settings.js HostConfigSchema)
  id: string;                          // 稳定 id(如 uuid), 占位目录路径依赖它
  name: string;
  host: string; port: number; user: string;
  auth: { type: 'key'; privateKeyPath?: string }      // 私钥路径; 缺省走 ssh-agent
      | { type: 'password'; password: string };      // 口令(write-only, role('secret')); 凭据存储见 §8.1 已决策·凭据存储
  knownHostsPath?: string;             // 默认 ~/.ssh/known_hosts
  connectTimeoutMs?: number;           // 默认 10_000
  keepaliveIntervalMs?: number;        // 默认 15_000
}
// maxConnections 为池级配置(经 bundle patch config 传入 SshPool), 非 HostConfig 字段, 默认 4

class SshPool {                        // 插件内部 host 单例服务 ctx.sshPool
  acquire(hostId: string): Promise<SshConn>;                 // 复用/新建, 超额排队
  release(conn: SshConn): Promise<void>;
  invalidate(hostId: string): Promise<void>;                 // 配置变更/断线后清池
  testConnection(cfg: HostConfig): Promise<{ ok: true; banner?: string } | { ok: false; error: string }>;
  dispose(): Promise<void>;
}

class SshConn {                        // ssh2 封装, 复用 exec + SFTP
  exec(cmd: string, opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number })
    : Promise<{ code: number; stdout: string; stderr: string }>;   // 流式收集
  execStream(cmd: string, opts: {...}): AsyncIterable<{ stream: 'stdout' | 'stderr'; chunk: Buffer }>;
  sftp(): Promise<SFTPWrapper>;        // 同一连接
  // 内部: 半开探测 + 惰性重连(指数退避); 失败抛带 hostId 的 SshError
}

async function verifyHostKey(cfg: HostConfig, knownHostsPath: string): Promise<void>;   // 策略见 §8.1 已决策·host key 校验 UX（TOFU）
function parseSshConfig(path: string): Promise<Record<string, Partial<HostConfig>>>;    // ~/.ssh/config 子集或文档化不支持
```

### 5.3 ssh-tools: 同名工具 + 路由

```ts
type Route = { kind: 'local' } | { kind: 'remote'; hostId: string; remoteCwd: string };
function routeByCwd(cwd: string): Route;          // 占位前缀 ~/.dsh/remote/<hostId>/ 之下 → remote
function mapLocalToRemote(p: string): { hostId: string; remotePath: string } | null;  // 占位↔远端, 编码须可逆(§8.1 已决策·占位目录路径编码)
function mapRemoteToLocal(hostId: string, remotePath: string): string;

// 七个工具入口(签名与官方同名工具对齐, 内部按 Route 分发) — bash/read/write/edit/read_image/glob/grep（见 packages/dsh-ssh/tools.js ROUTED_TOOL_NAMES）
async function toolBash(ctx, args: { command: string; timeout?: number }, cwd: string): Promise<ToolResult>;
async function toolRead(ctx, args: { path: string }, cwd: string): Promise<ToolResult>;
async function toolWrite(ctx, args: { path: string; content: string }, cwd: string): Promise<ToolResult>;
async function toolEdit(ctx, args: { path: string; edits: EditOp[] }, cwd: string): Promise<ToolResult>;
async function toolReadImage(ctx, args: { path: string }, cwd: string): Promise<ToolResult>;  // 远端: SFTP readBytes → attachments.saveImage({data}) 内存直传
async function toolGlob(ctx, args: { pattern: string; path?: string }, cwd: string): Promise<ToolResult>;   // 远端 find 重实现
async function toolGrep(ctx, args: { pattern: string; path?: string; glob?: string[] }, cwd: string): Promise<ToolResult>;  // 远端 grep -rn 重实现
```

路由与委托要点: 本地分支 = 直接调用宿主 ctx.shell / ctx.fs / ctx.subprocess 的公开方法, 保证行为不变; 远端分支 = 统一"绝对路径 + cd 前缀"(§7 R1); read_image 远端分支 = SFTP readBytes(有上限) → attachments.saveImage({data}) 内存直传(无临时文件) → 复用宿主图像解码/展示管线。

### 5.4 ssh-settings: 配置与凭据

```ts
// settings 命名空间 dsh-ssh-hosts(经 ctx.settings schema 化注册, 设置页 settings.section 槽渲染; 点号被 settingsNamespace 拒绝——M2a 实测)
// 【M2b 设计变更】hosts 为 dict(id → HostConfig) 而非数组: 官方 settings merge 对对象递归合并、对数组整体替换,
// 数组下"口令留空=保持已存"无法表达; dict 省略 auth.password 即保留, 删除走 mutate unset ['hosts',<id>]。详见 implemented/feature/2026-08-16-settings-crud-via-typert.md。
const hostsSchema = { hosts: Schema.dict(HostConfigSchema).default({}) };
// 凭据: 口令字段 role('secret')(describe 脱敏 + {path,set} 只写槽); 私钥路径明文引用本地文件; OS keychain 暂不引入(§8.1 已决策·凭据存储)
// 测试连接: F2 → 宿主 SshRemoteService.testConnection(经自建最小 Typert 通道, 客户端 ctx.remote.ssh.testConnection)
```

### 5.5 ssh-dirbrowse: Typert 远程目录浏览

```ts
// Host 侧: @deepseek-ai/dsh-typert-protocol 的 @Remote() 远程服务
@Remote()
class RemoteDirectoryService {
  list(hostId: string, path: string): Promise<DirEntry[]>;      // DirEntry: { name, type: 'dir'|'file'|'link', size?, mtime? }
  stat(hostId: string, path: string): Promise<Stat>;
  exists(hostId: string, path: string): Promise<boolean>;
  resolveHome(hostId: string, path: string): Promise<string>;   // 展开 ~
  mkdirs(hostId: string, path: string): Promise<void>;          // 可选(创建空目录工作区)
}
```

### 5.6 client: 客户端 UI 行

- settings.section: 主机列表(增删改) + 每行"测试连接"(F1/F2); 断线/重连状态条(F9): 工具失败时提示, 重连成功后静默恢复。
- directoryFlow 槽(sidebar.workspaces / conversation.hero.workspace): 远端目录选择器, 选定后回调宿主工作区创建流程(F4/F5)。owner 契约: occupant 拥有从 open 到 onPicked(path)/onCancel/onError 的完整交互(含"新建目录"), busy 期间禁用提交; 组件必须处理 onCancel/onError。

### 5.7 preset（已移除）

已移除，详见 `implemented/simplification/2026-08-20-remove-standard-ssh-preset.md` 与 `archived/2025-08-16-preset-standard-ssh.md`（历史 preset 已整体删除，现行实现为 `agent/created` 钩子路由，无独立 preset）。

---

## 6. 关键技术决策

每项: 决策 / 备选 / 理由。

### D1. ssh2 v1.17 直接使用, 不用 node-ssh / ssh2-sftp-client
- **决策**: 直接依赖 ssh2(exec + SFTP 都用原生接口)。
- **备选**: node-ssh、ssh2-sftp-client 等包装层。
- **理由**: 包装层藏掉流式读、并发控制、原子 rename(读大文件、大目录列举、write 原子替换都需要底层能力); 还引入额外 API 不稳定与版本耦合; ssh2 原生 API 稳定、文档全、依赖面小。

### D2. 文件传输以 SFTP 为主, 纯 shell 解析只作降级
- **决策**: 文件读写/列举/重命名/元数据走 SFTP; 命令执行走 exec。
- **备选**: TRAMP 式 ssh cat/echo/sed 拼 shell。
- **理由**: SFTP 有标准文件语义(rename/stat/mkdir/读偏移/断点), 无 shell 转义注入面, 支持二进制与原子写; 纯 shell 解析仅当远端禁用 SFTP 时降级(P3 后评估)。

### D3. 拒绝 FUSE 主路径
- **决策**: 不依赖 sshfs/macFUSE, 不用内核扩展。
- **备选**: sshfs 挂载把远端目录当本地目录。
- **理由**: macFUSE 是本地内核扩展(需安装 + 管理员权限, 升级脆弱), 违背"纯附加、可插拔"; 挂载故障难诊断且会拖垮本地文件系统路径。

### D4. agent/created 钩子遮蔽而非修改 host（原 preset 复制已移除）
- **决策**: host 插件监听 `agent/created`，仅对远端占位 cwd 会话在 agent scope 注册 7 个同名路由工具遮蔽官方实现；不复制 preset，不改 host 单例，详见 `implemented/simplification/2026-08-20-remove-standard-ssh-preset.md`。
- **备选（已废弃）**: 复制 `standard` 为新 preset 再三行替换；或直接修改 host fs/shell/subprocess。
- **理由**: 钩子方案 preset 无关、零维护点、完全可插拔；preset 复制需同步上游且已冗余（历史实现见 `archived/2025-08-16-preset-standard-ssh.md`）。

### D5. 同名工具而非新工具名
- **决策**: 七个工具与官方同名（bash/read/write/edit/read_image/glob/grep，见 packages/dsh-ssh/tools.js ROUTED_TOOL_NAMES）。
- **备选**: 起新名字(如 ssh_bash)。
- **理由**: 同名让 agent/用户无感切换运行机器, prompt 与习惯零改动, "本地与远端体验一致"是核心诉求; 新名需改 agent 行为与文档, 且不满足"方便切换"。

### D6. 占位目录而非虚拟 URI
- **决策**: 远端工作区 = 本地占位目录 ~/.dsh/remote/<hostId>/<path 编码> 的普通 workspace 记录; cwd 仍是普通绝对路径。
- **备选**: 自定义 URI(如 ssh://host/path)进 workspace 子系统。
- **理由**: 占位目录让 sessions / workspaceRegistry / apiProxy 零改动, 目录选择 UI、会话恢复、历史记录全部天然兼容; 虚拟 URI 需要动 core 的路径语义, 违反硬约束。

### D7. 全程 plain JS(ESM), 不引入构建工具
- **决策**: dsh-ssh 插件代码用 plain JavaScript(ESM, 函数式 + JSDoc 类型注释), 仓库不引入 tsc/tsdown/bundler; 入口即 packages/dsh-ssh/index.js(main 指向它)。
- **备选**: TypeScript + tsdown 构建(core 仓库的做法)。
- **理由**: 外部 bundle 只有十几~几十个文件, 构建工具链收益小、成本高(版本耦合、发布产物校验); 官方 hello-plugin 教程即 plain JS; M1 已按此落地。若日后复杂度失控(M5 评估)再引入 TS, 迁移是机械的。

---

## 7. 风险清单

每项: 风险 / 影响 / 对策。

### R1. 远端无共享 cwd
- **风险**: 每次 exec 都是独立进程, 不存在"上一次 cd 的状态"; 相对路径语义与本地不一致。
- **影响**: 工具结果与本地不一致, agent 困惑。
- **对策**: 所有远端命令统一"绝对路径 + cd 前缀"(如 cd '<remoteCwd>' && <cmd>); 路径先换算为远端绝对路径再下发; 测试夹具覆盖相对路径用例。

### R2. glob/grep 不能复用本地 rg, 需远端 find / grep -rn 重实现
- **风险**: 语义差异——rg 的 -g 过滤、默认忽略规则(.gitignore)、二进制跳过、超时行为, find/grep 都不完全等价。
- **影响**: 搜索结果与本地不一致; 大目录上 find 慢。
- **对策**: 建立"rg 语义 ↔ 远端命令"对照表并逐项实现(忽略规则用 --exclude-dir + .gitignore 读取、二进制用 grep -I、超时用外部 timeout); 无法对齐的差异写进文档并在工具输出里提示; 大目录限制深度/加超时。

### R3. mtime 秒级精度 → 并发写守卫有窗口
- **风险**: edit/写后校验若靠 mtime, 秒内两次写无法区分。
- **影响**: 并发写(agent 与后台任务)可能互相覆盖不被察觉。
- **对策**: 校验用 size + 内容 hash 兜底, 不只靠 mtime; 写操作走 SFTP 原子 rename; 必要时在本地占位目录记录期望状态做二次校验(待验证实现成本)。

### R4. ~/.ssh/config 解析
- **风险**: 用户主机配置散在 ~/.ssh/config(别名、IdentityFile、端口等), 不解析则用户要重复填; 解析则要处理复杂语法。
- **影响**: 配置体验差或解析出错。
- **对策**: 实现轻量解析器(子集: Host/HostName/User/Port/IdentityFile, 通配与 Include 待定); 或文档化"暂不支持, 请在设置页显式填写"(M5 前明确结论)。

### R5. 后台任务(tool-jobs)需远端化
- **风险**: 本地 tool-jobs 依赖本地进程生命周期; 远端长任务(编译、测试)若走普通 exec, 连接/会话结束即被杀。
- **影响**: 远端后台任务不可用或结果丢失。
- **对策**: 方案三选一并在 M5 定案——nohup ... & 写日志文件、tmux 会话、或持久 exec 通道; 提供"远端 job 输出回读"接口(读日志尾部 + 进程状态探测)。

### R6. 断线重连与半开连接
- **风险**: 网络中断后 TCP 半开, exec 挂起无响应; 重连时机与状态恢复难。
- **影响**: 工具调用卡死, agent 回合超时。
- **对策**: keepalive(SSH keepalive + 应用层探测)+ 操作超时; 惰性重连(首次失败即失效连接, 下次 acquire 重建)+ 指数退避; exec 中途断线返回明确 SshError(带 hostId 与阶段), 上层给出 F9 提示。

### R7. 连接池并发上限
- **风险**: 每个连接同时开多个 exec/SFTP 会撞 sshd 的 MaxSessions; 并发爆炸。
- **影响**: 远端拒绝连接或会话异常。
- **对策**: 池上限 maxConnections(默认 4)+ 通道排队; SFTP 通道每连接至多一个(串行化文件操作); 测试撞 MaxSessions 边界。已落地: `SshConn` 每连接 FIFO 会话通道信号量(`maxChannelsPerConnection` 默认 6, 见 `implemented/bug-fix/2026-09-02-session-channel-limit.md`)。

### R8. 逐文件 SFTP 往返性能
- **风险**: 大目录列举、批量 edit、glob 结果读取若逐文件往返, 延迟 × 文件数。
- **影响**: 用户体验差(尤其跨网络)。
- **对策**: 大目录用 readdir 批量 + 延迟 stat; glob/grep 在远端单命令内完成并只回传匹配路径; edit 单次读改写(不反复往返); 必要时对单次调用结果做大小上限保护。

### R9. 安全
- **风险**: host key 不校验(中间人)、私钥/口令明文落盘、命令经 shell 拼接注入。
- **影响**: 凭据泄露、远端被控制。
- **对策**: known_hosts 校验(TOFU 首次写入或预填指纹, 策略见 §8.1 已决策·host key 校验 UX; host key 变更必须报错); 凭据进 DSH secret（`role('secret')`）机制, 不进 settings.yaml 明文; 命令与路径统一经引号转义工具处理, 文件内容走 SFTP 参数通道不走 shell。

### R10. Windows 远端 OpenSSH 差异
- **风险**: 路径分隔符、换行(CRLF)、默认 shell(PowerShell/cmd)、权限语义与 POSIX 不同; find/grep 在 Windows 上未必可用。
- **影响**: 工具行为不一致或直接失败。
- **对策**: 明确支持范围——P3 前仅支持 Linux/macOS 远端; Windows 远端文档化限制(路径映射与 shell 策略), 不做隐藏适配。

---

## 8. 开放问题清单

### 8.1 已决策（每项 1 行结论+出处）

- **standard preset 原文位置**：`config/agent-presets/standard/agent.cordis.yml`（含 tool-bash/tool-fs/tool-fs-search 三行），出处 `archived/2025-08-16-preset-standard-ssh.md` → preset 已整体移除，改为 `agent/created` 钩子路由（`implemented/simplification/2026-08-20-remove-standard-ssh-preset.md`）。
- **agentPresets.copy 产物落点**：`$DSH_HOME/.agent-presets` 自动加载（`dsh-agent-presets/lib/index.js:160`）→ 已随 preset 移除而废止，同上。
- **工具实现包归属**：`bash→dsh-tool-bash、read/write/edit/read_image→dsh-tool-fs、glob/grep→dsh-tool-fs-search`（`research/2026-08-20-dsh-official-reference.md`）。
- **M2 测试远端**：改用真实远端主机与 `test/live-config.mjs` + `DSH_SSH_TEST_*` 覆盖（`packages/dsh-ssh/test/live-config.mjs`）。
- **凭据存储**：`role('secret')` 口令字段（describe 脱敏 + {path,set} 只写，私钥路径明文引用本地文件，暂不引入 OS keychain），出处 `src/settings.js` HostConfigSchema / `lib/hosts-model.js` redactHosts / `implemented/feature/2026-08-16-settings-crud-via-typert.md`。
- **settings.section 槽精确用法**：`settings.section` (kind list, scope root) id `ssh-hosts` order 40，经 `ctx.settings` + Typert 持久化（点号被 settingsNamespace 拒绝），出处 `packages/dsh-ssh/client.js` SshHostsSection / `src/remote.js` / `research/2026-08-20-dsh-official-reference.md`。
- **directoryFlow 槽返回契约**：`sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow` (priority -1) 覆写官方，owner 拥有 open→onPicked/onCancel/onError 完整交互，出处 `client.js` DirectoryFlowCombined / `src/remote.js` listRemoteDir 等。
- **read_image 远端分支**：远端 SFTP readBytes(有上限)→attachments.saveImage({data}) 内存直传(无临时文件)→复用宿主图像管线，出处 `packages/dsh-ssh/tools/fs.js` read_image 分支。
- **占位目录路径编码**：`~/.dsh/remote/<hostId>/<base64url(绝对路径)>` 单段可逆、hostId 校验防穿越，已实现 `src/router.js` encodeRemotePath / `src/placeholder.js`。
- **连接池关闭时序**：SshPool acquire/release/invalidate/dispose + SshConn._onClose 惰性重连与 in-flight 处理，出处 `src/ssh-core.js`。
- **Windows 远端支持范围**：优先 Linux/macOS；Windows 远端仅 bash 跟随远端平台、pwsh 不路由，文档化限制，出处 `implemented/feature/2026-08-19-preset-independent-tool-routing.md` + §7 R10。
- **ssh-agent 转发**：支持 `SSH_AUTH_SOCK` 转发（`process.env.SSH_AUTH_SOCK → opts.agent`），私钥口令交互不另行透传，出处 `src/ssh-core.js`。
- **host key 校验 UX**：TOFU 弹窗（HOST_KEY_UNKNOWN_STAGE → 指纹/类型展示→信任后写 known_hosts→自动重试），mismatch 硬拒绝，出处 `implemented/feature/2026-08-19-tofu-host-key.md` / `src/ssh-core.js`。

### 8.2 待决策

- **版本兼容矩阵**：`rc.7` 的 `peerDependencies` 声明与升级回归点。

---

## 9. 版本与更新规则

### 9.1 何时更新

- **任何设计变更**: 先改本笔记(或记 .agents/notes/implemented/), 再动代码(AGENTS.md §5 约定);
- **每个里程碑完成后**: 回写实测验证过的命令、API、踩坑(含出处: 文档 URL 或本地源码路径);
- **"已验证"事实变化 / 开放问题定案时**: 分别更新对应小节, 开放问题从 §8 移出。

### 9.2 由谁更新

- **主代理**: 负责本笔记的结构与重大设计修订;
- **子代理**: 任务结束时把关键结论/已验证事实/踩坑追加或修正到对应小节(以追加为主; 并发回写冲突时保留双方条目并标注, 不覆盖他人结论);
- 每次更新刷新文件头的"最后更新"日期与本次改动摘要。

### 9.3 记录规范

- "已验证"必须注明出处(文档 URL 或本地源码路径, 如 dsh-agent-presets/lib/index.js:1045);
- 未验证的猜测标注"(待验证)";
- 本笔记不设正式版本号, 以 git 历史 + 文件头日期为准。

---

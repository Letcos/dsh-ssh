# 竞品调研:远程工作区场景下的扩展能力面(skills/插件/MCP)

> 调研日期:2026-08-16(基于 web_search 官方文档/仓库;部分新产品的细节标注"待核实")
> 关联:设计笔记 A.25 节提到 dssh 六工具按 cwd 路由到远端,但 skill 脚本资源、MCP server 仍在本地执行。本文调研业界各家在远程工作区场景如何处理扩展能力面,为 dssh 的 skill/MCP 定位(A 文档化 / B 资源同步 / C 提示注入)提供对标。

---

## 0. dssh 能力面现状(对标基准)

- dssh = 本地 DSH 插件 + standard-ssh preset:bash / read / write / edit / read_image / glob / grep 七工具按会话 cwd 路由,远端占位路径(\~/.dsh/remote/<hostId>/...)走 SSH exec+SFTP,本地路径委托宿主———远端零安装,只依赖 sshd 自带 exec+SFTP。
- **扩展能力面**:skill 脚本资源、MCP server 仍在本地执行,**不跟随远端工作区**。本文即回答"业界怎么解决这个,我们该对标谁"。

---

## 1. 各家结论(Core:每个产品回答五个问题)

### 1.1 ZCode(智谱 Z.AI 出品,GLM-5.2 与 GLM-4 官方 harness)
> 先确认产品身份:ZCode 是**智谱 Z.AI 面向 GLM 系的 AI 代码编辑器/agent harness**(非 Zed 相关、非开源框架),主打轻量、对标 Cursor/Claude Code。来源:venturebeat、devops.com、techorange 等 2026 年报道。

- **架构形态**:本地桌面 harness;官方有 **SSH Remote Connection (Beta)** 页面(zcode.z.ai/docs/ssh 与 /en/docs/remote-development),方向定位**轻量 SSH**。是否纯 exec+SFTP 通道还是远端装 server,子在子代理环境 web_search 取不到正文,**待核实(需直接打开官方 ssh 文档确认)**。是目前与 dssh 结构最接近的竞品。
- **扩展执行侧**:待核实(方向倾向轻量 SSH + 本地 controller,但无正文佐证)。
- **MCP 部署**:待核实。
- **能力面 UX**:待核实。
- **取舍**:最值得跟进的对标;但资料新且少,细节需核对官方 SSH 文档。
- 关键 URL:https://zcode.z.ai/docs/ssh 、https://zcode.z.ai/en/docs/remote-development

### 1.2 VS Code Remote-SSH / Cursor 远程
- **架构形态**:重量派。VS Code Remote-SSH 在远端安装 **VS Code Server**(\~/.vscode-server);Cursor 经典 Remote 装 \~/.cursor-server。远端非零安装(需装 server 组件)。
- **扩展执行侧**:**双 extension host**——本地 UI extension host + 远端 workspace extension host。**扩展按工作区自动跟到远端**,靠 package.json 的 `extensionKind`(`ui`/`workspace`/`uiWorkspace`)声明该扩展在哪一侧跑。
- **MCP 部署**:`.vscode/mcp.json` 随工作区同步(配置层跟随),但 **MCP server 进程由本地客户端启动,本体不走远端**;"MCP 跟随到远端"需第三方 SSH-MCP 扩展。
- **能力面 UX**:**业界最成熟**。extensionKind 机制即"能力面说明"——声明并标注扩展在哪侧执行(UI 侧本地 / workspace 侧远端),否则运行时不可用会出问题。属于"配置化 + 市场/设置 UI 标注"。
- **取舍**:"跟随到远端"靠**搬整段 extension host**实现,代价是远端必装 server——正是 dssh"远端零安装"要绕开的反面教材。
- 关键 URL:https://code.visualstudio.com/api/advanced-topics/remote-extensions 、https://code.visualstudio.com/api/advanced-topics/extension-host 、https://code.visualstudio.com/docs/remote/ssh

### 1.3 Cursor(远程两条路线)
- **经典 Remote-SSH**:沿用 VS Code 架构,远端装 \~/.cursor-server(重量)。
- **新版 Cloud Agents(2025-2026 主打)**:agent 跑在**隔离云端 VM(Nix 沙箱)+ computer use + 并行后台**,支持 **self-hosted**(自有 SSH/K8s 跑,代码不出内网)="agent 全远端执行"的极端重度形态。
- **MCP/能力面**:云端 agent 的环境里装配;self-hosted 可把能力带到自有远端。
- 关键 URL:https://cursor.com/changelog 、https://cursor.com/docs(云端 agent 文档)。

### 1.4 Zed 编辑器 remoting
- **架构形态**:**重量派**。官方 "SSH Remoting":本地 Zed UI 经 SSH 连远端,但远端需部署 **Zed 自己的 headless server**(远端 zed binary / zed-server)承载编辑后端,非纯 sshd 通道。文档原话 "Remote Development lets you edit code on a remote server while running Zed locally"。断线重连有专门基础设施(PR #18572)。→ 对 dssh 是明确反例。
- **扩展执行侧**:LSP/语言服务跑**远端**(远端需预装工具链);语言扩展会**同步到远端**(PR #56487,早期跑本地)。但 **AI / assistant / agent 跑本地**——模型 provider、API key、本地模型(Ollama)都在本地进程配置执行,远端只提供代码上下文。="编辑/语言服务在远端、AI 脑在本地"。
- **MCP 部署**:**不跟随远端**:官方 issue #34402 "AI: Support running MCP via SSH Remoting" 长期开放(状态待核实,长期是 feature request)。
- **能力面 UX**:文档化说明(Remote Development 页面说明哪层跑本地/远端、Toolchains 工具链配置、扩展同步),非 UI 可视化能力面。
- **取舍**:远端装 Zed server + 语言工具链,部署重但 LSP/索引完整;AI 脑在本地需网络来回传代码上下文;MCP 不能跟随是短板。
- 关键 URL:https://zed.dev/docs/remote-development 、https://zed.dev/blog/remote-development 、https://github.com/zed-industries/zed/pull/56487 、https://github.com/zed-industries/zed/pull/18572 、https://github.com/zed-industries/zed/issues/34402 、https://zed.dev/blog/local-ai-in-zed

### 1.5 OpenCode
- **架构形态**:本地终端 agent;`opencode serve` = 启动 HTTP server(headless,可配监听/认证/CORS/mDNS),经 OpenAPI/SDK 被客户端连接。**agent 在 server 进程里跑,server 跑在哪、agent 就在哪**。无"轻量 SSH 通道式远端工作区";对接远程靠 git provider 拉取/推送;想在远端跑通常把 opencode 整个装到远端(社区 Docker,重量)。
- **扩展执行侧**:能力面 = plugins(hook,可注册 tools/commands/skills/MCP)+ skills + MCP,全部在 opencode(server)进程内加载,**跟随进程所在机器**(远端则远端、本地则本地),不跟工作区。
- **MCP 部署**:opencode.json(全局/项目级)配置,由该进程启动/连接,与 agent 同机;无"MCP 跟随工作区到远端"官方机制。
- **能力面 UX**:Server/Server Architecture 文档(HTTP API/OpenAPI/Auth/CORS/mDNS)+ SDK(TS/Python/Elixir)。文档化,非 UI 可视化。
- **取舍**:模式 = "一个 agent 进程 + 一个工作目录上下文";远程 = 把 agent 整体部署到远端(重)。issue #8795 "Execute Code on Remote Server, but Route Model API Calls via Local Machine"——本地路由模型调用、远端执行代码的诉求**仍是开放需求,未内建落地**。
- 关键 URL:https://github.com/anomalyco/opencode/blob/main/packages/web/src/content/docs/server.mdx 、https://open-code.ai/en/docs/server 、https://github.com/anomalyco/opencode/issues/8795 、https://docs.opencode.ai/docs/sdk/

### 1.6 Claude Code
- **架构形态**:**单进程单环境模型**。谁运行 `claude`,谁就同时承载 agent/subagent/工具与工作区。**没有 dssh 式"分布式远端工作区 + 按 cwd 路由工具"官方概念**;官方远程形态 = **Development containers**(把整个 claude 进程装进容器,agent/subagent/工具全在容器内执行)。
- **扩展执行侧**:扩展面 = **指令注入(skills)+ 进程式工具(MCP)** 双轨,无"远端执行层"。
  - **Skills(Agent Skills)**:不是可执行程序,而是 **Markdown 指令目录**(<dir>/SKILL.md,fronmatter name/description + 正文步骤 + 可选 scripts/ resources/)——被**注入 agent 上下文供其照做**;其中脚本/资源**由 agent 通过自己的工具调用读取/执行**,落地在 claude 进程所在机器 + 当前工作区,**不跟远端工作区走**(与 dssh 现状一致)。
  - subagent 始终与主进程同环境。SSH 远程 = SSH 到某台机器、在那台机器运行 claude(整个环境迁移到目标机器,非"本机进程+远端挂载")。
- **MCP 部署**:三作用域——**user**(\~/.claude.json 全局)、**local**(\~/.claude.json 当前机器)、**project**(`.mcp.json` 项目根、可提交 git,最接近"跟随工作区")。但 project 作用域是**配置层跟随项目、执行层仍在运行环境**,且交互会话会先弹安全批准(headless/无人值守受限,细节待核实)。**没有自动把 MCP server 部署到远端的机制**;远端需 server 进程随环境装配,或用 http/sse/streamable-http URL 连他处。
- **能力面 UX**:**无**"某能力在远端不可用"提示面板;能力控制是**配置性**的(`--allowedTools`/`--disallowedTools`/`settings.json`/权限批准),不做运行时探测 + 主动通告。
- **取舍**:skills 本质是"已注入上下文的指令+资源",不假设远端执行——这正是 dssh 可直接对标的关键点。
- 关键 URL:https://code.claude.com/docs/en/skills 、https://code.claude.com/docs/en/agent-sdk/skills 、https://claude.com/blog/skills 、https://code.claude.com/docs/en/mcp 、https://code.claude.com/docs/en/devcontainer 、https://code.claude.com/docs/en/sub-agents 、https://code.claude.com/docs/en/settings 、https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills

### 1.7 Windsurf / Aider / devcontainers·DevPod / code-server
- **Windsurf**:VS Code fork;远程复用标准 **Remote-SSH / Dev Containers** 机制(本地只跑编辑器 UI,Remote-SSH 时 agent 工具落远端——随 VS Code 扩展host)。Windsurf 2.0(被 Cognition 收购)新增 Agent Command Center + 内置 **Devin 云 agent**(云端沙箱跑,独立订阅)。MCP 走 VS Code MCP 资源模型,远程是否随扩展host落远端**待核实**。取舍:完整 IDE 重量级、远端需装 Remote-SSH 组件(非零安装)。URL:https://docs.windsurf.com/zh/windsurf/advanced 、https://cognition.com/blog/devin-in-windsurf
- **Aider**:终端 AI pair programmer,靠 **git 工作流**编辑。"你在哪台机器启动 aider 就在哪台工作";工具(/run、/git、自定义命令 `.aider.commands.md`) = **同宿主 subprocess**;远程需用户手动把进程放到远端(SSH/docker exec),**非内置路由**。2025 引入 MCP server 支持(只读开放、同进程同宿主)。**没有 skill 概念**;能力扩展 = 自定义 shell 命令 + MCP tool。取舍:极轻、模型无关;MCP 只读不做写。URL:https://aider.chat/docs/ (commands) https://aider.chat/docs/usage/commands.html (docker) https://aider.chat/docs/install/docker.html
- **devcontainers**:容器即工作区(devcontainer.json 描述镜像/工具/tasks)。在 VS Code Dev Containers 里,**扩展、语言服务、包括 MCP server 都在容器内启动运行**(vscode-docs containers.md;VS Code 1.102 起 MCP server 成为一等资源、远程时随扩展host进容器)。
- **code-server / openvscode-server**:把整个 VS Code server 跑在远端容器,浏览器访问——**所有扩展/MCP/终端/语言服务全 server-side 在容器里**,本地只剩浏览器("整个 IDE 迁到远端"的极致)。
- **DevPod(loft-sh)**:DevContainers everywhere / Codespaces 开源版。核心 = **provider 抽象**:provider 是份把"机器"创建出来的脚本(本地 docker / 任意云 / k8s / SSH),DevPod 用 provider 在任意基础设施拉起 workspace,把本地代码 mirror 进去,再用 VS Code Remote 连任意 IDE。URL:https://devpod.sh/docs/what-is-devpod 、https://devpod.sh/docs/developing-providers
- **取舍**:容器范式 = 把"环境"和"agent/扩展执行侧"一并打包进远端,语义清晰但重,**前提是远端有容器运行时/镜像**,与 dssh"远端零安装"相反。URL:https://github.com/coder/code-server 、https://github.com/gitpod-io/openvscode-server

---

## 2. 对比矩阵

| 产品 | 远端装 server?(重量/轻量) | 扩展能力(skills/插件/工具)执行侧 | MCP server 部署 | 有没有"MCP 跟随工作区到远端" | 能力面说明 UX | 取舍/代价 |
|---|---|---|---|---|---|---|
| **dssh(本方案)** | **纯 SSH 通道(exec+SFTP),零安装** | 六工具按 cwd 路由到远端;skill 脚本/MCP **仍在本地** | 本地执行 | 无(现状) | 尚无,拟补(本文结论 B) | 远端零安装;能力面不分叉 |
| **ZCode** | 官方 SSH Remote(Beta),方向**轻量 SSH**(细节待核实) | 待核实(最接近 dssh) | 待核实 | 待核实 | 待核实 | 最值得跟进的对标;资料新且少 |
| **VS Code Remote-SSH** | **重量**(远端装 VS Code Server) | 双 extension host,扩展**自动跟到远端**(extensionKind) | .vscode/mcp.json 随工作区同步,但 server 进程**本地启动** | 配置层同步,执行层不迁 | **最成熟**(extensionKind 标注 ui/workspace) | "跟到远端"靠搬整段 extension host→远端必装 server |
| **Cursor 经典 Remote-SSH** | **重量**(远端装 ~/.cursor-server) | 同 VS Code | 同 VS Code | 同 VS Code | 同 VS Code | 同 VS Code |
| **Cursor Cloud Agents** | 云端 VM(或 self-hosted SSH/K8s) | **agent 全在远端沙箱执行** | 远端装配 | 随环境 | 有云端环境配置 | 极端重度;需 Nix/沙箱;self-hosted 可不出内网 |
| **Zed remoting** | **重量**(远端装 zed-server + 工具链) | **LSP/语言服务在远端,AI/agent 在本地**("编辑远端、AI 脑本地") | **不跟随**远端(issue #34402 长期开放) | 无 | 文档化说明,非 UI | 远端要装 Zed server;AI 上下文要来回传 |
| **OpenCode** | 无轻量 SSH 层;远程=把 opencode 整个装远端 | plugins/skills/MCP 全在 **agent 进程内**,**跟随进程所在机器** | 进程同机启动 | 无 | Server/SDK 文档化 | 单进程单目录;远程=整搬 agent(issue #8795 未落地) |
| **Claude Code** | 无官方 dssh 式远端工作区;远程=**devcontainer 整个进程** | skills=**指令注入上下文**,执行落在进程所在机器,**不跟工作区**;/MCP 进程式 | project 级 `.mcp.json`(配置跟随项目,执行仍在运行环境) | 配置层随项目,执行层不迁 | **无**能力面面板;能力控制靠 allow/deny 配置 | skills 不假设远端执行=最贴合 dssh 现状 |
| **Windsurf** | 重量(Remote-SSH/Dev Containers) | Remote-SSH 时 agent 工具落远端;或 Devin 云 agent | 走 VS Code MCP 资源模型(远程行为待核实) | 无内建 | IDE 形态,成熟混合 | 完整 IDE 重;Devin 独立订阅 |
| **Aider** | "在哪启动在哪跑",远程=用户手动放远端 | 工具=同宿主 subprocess,**无 skill 概念**,能力=自定义命令+MCP | 同进程同宿主,只读 | 无 | 无 | 极轻;远程无内置路由;MCP 只读 |
| **devcontainers/DevPod/code-server** | **重量**(远端容器/IDE server) | 扩展/语言服务/**MCP server 全进容器** | 打进容器,随容器同址 | 有(容器即工作区,server 与工作区同址) | 容器环境内完整 | 依赖远端容器运行时;与零安装相反;DevPod 用 provider 抽象 |

---

## 3. 业界方案分类归纳(三种范式)

**范式一:重量派——"能力面整段搬到远端"**
- 代表:VS Code/Cursor 经典 Remote(远端装 server + 扩展host)、Zed(远端装 zed-server)、devcontainers/code-server/DevPod(容器即工作区)、以及"把整个 agent 部署到远端"(OpenCode 远程、Claude Code devcontainer、Cursor Cloud Agents 云端沙箱、Windsurf Devin)。
- 特征:远端装配完整(server/容器/沙箱),能力面一致、语言服务完整;代价是远端有安装/运行时要求,**与 dssh 零安装硬约束冲突**。
- MCP 在范式一下多数"随容器/环境装配"或"配置跟随项目、server 进程本地启动"(VS Code)。

**范式二:混合派——"本地 controller + 远端 edit"**
- 代表:Zed(语言服务在远端、AI 脑在本地)、VS Code(UI 扩展host 本地 + workspace 扩展host 远端)。
- 特征:按"哪一层"切分执行侧,能力面分叉由工具/extensionKind 显式管理。dssh 的"bash/fs 远端、skill/MCP 本地"其实是混合派的一种,只是 dssh 是靠 cwd 路由而非搬扩展host 实现。

**范式三:轻量通道派(稀缺)——"本地 controller + 纯 SSH 通道路由工具"**
- 目前**只有 dssh 在系统化落地**;ZCode SSH Remote(Beta)方向疑似同派(待核实);OpenCode issue #8795(本地路由模型调用、远端执行代码)、Zed issue #34402(MCP 跟随 SSH)都还是**开放需求**。
- 特征:远端零安装,只靠 sshd exec+SFTP;代价是能力面在远端受限(只能跑通道内的那组工具)。

**MCP 远程部署的业界通用模式(跨范式)**
- **没有"MCP server 自动跟随工作区到远端"的标准机制**;MCP 规范只定义传输(stdio / Streamable HTTP,RFC #206 取代 HTTP+SSE),不定义 server 部署在谁的进程/哪台机器。
- 实际三种做法:
  (a) **本地客户端连远端 HTTP MCP server**(标准做法,用 Streamable HTTP URL 连他处部署的 server)。
  (b) **SSH 包装为 MCP**:本地起一个 MCP server 包住远程 exec/SFTP,暴露成 tools(ssh-mcp / mcp-ssh-server 等)——**与 dssh 思路同源**。
  (c) **devcontainer 内 MCP**:把 MCP server 打包进容器/feature,随容器在远端起。
- 启示:**没有先例把 MCP server"按 cwd 跟随到远端做成零安装"**;业界普遍 = "本地 MCP + 远端连通(HTTP 或 SSH 通道)"。

---

## 4. 对 dssh 的启示(skill 脚本 / MCP 的合理定位)

**硬约束回顾**:远端零安装 → 远端不能装server/agent/运行时。因此 MCP server(进程式工具)和 skill 脚本(需执行环境)都**无法真正部署到远端**;远端只能跑"通道内的那组工具"(bash/fs/glob/grep)。

**A / B / C 三选项的业界先例对照**:

- **A(文档化能力面说明)——有成熟先例 ✔**
  - **VS Code extensionKind** 是业界最成熟的"能力面说明"机制:扩展用 `ui`/`workspace`/`uiWorkspace` 声明在哪侧执行,市场/设置页标注,运行时不可用会报错。这证明"告诉模型/用户哪些能力在远端不可用"是有先例且被用户接受的做法。
  - Zed 也靠 Remote Development 官方文档化说明哪层跑本地/远端。
  - → 给 dssh 的落地:在设置/工作区 UI 主动标注"当前运行机器(远端)上不可用的能力面"(MCP、skill 脚本在本机;远端只在六工具集内);或向 agent 注入能力面说明(见 C)。

- **B(资源同步)——业界只有"重量级整段同步"先例 ⚠**
  - VS Code/Cursor 扩展"按工作区自动跟到远端"、Zed 语言扩展同步到远端(PR #56487)、devcontainer 把 MCP 打进容器——都是**把整段环境/扩展 host 同步过去**的重量做法,前提是远端有对应运行时。
  - **在"远端零安装"前提下做轻量资源同步(只把 skill 脚本/resources 同步到远端,不搬扩展 host)业界没有直接先例**——这是 dssh 可差异化的点,但需自建 SFTP 同步 + 版本一致性 + 清理策略,成本最高。
  - → 若选 B,可借鉴 Zed"语言扩展同步"的思路,但限制在"纯数据/脚本资源"层面(远端零安装下只能同步可被 bash/fs 工具消费的脚本,不能同步需要 server 的能力)。

- **C(提示注入)——有直接先例 ✔(Claude Code skills)**
  - **Claude Code 的 Agent Skills 本身就是"指令注入 + 执行落在进程所在机器、不跟工作区"**:skill = 注入上下文的 Markdown 指令(SKILL.md),脚本/资源由 agent 通过自己的工具读取执行;Claude Code 明确不假设 skill 在远端执行。
  - 这**与 dssh 现状(远端只跑 bash/fs,skill 脚本本地)语义一致**,说明"skill 脚本不跟随远端执行"是业界常态,不是 dssh 的缺陷。
  - Claude Code skills 本质是 **A(文档化说明)+ C(注入上下文指令)** 的混合。

**推荐定位(在零安装硬约束下)**:
1. **skill 脚本 → C(提示注入)+ A(文档化)**:以 Claude Code Agent Skills 为先例,把 skill 作为注入上下文的指令/资源,明确"skill 内容在注入时说明、其脚本在本地执行、远端会话仅暴露六工具集";在 SKILL.md/能力说明里写清在远端环境下哪些步不可用(A)。**不必强行把 skill 脚本同步到远端**——Claude Code 都不这么干。
2. **MCP → 对标 (b) ssh-mcp 模式 + Claude Code `.mcp.json` 项目级声明**:(i) 若要在远端会话用 MCP,业界先例是"本地起一个 MCP server,用 SSH 通道把远端能力暴露成 tools"(ssh-mcp,与 dssh 思路同源),而非把 MCP server 部署到远端;(ii) 或在配置里声明"MCP server 属本机,远端会话不可用",即 A 方案。**不强行让 MCP 跟随远端**(零安装下无先例)。
3. **能力面 UX → A(对标 VS Code extensionKind)**:在 UI 主动标注"当前运行机器上不可用的能力面",这在业界有成熟先例、成本低、收益直观,建议优先做。

**总结一句话**:业界在零安装前提下**没有任何一家做了"MCP/skill 跟随远端"的成熟机制**;Claude Code 的 skills(指令注入、不跟远端)与 ssh-mcp(本地 MCP + SSH 通道暴露远端)是最贴合的两位对标。dssh 应主走 **A + C**——文档化能力面说明(参考 VS Code extensionKind)+ skill 即注入指令(参考 Claude Code skills),MCP 保持本地并文档化声明;可选的 B(轻量资源同步)是业界无先例的差异化点,留作 M5 之后的增强项评估,需权衡 SFTP 同步与清理成本。

---

## 5. 备注与"未找到公开资料"

- **ZCode**:产品身份已确认(智谱 Z.AI 官方 harness);官方 SSH Remote(Beta)页面存在,但"纯 SSH 通道 vs 远端装 server""MCP 跟随"等细节在 web_search 环境取不到正文 → **标注"待核实"(需直接打开 zcode.z.ai/docs/ssh 确认)**。
- **Claude Code 无人值守(headless)下 project 级 `.mcp.json` 的 server 批准行为**:待核实。
- **Windsurf Remote-SSH 下 MCP server 是否随扩展host 落远端**:按 VS Code 行为推断,待核实。
- **Zed issue #34402(MCP over SSH remoting)当前 shipped/开放状态**:长期开放 feature request,当前精确状态待核实。
- 除以上外均基于官方文档/仓库/官方 issue,见各家"关键 URL"。

---

## 6. 外部参考资料(原始 URL,按产品归组)

**ZCode**
- https://zcode.z.ai/docs/ssh
- https://zcode.z.ai/en/docs/remote-development
- https://venturebeat.com/technology/z-ai-launches-zcode-to-challenge-cursor-claude-code-and-github-copilot-in-ai-coding
- https://devops.com/z-ai-debuts-zcode-to-compete-with-github-copilot-cursor-and-anthropic/

**VS Code / Cursor**
- https://code.visualstudio.com/api/advanced-topics/remote-extensions
- https://code.visualstudio.com/api/advanced-topics/extension-host
- https://code.visualstudio.com/docs/remote/ssh
- https://code.visualstudio.com/docs/devcontainers/containers
- https://code.visualstudio.com/docs/agents/reference/mcp-configuration
- https://vscode.js.cn/updates/v1_102(MCP 一等资源)
- https://cursor.com/changelog 、https://cursor.com/docs (Cursor Cloud Agents / self-hosted)

**Zed**
- https://zed.dev/docs/remote-development
- https://zed.dev/blog/remote-development
- https://github.com/zed-industries/zed/pull/56487 (Sync language extensions to remotes)
- https://github.com/zed-industries/zed/pull/18572 (断线重连基础设施)
- https://github.com/zed-industries/zed/issues/34402 (MCP via SSH Remoting)
- https://zed.dev/blog/local-ai-in-zed

**OpenCode**
- https://github.com/anomalyco/opencode/blob/main/packages/web/src/content/docs/server.mdx
- https://open-code.ai/en/docs/server
- https://github.com/anomalyco/opencode/issues/8795 (远端执行/本地路由模型调用)
- https://github.com/anomalyco/opencode/blob/main/packages/web/src/content/docs/mcp-servers.mdx
- https://docs.opencode.ai/docs/sdk/

**Claude Code**
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/agent-sdk/skills
- https://claude.com/blog/skills
- https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- https://code.claude.com/docs/en/mcp (.mcp.json 三作用域)
- https://code.claude.com/docs/en/devcontainer
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/settings

**Windsurf / Aider / devcontainers·DevPod / code-server**
- https://docs.windsurf.com/zh/windsurf/advanced
- https://cognition.com/blog/devin-in-windsurf
- https://aider.chat/docs/usage/commands.html 、https://aider.chat/docs/install/docker.html
- https://devpod.sh/docs/what-is-devpod 、https://devpod.sh/docs/developing-providers
- https://github.com/coder/code-server 、https://github.com/gitpod-io/openvscode-server

**MCP 远程/传输**
- https://modelcontextprotocol.io
- https://github.com/modelcontextprotocol/modelcontextprotocol/pull/206 (Streamable HTTP)
- https://github.com/uarlouski/ssh-mcp-server 、https://hub.docker.com/r/firstfinger/ssh-mcp (SSH 包装为 MCP)

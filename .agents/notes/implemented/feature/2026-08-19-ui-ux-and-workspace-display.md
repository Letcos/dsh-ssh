# Agent Note: 设置页/目录流程 UI/UX 与占位工作区显示命名
Status: implemented

## Problem
- 设置页与工作区选择对话框的原生控件、文案、状态反馈不够美观统一;远程占位工作区的显示名一度是 base64 编码段(不可读),后又是纯 basename(无法区分多主机);bash 工具卡片的 cwd 显示 base64。

## Decision
- **占位工作区显示名分层演进**:最终格式 = `主机显示名 / basename`(如 `ubuntu / opencode-api`);此前为 `basename · 主机显示名`、再之前为纯 basename。`workspaceRegistry.create(localPath, title)` 显式传 title(不让 framework 取占位目录 basename);旧记录自动迁移:仅当 title 恰为「base64 编码段」或「纯 basename(旧签名)」时 setTitle 升级,已含分隔符的用户定制标题不动、幂等。
- **bash 卡片 cwd 显示 base64**:官方 BashRow 把 session cwd 尾段直接显示。宿主侧无法修(presentCall 只收 args,无会话/路由上下文;占位目录名不能被路由可逆地改)→ 客户端自定义 toolview:注册 `tool.call.toolview` keyed 槽 key=bash 且 priority:-1 覆写官方 BashRow,渲染前把 card.cwd 经 sshDecodeRemoteCwd 解码(镜像 router 的可逆守卫);本地不命中原样返回,显示逐字节不变。
- **UI/UX 规范四批(design/ui-ux-spec.md §6 A/B/C/D)+ 默认工作区方案 C**:
  - A:智能默认 tab(未定态按主机记忆选 remote/local;tab/主机记忆降级为浏览器 localStorage——api.settings 写不了插件命名空间且红线禁改 src;本地页签不自动弹系统对话框,显式「选择本机文件夹…」触发)。
  - B:文案重写(zh/en 对称各 48 键),黑话清零(sshd/exec/SFTP/占位/命名空间…不再进用户文案)。
  - C:状态组件收敛为官方 `StatusNote`(StateDot)+ 删除确认改官方 Modal + 表单内测试连接 + 空态 CTA/错误重试;原生下拉框改官方 Menu 组件(SelectMenu),「添加」按钮防换行。
- 全部新样式走 `--dsw-alias-*` 主题 token(DSH 无 state-info-*/accent token,用 brand-primary / state-business-primary 蓝),深/浅色主题自适应。
- **D: 远程页签多主机切换**:配置主机数 >1 时,远端浏览阶段的 pathbar 用官方 `SelectMenu` 呈现主机切换器(取代之前的只读 Pill),选中即 `selectHost(id)` → `resolveRemoteHome` 重新列该机家目录;单主机时保持 Pill 作为「当前主机」标识(`.dsh-remote-hostswitch` 容器限宽 180–220px 防挤压路径)。
- **E: 移除「上次使用:远程」提示**:删除弹窗顶部 `tab.defaultHint` 提示元素及为之存在的 `fromMemory` 状态/逻辑,并移除 ZH/EN 对应 locale key——本地与远端页签都不再显示该提示。
- **F: 设置详情页标题纯文字化**:标题由「地球 icon+远程主机」改为纯文字 `h2`「SSH 连接」,CSS 对齐官方设置详情标题(`dsh-client-ui-settings-models` ModelsSection 的 h2.title:16px/500/24px,不另创字号);移除详情标题上的地球 icon(`IconGlobeOutline14` 随之删除)。
- **G: 主机列表地址展示脱敏**:新增 `maskHostAddress`(仅展示层)——保留地址首尾点分段、中间每段替换为 `***`(如 `49.***.***.93`;hostname 同理,≤2 段时原样返回),应用到 HostRow 的地址行;存储与建连仍用完整 `host.host`。

## Alternatives considered
- 方案 A1-A2 持久化到 settings 命名空间(设计文档原意):受 api.settings 白名单 + 不改 src/ 双重限制 → 降级 localStorage(键 dsh-ssh.ui.*),记录备查。
- **设置侧栏项地球 icon(需求 3)不可纯附加实现**:设置面板侧栏图标由官方 shell `dsh-client-ui-settings-general` 的 `navIcon(id)` 按 id 硬编码(models/agent-presets/plugins 特判,其余回退齿轮 icon),`settings.section` 注册只投影 `{id,order,label}`、无 icon 挂钩,也无 nav-icon 槽位可覆写;导航文案「SSH 连接」本就正确。改为地球 icon 需改 core 的 navIcon → 违反「DSH core 零修改」红线,未实施(待用户裁决是否放宽/在 fork 实现)。

## Consequences
- 多主机一眼可辨身份,浏览中可随时切换主机重列目录;个性化标题不被强改写。bash 卡片与 read/write 卡片(透传远端绝对路径,本就不显示 base64)行为一致。
- 真机渲染依赖 GUI 重启后核验(user/主代理统一验证)。

## 出处
- archived/a-series-log.md A.15(显示名 basename)、A.23(原生下拉→Menu)、A.24(UI/UX 四批 + 方案 C)、A.29(主机标识 + base64 排查)、A.32(标题格式 主机名/目录)、附录 B(bash toolview)。
- design/ui-ux-spec.md §6;dsh-client-ui-tool/lib/client.js BashRow / tool.call.toolview 槽;dsh-client-ui-slots keyed slot;本仓库 src/placeholder.js、src/remote.js createPlaceholder、client.js。

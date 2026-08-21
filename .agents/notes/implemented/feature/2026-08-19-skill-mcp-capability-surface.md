# Agent Note: skill / MCP / 其它宿主工具在远端会话的能力面
Status: implemented

## Problem
- 方案⑤ 只把 7 个同名工具按会话 cwd 路由到远端;用户问 skill、MCP 在远端会话里引用本地还是远程,且缺统一的「哪些落远端、哪些落本地」能力面说明。

## Decision
- **⑤ 只遮蔽 7 个路由工具,skill 与 mcp__* 绝不被遮蔽、始终可见**;skill 目录发现/读取走宿主 ctx.fs(host 全局,未被⑤替换)→ 远端会话技能目录/SKILL.md/脚本文本一律本地读;MCP 服务器(stdio 本地子进程 / HTTP)在自己环境执行,与 cwd 路由完全解耦 → 远端会话 MCP 工具仍在本地 host(或 server 所在处)执行;其余宿主工具(todo/ask_user/web_search/subagent/goal/jobs)与 fs 无关,远端/本地一致。
- 远端会话会面临的不对称(缺口 1、2):skill scripts/ 若被远端 bash 执行会因本地路径不在远端而失败;MCP 工具操作的是本地/自身环境而非 SSH 远端工作区。
- **收口 = 方案 A(文档化)+ C(远端会话提示注入)**:
  - C(implemented):`agent/created` 钩子对远端 cwd 会话经 `agent.ctx.systemPrompt.section(...)` 注册 `dsh-ssh:capability-surface` 声明(order 150, 工具指引 100-199 区间;zh/en 双语文案,默认 zh),文案声明「本会话工作区在远程主机上执行(bash/read/write/edit/read_image/glob/grep 走 SSH);skill 脚本资源与 MCP 工具在本机执行」;`opts.capability===false` 可关;独立于工具遮蔽(minimal preset 无工具可遮蔽也注入)。
  - A(documented):README 加「能力面 / Capability Surface」小节(逐能力执行位置表 + 一句话结论),对标 VS Code extensionKind(声明式能力面)/ Claude Code Agent Skills(指令注入加本地执行)/ MCP 业界常态(不跟随远端)。
- **PTC(code-mode / run_code)形态(A.19)**:run_code 由 dsh-tools 提供,SDK 的 tools.xxx 与原生调用共享同一 scope 注册表 → 方案⑤对 code-mode 同样生效;但 run_code 程序本体在**本地 worker thread** 执行(containment 非安全边界,模型可 `import('node:fs')`/child_process 在本地执行,绕过工具层与 SSH——core 设计内边界,插件无法拦截);程序内 process.cwd() = 宿主 cwd 非远端。文档化该一致性缺口。

## Alternatives considered
- B(资源同步远端,让技能脚本远端可执行):超出⑤边界,需换 skill 实现 → 不做(只做 A+C)。

## Consequences
- C 注入仅对新建的远端会话 agent 生效(agent/created 触发);已在运行的旧会话不受影响。resolveHostLabel 读 settings 为尽力而为,失败回退 hostId。
- 声明正文为静态中英文案(header 无 locale 字段,默认 zh;如需严格跟随模型 locale 需 core 提供 header locale)。

## 出处
- archived/a-series-log.md A.19(PTC/code-mode 审计)、A.25(skill/MCP 行为调研)、A.26(方案 A+C 收口实施)。
- dsh-skill-filesystem/lib/index.js roots/readSkillText;dsh-tool-skill/lib/index.js;dsh-mcp-client/lib/index.js Stdio/HTTP transport;dsh-system-prompt/lib/index.js section 注册;dsh-tools createRunCodeTool;research/2026-08-20-remote-capability-competitors.md。

# Agent Note: 远端 bash 后台任务(远端化 run_in_background / jobs)
Status: implemented

## Problem
- 远端工作区里 `bash run_in_background:true` 需要真正在远端驻留,`job_output/job_list/job_kill` 可用;官方本地后台 = 本地 spawn 进程句柄,次远端无现成句柄抽象。早期经历三处真实缺陷:per 通道 close 误判完成、`readOutput` 返回 Promise 使 job_output 报「value is not lossless JSON」、远端 jobDir 从不 mkdir 导致启动静默秒死。

## Decision
- **接入宿主 `ctx.get('jobs').start` 通道**(方案1(b)):bash 远端分支(run_in_background)经 P0 sandbox fence 后走 `jobs.start({kind:'bash', label, owner:exec.agent?, run: createRemoteBashJobHooks})`,返回 `{kind:'background', jobId}`;官方 job_output/job_list/job_kill 零改动自动可见。
- **后台命令单命令异步 + cd 内嵌**(红线①):`setsid bash -c 'cd <cwd> && ( <cmd> ); ec=$?; printf "%s\n" "$ec" > <status>' ><log> 2>&1 </dev/null & echo $!`——链式(外包 cd 前缀)异步会把整个 AND-OR 链当异步作业挂起,必须 cd 内嵌。
- **kill 覆盖进程树**(红线②):setsid 起步使后台 bash 为独立 session/进程组组长(PID==pgid)→ `kill -TERM -- -<pid>` 杀整组 + `pkill -TERM -P <pid>` 补杀孙进程;`$!` 直接 kill 只杀 bash、漏杀子进程。
- **done 不依赖 exec 通道 close**:轮询 `kill -0` isAlive + status 文件收敛;进程 ALIVE + 无 status → 持续 sleep 轮询绝不提前 resolved(真实驻留)。**ec=null 且从未 alive 过 → status=failed** 而非 exit 0(启动静默失败 surfaced,不再假完成)。
- **readOutput 同步**:异步 SFTP 读日志会返回 Promise,`job.readOutput()` 不 await 直接当 text → job_output 非 lossless JSON。改为 refreshLog()(异步 SFTP 拉增量到本地缓冲) + `readOutput()` 同步切游标返回 string;`run()` 返回对象可枚举键 = 恰 `{cancel,done,readOutput}` 三键(不多不少,对齐官方契约),`_meta/_state/_spawned` 挂不可枚举属性。
- **job controller 补记**:web 组合下 base tool-jobs 被禁(全局层无 controller)+ Cordis Service 按 scope 分层实例化,agent scope 的 jobs 实例可能无 controller → `jobs.start` 报「no job controller serves this agent」。方案⑤钩子在远端 cwd 会话为 agent scope 补记 controller:连 `agent.ctx.get('jobs').attachController(name)`(与遮蔽 bash 同一 jobs 实例,servesOwner 沿 scope 链命中)。
- **jobDir 幂等 mkdir**:spawn 前先 `conn.exec('mkdir -p <jobDir>')`,`> <log>` 重定向不再因目录缺失打开失败(远端 /tmp/dsh-ssh-jobs-<hostId>)。

## Alternatives considered
- 持久 channel/tmux:在「远端零安装」约束下不可行;仅用 sshd exec + 系统进程工具 + 日志/status 文件轮询。

## Consequences
- job_output/job_list/job_kill 对远端任务自动可用(经宿主 jobs registry,与本地一致)。
- 前端 exec 超时路径 best-effort killForegroundTree;远端后台进程可脱离通道存活(输出重定向日志,由 readOutput 轮询取回)。
- `scripts/verify-remote-bg-created.mjs` 保留为可复跑真机脚本（真实 cordis 组合版 E2E，覆盖后台任务 running/增量输出/kill 进程组等核心验收）。

## 出处
- archived/a-series-log.md A.17(审计差距)、A.22(P1 接入)、A.28(job controller)、A.30(lossless JSON)、A.33(假完成复核)、A.35(jobDir mkdir)。
- dsh-tool-bash@lib/index.js L403-427(jobs.start 契约);dsh-jobs-local@lib/index.js:190(read 不 await readOutput)、:132(servesOwner)、:159-161(attachController);dsh-tool-jobs@lib/index.js L276-280/298-301/340-348;本仓库 src/remote-jobs.js、tools.js startRemoteBackground。

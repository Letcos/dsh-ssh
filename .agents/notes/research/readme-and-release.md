# README 写法 + npm 发布工作流(发布调研)

> 发布阶段前置调研, 供 README 编写与 .github/workflows/release.yml 设计直接采用。日期: 2025-08-16。外部事实均注明出处 URL; 给 dsh-ssh 的建议基于本项目硬约束(§2)与既有决策 D7(plain JS 无构建)。

## 1. README 结构设计要点

对照 dsh-market、dsh-agent-teams、create-dsh-plugin 等主流 DSH 插件(见 §2), README 结构主线可归纳为:
标题 → 语言切换 → 徽章 → 一句话 → 截图 → 架构/特性 → 安装 → 配置表 → 用法 → 限制 → 开发 → License。dsh-market 的 Speed/Security 分节、agent-teams 的居中 hero 与自定义生态徽章值得借鉴。

### 1.1 发布相关文件级要点

- **(通用模板) .github/workflows/publish.yml(403B; 全文如下, 仅把 multi-line 压成 flow 风格, 语义等价)**:
  ```yaml
  name: Publish to npm
  on:
    push: { tags: ['v*'] }
    workflow_dispatch:
  jobs:
    publish:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with: { node-version: 20, registry-url: 'https://registry.npmjs.org' }
        - run: npm publish --access public
          env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }
  ```
  要点: 触发=tag v* + 手动; **secret 名 NPM_TOKEN**(GitHub repo secrets 配置); 无构建步骤(plain JS); 无 pnpm、无版本校验、无 changelog、无 GitHub Release 创建; scoped 包用 `--access public` 旗标(包内无 publishConfig)。

> 注: 上述 publish.yml 是最简化模板; 本项目最终采用带测试门禁的 release.yml(见 packages/dsh-ssh/README.md)。

- **package.json 发布字段**(npm 生态惯例): name/version/type:"module"/main:"lib/index.js"/exports{".","./client","./cordis.patch.yml","./package.json"}/files["lib","cordis.patch.yml"]/license MIT; dsh.bundle.patch + dsh.client{platform:"web",inject}; peerDependencies 锁 @deepseek-ai/* 相关版本。**缺 repository/homepage/keywords/publishConfig 是常见短板, 不推荐照抄。**

## 2. 主流 DSH 插件 README 对照表

| 例子 | 结构主线 | 可借鉴点 |
|---|---|---|
| NanmiCoder/dsh-agent-teams(★333) | 右上语言切换→居中 hero SVG(100%宽)→居中徽章行(npm/license/**自定义静态徽章 "DeepSeek Harness plugin"**)→一句 slogan "One prompt. A working team."→特性表 "Why AgentTeams?"→NOTE 提示(需先装 DSH)→Install→Build from source | **居中视觉(hero 图+徽章居中)**; slogan 式一句话卖点; "Why" 能力表; 自定义生态徽章 https://img.shields.io/badge/DeepSeek%20Harness-plugin-202724 |
| dsh-market/dsh-market(★283) | 居中 logo→H1→语言切换→npm+stars 徽章→一句话→截图→Install→What you get→Speed→Security | "What you get" 分节; **Speed(真实数据: 安装秒级)与 Security 单独成节**——与 dsh-ssh 安全卖点同思路 |
| a4phone(npm) | 标题→引言→功能(加粗 bullet)→安装→使用(命令+编号步骤+blockquote 提示) | 中文社区惯例: 功能先于架构, 步骤式 Quick Start |
| create-dsh-plugin(npm) | 双语气标签→Usage 命令→Options 表→Templates 表→"Why" 小节→--verify→Development→Related | 表格驱动; 把踩坑写成 "Why it matters" 小节; 生态事实: @deepseek-ai/dsh-tools 的 latest tag 是陈旧 0.0.1-rc.1, 真版本在 **next** tag(见其 README) |
| MCP server-filesystem(相邻生态) | Features 列表→配置两种方法→How It Works 编号流程 | 配置方法分节、流程编号化的写法 |
| DeepSeek-Harness hub(官方) | 标题→语言→一句话→**"Developer preview / THERE WILL BE COMPATIBILITY-BREAKING CHANGES" 警告**→Run→Community→Contributing→Development→License | 官方强调: 给插件仓库加 **GitHub topic `dsh-plugin`** 提升可发现性; DSH 处于预览期有破坏性变更风险 |

生态事实: awesome-dsh-plugin(★2943, 457 个插件)按 ui/theme/session/memory/tools/skill/workflow/notify/model/dev/fun 分类; 其 README 有 **安全 WARNING callout**(插件代码以你的权限运行, 列表不构成安全审查); dsh-market 只允许安装 registry 内插件; registry 条目格式含 name/owner/category/description(en+zh)/npm(包名或 null)/install 命令。出处: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin 、https://github.com/dsh-market/dsh-market 。

## 3. 给 dsh-ssh 的 README 大纲建议

目标读者 = 有架构洁癖的 DSH 用户 → **"纯附加/零注入"卖点必须出现在前 15 行**, 并配架构图/代码级证据。

1. **H1 + 语言切换**(en / zh 双 README)。
2. **徽章行**: npm version(shields)、license、自定义徽章 `https://img.shields.io/badge/DeepSeek%20Harness-plugin-202724`(agent-teams 同款)、stars(可选)。
3. **slogan + 卖点 blockquote**: 如 "> 把另一台机器的目录变成 DSH 工作区——bash/文件/glob/grep 全部在远端执行, 远端零安装。" 紧跟一行: "**100% 纯附加: 不修改、不注入 DSH core, 全部走官方公共契约(agent/created 路由遮蔽 + bundle patch + settings 槽 + Typert), `dsh plugin remove` 卸载即逐字节复原。**"
4. **截图区**(设置页主机配置 + 工作区切换/远端执行效果; 提交到 docs/, width 720; 真机验证通过后补, 预留位置)。
5. **架构/契约小节**(推荐单独 "How it works"): 本地路径→宿主 ctx.shell/ctx.fs 原样; 远端路径→SSH(exec+SFTP); 列出用到的官方契约清单(agent/created 路由遮蔽、dsh.bundle patch、settings 命名空间、directoryFlow 槽、Typert RemoteService)。措辞强调"卸载即复原、升级自适应(core 零改动)"。
6. **Features**(加粗 bullet): 多主机配置、一键切换运行机器、六工具远端执行、known_hosts 校验、连接池复用、远端零安装。
7. **真实数据区(预留表格)**: 命令 RTT(本地 vs 远端实测)、SFTP 传输吞吐、连接复用收益、六工具行为对齐清单。参考 dsh-market 的 Speed 节把数据单独成节。
8. **Install**: 前置条件(远端 sshd + 公钥认证/SFTP 开启)→ `dsh plugin --profile web add <包名>` → 手动安装备选。加 NOTE callout(需先装 DSH)。
9. **Quick Start**(4 步编号): 设置页配主机 → 新建工作区选远端目录 → 切换运行机器 → 跑工具(参考 a4phone 步骤式)。
10. **Config**(字段表: host/port/user/认证方式/known_hosts/超时/重连)。
11. **Security**(known_hosts 校验、私钥走 settings secret 槽、远端零安装=攻击面最小化)——dsh-ssh 的安全卖点单独成节。
12. **Known Limitations**(~/.ssh/config、后台任务远端化、SFTP 禁用降级——如实写)。
13. **Development**(pnpm install、测试命令、live smoke 命令)。
14. **License**(MIT)。

## 4. 给 dsh-ssh 的 .github/workflows/release.yml 设计要点

- **触发**: `push: tags: ['v*']` + `workflow_dispatch`(主流 DSH 插件一致)。
- **版本号来源**: package.json 手工 bump; 加 **tag == package.json version 校验 step**(dsh-market 有现成写法: `PKG=$(node -p "require('./package.json').version"); TAG=${GITHUB_REF_NAME#v}; [ "$PKG" = "$TAG" ]`), 防止 tag 与包版本错位。
- **Step 序列**(建议): checkout@v4 → setup-node@v4(node 20 或 22 + registry-url npmjs)→ pnpm/action-setup@v4(如需)→ pnpm install --frozen-lockfile → 测试/`node --check packages/**/*.js`(dsh-ssh 无构建, 决策 D7; 若引 tsdown 则加 build)→ tag-version 校验 → publish → 可选 `gh release create --generate-notes`(dsh-market 示例)。
- **npm token 两选一**: ① 传统 `secrets.NPM_TOKEN`(GitHub repo → Settings → Secrets, 与 publish.yml 引用名一致); ② **npm trusted publishing(OIDC)**: workflow `permissions: { contents: write, id-token: write }` + `npm install -g npm@latest`(trusted publishing 需 npm ≥ 11.5), publish 时无需任何 secret(参考 dsh-market release.yml)——推荐 dsh-ssh 用 OIDC, 若组织不允再退 NPM_TOKEN。
- **scope 包注意**: 包名带 @ 前缀必须 `npm publish --access public`, 或在 package.json 里 `publishConfig: {access: "public"}`(后者更稳, 参考 @sugarforever/dsh-mcp-apps; 注意 publishConfig 会在 install 时被 npm 读取, 有 proxy 风险, 二选一即可)。
- **预发布校验**: 发布前 `pnpm pack --dry-run`(或 npm pack --dry-run)核对 tarball 内容: lib/** + cordis.patch.yml 必须在; 若 preset 随包分发还要含 preset 文件。

## 5. 开放问题(发布阶段定)

1. **preset-standard-ssh 归属**: 方案⑤后 preset 已移除(见 implemented/simplification/2026-08-20-remove-standard-ssh-preset.md), 本条作废留档。
2. **changelog 自动化**: dsh-market 用 `gh release create --generate-notes`。建议先手工(commit 约定), 量大再上 changesets/release-please。
3. **dist-tag 策略**: 生态事实——@deepseek-ai/* 的 latest 可能陈旧(create-dsh-plugin 证实 dsh-tools latest=0.0.1-rc.1 是坏的, 真版本在 next); 发布时确认默认 latest 指向正确版本, peer 范围用 ^0.1.0-rc.6 类区间并在 README 注明。
4. **上 awesome-dsh-plugin / dsh-market**: 需要 PR 提交, 条目要 en+zh 描述; 其 README 有安全免责惯例, 我们的 Security 节正好呼应; 同时给 GitHub 仓库加 topic `dsh-plugin`(官方建议)。
5. **包名**: 建议 `dsh-ssh`(无 scope, 免 access 问题)或 scoped 形式; 与 npm 上已有 dsh* 通用包名区分, 发布前查重。(已定案 @dsh-ssh/dsh-ssh, 见 implemented/process/2026-08-20-project-rename-dsh-ssh.md)
6. **双语言 README 维护成本**: 参考主流插件双文件镜像; 是否同步或 en 为主(awesome 条目要求双描述)。

## 6. 参考资料

- dsh-market: https://github.com/dsh-market/dsh-market (README / release.yml / package.json / data/registry-snapshot.json)
- dsh-agent-teams: https://github.com/NanmiCoder/dsh-agent-teams (README; 其 docs/developing-dsh-plugins.md 有 package.json 要素清单)
- awesome-dsh-plugin: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin (分类/徽章/安全 WARNING)
- 官方发布文档: https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish (bundle/profile manifest); 分发三途径对比(镜像: https://www.runoob.com/deepseek-harness/deepseek-harness-publish.html): **npm 与 tarball 免构建授权; git 安装拉源码需 prepare 自包含脚本 + 用户 allowBuilds 授权(pnpm≥10), 建议锁 commit** → dsh-ssh 面向普通用户应主走 npm
- create-dsh-plugin: https://www.npmjs.com/package/create-dsh-plugin ; @sugarforever/dsh-mcp-apps: https://www.npmjs.com/package/@sugarforever/dsh-mcp-apps (publishConfig.access 范例)
- 官方 hub: https://github.com/deepseek-ai/deepseek-harness (topic dsh-plugin; 预览期破坏性变更警告)

## 后续进展(主编代理, 2026-08-16)

- 包名定案: @aaravarr/dsh-ssh(npm 上无冲突的 dsh-ssh 已被占用; 全库 38 文件完成改名, 145→148/148 测试)。(注: 后改名至 @dsh-ssh/dsh-ssh, 见 implemented/process/2026-08-20-project-rename-dsh-ssh.md)
- YAML 陷阱: id 值以 @ 起始时必须加引号(YAML 保留字符), cordis.patch.yml 已加引号。
- publish.yml 已落地(tag v* + 版本校验 + NPM_TOKEN); 本地 npm 未登录, 发布需在 GitHub 仓库配置 NPM_TOKEN secret 后推 tag。
- 实测数据已回填 README(性能/41 用例/兼容矩阵); 兼容矩阵详见 .agents/notes/research/compat-matrix.md。
- 推送: 仓库已推至 github.com/aaravarr/ddsh(main); 偶发 github 网络瞬断时重试即可。

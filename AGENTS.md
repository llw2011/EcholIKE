# EcholIKE Agent 入口规范

本文件适用于整个仓库。任何 agent 开始工作、接手任务或上下文压缩后继续工作时，都必须先执行以下动作：

1. 运行 `git status --short`，识别并保留用户或其他 agent 的改动。
2. 完整阅读 [项目权威规范书](docs/project-guidelines.md) 与 [工程红线卡](docs/red-line-card.md)。
3. 阅读 [WORKLOG.md](WORKLOG.md) 顶部的最新条目，再继续当前任务。
4. 涉及源码定位或源码改动前，阅读 [源码树与改动落点](docs/source-tree.md)，先确认实现所有者、组合根与兼容入口。

## 源码落点门禁

- `src/App.tsx`、`src-tauri/src/lib.rs`、`server/src/app.ts`、`server/src/db/client.ts`、`server/src/routes/admin.ts` 等薄入口只负责分流、装配、注册或兼容导出；不得因为旧路径熟悉就把领域实现重新塞回这些文件。
- 先修改唯一实现所有者，再按需同步 composition root、兼容 facade、跨层契约和同领域测试。禁止在入口文件、barrel 或 `utils/common` 中复制第二套实现。
- 当前源码与 [源码树与改动落点](docs/source-tree.md) 不一致时，以源码为事实源，并在同一任务中修正文档和 `WORKLOG.md`，不得沿用已闭环拆解计划里的旧落点。

## 改动与工作日志

- 任何源码、配置、脚本、文档、资源、部署状态或发布状态的改动/新增，都必须在同一任务内更新根目录 `WORKLOG.md`。
- `WORKLOG.md` 必须倒序维护：最新条目插入固定说明之后、旧条目之前，禁止把新条目追加到文件末尾。
- 日志采用“时间 + 简短标题 + 2～4 个按需小节”的紧凑写法。普通任务默认只写“改动”“验证与边界”两节；复杂排障、部署或 OTA 才增加“根因与修复”“发布”“残余风险”等小节，避免重复需求和机械罗列。
- worklog 是交付物的一部分；完成改动后未更新 worklog，任务不算完成。

## OTA 工作树门禁

- OTA 构建/发布前必须执行 `git status --short`。本任务所属改动（含版本号和 worklog）必须先本地提交，默认目标是全仓 clean。
- 若仅剩用户或其他 agent 的改动，不得擅自提交、回滚、stash、移动或隐藏；这是允许继续 OTA 的唯一 dirty-worktree 例外。
- 不能仅因这些外来改动中断 OTA。可按当前工作树继续打包，但必须在 worklog 逐项记录路径、已知归属、是否进入产物及风险/验证结果。
- OTA 授权仅隐含允许为满足 clean 门禁而提交本任务自己的改动，不授权 `git push` 或任何远端 Git 写入。

其他技术、测试、部署和发布约定以项目权威规范书为准。

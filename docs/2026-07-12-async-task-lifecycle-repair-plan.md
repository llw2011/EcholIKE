# EcholIKE 异步任务生命周期统一修复计划

日期：2026-07-12
状态：已完成；`0.1.69` public online NSIS OTA 已发布并验证
基线：`9c2a20d fix: make admin scenes editable`

当前源码落点已随巨石拆解调整；维护这些链路前先读 [源码树与改动落点](source-tree.md)。本计划保留问题模型、lease 原则和验收门禁，日期化 Phase 记录不作为当前文件索引。

## 1. 问题与根因

`src/App.tsx` 只做三类窗口分流；主窗口由 `src/windows/MainWindowApp.tsx` 按路由条件渲染 `HomePage` 或 `Settings`。从首页切到设置页时，原页面组件会被卸载，而它发起的 Tauri/HTTP Promise 仍会继续执行。

当前多个功能把 busy、结果、错误和防重复 `useRef` 放在页面局部状态中，因此会出现同一模式：

1. 用户启动异步任务，局部按钮进入忙状态。
2. 用户切换页面，组件卸载。
3. 返回页面后创建了全新的组件实例，busy 恢复初始值，按钮重新可点。
4. 旧任务继续消耗本机或后台服务；全局 toast 仍可显示。
5. 旧 Promise 对已卸载组件执行的结果回填被丢弃，页面没有结果。
6. 用户再次点击后产生重复请求、重复额度消耗、重复播放、重复导出，甚至重复 OTA 安装事务。

现有 TTS 主流程已经给出正确范式：`appStore` 保存共享 busy 和唯一 `leaseId`，原子抢占任务，只有匹配 lease 的任务才能完成和解锁，并有卸载/重新挂载回归测试。

## 2. 已确认影响范围

| 优先级 | 链路                                 | 当前局部状态                                          | 主要后果                                           |
| ------ | ------------------------------------ | ----------------------------------------------------- | -------------------------------------------------- |
| P0     | 系统截图 OCR、附件/PDF OCR           | `ocrBusy`、`ocrResult`、`ocrDialog`、`pdfExportFile`  | 重复识别、结果丢失、重复额度消耗                   |
| P0     | AI 工作台提问                        | `askBusy`、`pendingQuestion`、`answer`                | 重复 LLM 请求、回答丢失、重复额度消耗              |
| P0     | OTA 检查、下载与安装                 | `busy`、`updateProgress`、局部 `updateActionInFlight` | 返回页面后可再次启动 updater 事务                  |
| P0     | 设置页 TTS 试听                      | 局部 `busy`，且 `audio.play()` 后立即解锁             | 切页或播放期间可重复请求并叠加播放                 |
| P0     | TTS/PDF/组合诊断                     | `busy`、诊断文件、诊断结果                            | 重复诊断、结果丢失                                 |
| P1     | 后台登录、配置同步、刷新额度         | 局部 `busy` 与局部 in-flight ref                      | 重复登录/同步，新页面状态不同步                    |
| P1     | STT/LLM/OCR 测试、读取模型、系统代理 | 局部 `busy` 与局部结果                                | 重复调用、结果或提示丢失；不同按钮之间也不是真互斥 |
| P1     | 内嵌 Markdown AI 润色/翻译/总结      | `aiBusyAction`、`aiResult`、`aiError`                 | 关闭编辑器或切页后结果丢失                         |
| P2     | PDF 图片、Word、Markdown 保存/导出   | 页面局部 busy                                         | 重复生成或重复保存文件                             |
| P2     | 录音开始/停止/取消的过渡锁           | `recordBusy`                                          | 在全局 pipeline 状态更新前存在短暂重复命令窗口     |
| P2     | 独立 Markdown 窗口保存、导出、朗读   | 独立 WebView 局部 busy                                | 关闭重开或跨窗口操作时可能并发                     |

当前明确安全的链路：

- 主界面结果、回答和内嵌 Markdown 朗读使用 `ttsPlaybackBusy + leaseId`。
- onboarding、模式切换和启动更新状态位于不会随 Home/Settings 切换卸载的 `MainWindowApp` 及 `useMainStartup` / `useMainUsageMode` 生命周期。
- 设置页内部 tab 切换不会卸载 `Settings`；问题发生在 Home/Settings 路由切换或组件被重新挂载时。

## 3. 设计原则

1. **任务状态归任务域所有**：会跨页面存活的任务不得把 busy/result/error 只放在页面组件。
2. **原子抢占**：每个任务域提供 `tryStart...()`，忙时直接拒绝第二次调用。
3. **唯一 lease**：每次启动生成单调递增 ID；只有匹配 ID 的进度、结果、错误和 finally 才能写回。
4. **状态与结果一起存活**：仅提升 busy 不够；OCR、问答和诊断结果也必须能在重新挂载后恢复。
5. **不盲目超时解锁**：后台仍在执行时不能只因前端计时到期恢复按钮。若需要超时，必须同时取消底层请求或确认任务已终止。
6. **进程重启归零**：任务状态只保存在内存，不把 `running` 持久化到磁盘；应用退出后原任务已不存在。
7. **按领域建模**：复用 lease 规则，但不建立一个塞入任意 JSON 的大型通用任务仓库。
8. **不阻止导航**：允许用户切页；返回时应看到真实进度或最终结果。

## 4. 目标状态模型

共享状态使用具体领域切片，字段名称可在实现时微调：

```ts
type OperationStatus = 'idle' | 'running' | 'success' | 'error'

interface OperationLease {
  status: OperationStatus
  leaseId: number | null
  startedAt: string | null
  error: string | null
}
```

### 4.1 OCR task

- `kind`: `screen-selection | screen-window | upload`
- `sourceName`: 当前截图或附件名称
- `result`: `OcrReadResult | null`
- `pdfExportFile`: 仅 PDF 成功后保留，供页面导出图片
- `dialogState`: 重新进入首页时可恢复处理中、成功或失败界面
- 截图与上传共用一个 OCR lease，互相排斥。
- PDF base64 只驻留内存；开始新任务或用户明确清理结果后释放，禁止写入持久化 store。

### 4.2 Ask task

- 保存 question、context snapshot、answer 和可读错误。
- 重新进入首页时恢复“思考中”或最终回答。
- OCR/窗口上下文在任务开始时冻结，避免页面后来变化影响旧任务。

### 4.3 Settings operation

- 统一串行化 STT/LLM/OCR 测试、读取模型、系统代理、后台登录、配置/额度同步和诊断。
- 所有相关按钮在任意 settings operation 运行时统一禁用，修复当前“只禁用自己”的伪互斥。
- 结果仍按领域保存：连接测试、模型列表、认证/同步结果、诊断结果分别使用明确字段；不把所有结果塞进单一字符串。
- panel alert 可从最新 operation outcome 恢复，不依赖已卸载组件的定时器。

### 4.4 OTA task

- 与普通 settings operation 分离，保存检查结果、下载进度、目标版本和唯一 lease。
- updater 事务运行时，返回设置页仍显示真实进度并禁用再次安装。
- `pendingUpdate` localStorage 只用于应用重启后的版本状态，不再被当作运行中互斥锁。
- 任一时刻只允许一个 `downloadAndInstallOtaUpdate()`。

### 4.5 Editor AI / file operation

- 内嵌编辑器 AI task 绑定 draft ID 和请求范围；关闭再打开同一草稿时恢复进度/结果。
- 保存/导出只需共享 lease 和最终 toast，不长期保存大二进制结果。
- 录音命令增加全局 transition lease；`pipelineState` 继续作为真实录音状态来源。

### 4.6 独立 WebView 边界

Zustand 只在单个 WebView 内共享，不能保护主窗口与独立 Markdown 窗口之间的并发。跨窗口 TTS/导出如需全局互斥，应使用 Tauri 进程级状态或可靠的原子 IPC；不能误用两个窗口各自的 store 声称已修复。

## 5. 分阶段实施

### Phase 1：基础 lease 与 P0 首页任务

- 在 `src/stores/appStore.ts` 增加 OCR、Ask 的具体 task slice 和匹配 lease 更新动作。
- 从 `Workbench.tsx` 删除对应局部 busy/result 链路，UI 全部从共享 task 派生。
- 处理截图、上传、成功、失败、切页中、切页后完成五种恢复场景。
- 保持现有 OCR Markdown 清洗、PDF 导出和错误归一化行为不变。

### Phase 2：设置页与 OTA

- 将 settings operation、诊断结果和 OTA task 移出 `ControlPanel` 局部 state/ref。
- 设置页所有异步按钮使用同一原子互斥入口，不再仅按自己的 busy 值禁用。
- TTS 试听复用完整播放队列和 TTS lease，直到音频结束/失败才释放。
- OTA 进度回调写入共享 task；切页后不允许第二个 updater 事务。
- 登录/同步完成后，新挂载页面从共享 token/bootstrap 状态读取，不保留失效的局部 token 快照。

### Phase 3：Markdown、导出与录音过渡

- 将内嵌 Markdown AI task 绑定草稿并跨关闭/重开恢复。
- 给首页保存、PDF/Word 导出增加共享 operation lease。
- 给录音 start/stop/abort 增加 transition lease，同时保留 Rust/pipeline 的状态校验。
- 明确编辑器 backdrop 在任务中是允许关闭并恢复，还是显示确认；不得静默丢弃结果。

### Phase 4：跨 WebView 并发

- 验证独立 Markdown 窗口与主窗口同时朗读、保存、导出的实际行为。
- 若产品要求跨窗口互斥，在 Tauri 端实现最小进程级 lease，并补 Rust 单测与前端 bridge 测试。
- 若某类文件保存允许跨窗口并行，在文档和 UI 中明确，不人为加全局锁。

## 6. 测试门禁

每个迁移链路必须先补失败测试，再完成实现。核心测试模板：

1. 启动任务并保持 Promise 未完成。
2. 连续点击两次，底层函数只调用一次。
3. 卸载组件并重新挂载。
4. 新页面按钮仍禁用，且显示原任务进度。
5. 再次点击不会发出第二个调用。
6. 在页面已卸载和重新挂载两种时机完成 Promise。
7. 成功结果或可读错误在新页面可见。
8. 旧 lease 的迟到结果不能覆盖新任务，也不能提前解锁。

重点测试文件：

- `src/stores/__tests__/appStore*.test.ts` 与 `appStoreTestHarness.ts`
- `src/components/HomePage/__tests__/Workbench.<domain>.test.tsx` 与 `workbenchTestHarness.tsx`
- `src/components/Settings/__tests__/ControlPanel.<domain>.test.tsx` 与 `controlPanelTestHarness.tsx`
- `src/components/MarkdownEditor/__tests__/MarkdownEditorShell.test.tsx`
- `src/lib/__tests__/tauri.test.ts`
- 若修改 Tauri 进程锁：对应 Rust 单测

阶段完成后至少运行：

```powershell
npm.cmd test -- <相关测试文件>
npm.cmd run build
npm.cmd run lint
npm.cmd run format:check
git diff --check
```

## 7. 验收标准

- OCR、Ask、设置操作、诊断、OTA 在页面切换后保持真实忙状态。
- 任务运行时重复点击不会产生第二个底层调用。
- 任务在其他页面完成后，返回原页面能看到结果或错误，而不只有 toast。
- 截图 OCR 与上传 OCR 相互排斥；所有设置异步操作是真正互斥。
- TTS 试听在音频真正结束前保持占用，不发生重叠播放。
- OTA 任一时刻只有一个 updater 事务，切页不会重置进度或出现再次下载入口。
- 匹配 lease 才能写回和解锁，迟到任务不能污染新状态。
- 应用正常重启后没有虚假的 running 状态。
- 不新增后台轮询，不改变后端 API、额度协议、Provider 配置或 OTA 发布协议。
- 新增测试覆盖组件卸载/重新挂载，不再只覆盖单次挂载内的按钮变化。

## 8. 明确不采用的方案

- 不通过同时常驻 Home 和 Settings 来保住局部 state。
- 不通过禁用导航阻止用户切页。
- 不给每个按钮各加一个独立布尔补丁。
- 不用固定几秒后强制恢复按钮。
- 不依赖 toast 代替页面结果。
- 不把 PDF base64、音频或凭据持久化到 localStorage。

## 9. 实施边界

- 运行时代码与最终需求审计已完成，源码版本为 `0.1.69`；public online NSIS OTA 已按固定协议发布并通过完整验证。
- 实施时尊重共享工作区；先检查 `git status`，不提交或回滚其他 agent 的改动。
- 每个阶段更新根目录 `WORKLOG.md`；发布 OTA 前执行仓库 clean 门禁及完整发布验证。

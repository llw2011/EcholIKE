# EcholIKE 巨石源码分阶段拆解计划

日期：2026-08-27
状态：已完成（闭环）
审计基线：`3b4e036 fix(auth): restore saved sessions after OTA`

## 1. 目标

本计划治理前端、Tauri/Rust 与 Server 中已经形成多修改原因、多生命周期或多事务边界的巨石文件。目标不是追求任意行数上限，而是让一个改动只触及它所属的领域，并让现有并发、安全和持久化不变量继续可验证。

优先级按以下因素综合排序：

```text
职责数量 × 修改频率 × 生命周期/安全耦合 × 回归爆炸半径
```

## 2. 硬性原则

1. **迁移提交与行为提交分离**：拆文件时只移动代码；功能、文案、状态模型、错误语义和性能调整另开任务。
2. **事务边界不可拆碎**：认证 generation/authority CAS、Quota reserve/commit/release、录音 generation/abort/finalize、OCR worker 退出确认等必须保持在同一认知单元。
3. **一个阶段只迁一个生命周期所有者**：不得同时拆两个互相依赖的异步状态机。
4. **保持兼容入口**：IPC command 名称与参数、Server route spec、公开 TypeScript/Rust 导出和依赖注入对象 shape 默认不变；需要改入口时必须先有契约测试。
5. **不制造共享杂物箱**：领域 DTO、校验和错误映射跟随领域；只有真正被多个领域稳定复用的 primitive 才进入 shared/common。
6. **不以微组件冒充解耦**：抽 JSX、小函数或 barrel 只有在减少变化耦合时才计入阶段成果。
7. **统一 Store 先抽纯边界**：`useAppStore` 继续作为跨 Home/Settings 卸载恢复与 lease fencing 的单一根；先抽 types 与纯 transition，再按原子性审计决定组合方式，不直接拆成多个互相订阅的 Zustand store，也不为形式统一强制外置 slice factory。
8. **每刀可独立回滚**：单次迁移应有清晰 diff、最窄回归矩阵和独立 Worklog 记录，不依赖后续阶段才能通过构建。

## 3. 已确认的治理对象

### P0：立即治理

| 文件 | 主要问题 | 目标边界 |
| --- | --- | --- |
| `src-tauri/src/commands/ocr.rs` | OCR、截图、PDF、DOCX、direct provider、代理协议、文件命令和 IPC 混装 | `docx`、`payload`、`text`、`capture`、`pdf_render`、`direct`、`proxy`、`file_commands` 与薄 `mod.rs` |
| `src/components/HomePage/Workbench.tsx` | OCR、Ask、录音、Markdown、历史、导出、TTS 共用一个 React 生命周期 | 纯 OCR domain、OCR/Ask/Speech hooks、Markdown workspace、受控展示组件 |
| `src/components/Settings/ControlPanel.tsx` | 认证、配置持久化、连接测试、诊断、OTA、代理和全部设置 UI 混合 | persistence、backend account、diagnostics、OTA hooks 与受控 tabs |
| `server/src/db/client.ts` | Billing、Quota、Scene、Audit、Desktop Config、Admin 六个持久化领域混装 | `db/postgres/*-store.ts`，原入口保留组合与兼容导出 |

### P1：P0 稳定后治理

| 文件 | 主要问题 | 目标边界 |
| --- | --- | --- |
| `server/src/routes/admin.ts` | 多领域 handler、字段解析、权限和错误翻译混合 | 按 users/quota/providers/ota/scenes/system 纵切 |
| `server/src/routes/admin-panel.ts` | HTML、CSS、浏览器脚本与请求状态机单文件内嵌 | 纯字符串 page/styles/scripts/response 模块，先保持逐字节等价 |
| `src/App.tsx` | 三类窗口入口与 Markdown runtime、主启动、认证、模式切换混合 | window apps、main startup、usage mode transition；根文件只保留分流 |
| `src-tauri/src/storage/mod.rs` | 配置、Desktop Auth、History、Dictionary 混装 | atomic file、config、desktop auth、history、dictionary |

### P2：最终评估结果

| 文件 | 判断 |
| --- | --- |
| `src-tauri/src/pipeline.rs` | 已抽 proxy protocol、错误、cloud policy 与 output/history 四个外围模块；start/stop/abort/finalize、generation、capture/STT owner 和三个异步 transport 保持在根，终审确认应在此停止。 |
| `src/stores/appStore.ts` | 已抽 types 与六个纯 transition 域，保持唯一 Store、根层 lease/clock/`get/set`/Auth 和单次原子 composition；终审否决外置 slice factory。 |
| `src-tauri/src/lib.rs` | 已完成 Markdown window、onboarding、hotkey、tray、window runtime 与 managed state 六刀；根保留唯一 `run()`、完整 command registry 和可审计 setup 顺序。 |

## 4. 暂不按行数拆分的文件

- `src-tauri/src/commands/ocr_runtime.rs`：受控子进程、环境隔离、取消、清理和可信 artifact 构成同一安全边界。
- `server/src/services/ocr/document-ocr-service.ts`：PDF 验证、计页、门禁、Pipeline、退出确认和清理构成同一事务。
- `server/src/services/quota/quota-service.ts`：operation identity、reserve、commit/release 与 replay 是同一状态机。
- `src-tauri/src/process_ownership.rs`：长度被内嵌测试放大，且多个 owner 共享同一 lease/窗口销毁语义。
- `src/components/MarkdownEditor/MarkdownEditorShell.tsx`：围绕单一编辑器会话，当前收益低于 P0。

## 5. 分阶段实施

### Phase 1：拆解 Rust OCR command 巨石

按低风险到高耦合顺序执行：

- [x] `commands/ocr/docx.rs`：Markdown 解析、WordprocessingML、ZIP 构建。
- [x] `commands/ocr/text.rs`：OCR 文本清理、重复块折叠、响应文本抽取。
- [x] `commands/ocr/payload.rs`：base64、magic/MIME、25 MiB 与 PDF 校验。
- [x] `commands/ocr/capture.rs` 与 `pdf_render.rs`：截图、PDF 栅格化、20/21 页门禁和图片导出。
- [x] `commands/ocr/proxy.rs`：图片/PDF 代理协议、结构化错误与结果聚合。
- [x] `commands/ocr/file_commands.rs`：文件对话框、保存和 `ProcessOwners` 适配。
- [x] `commands/ocr/direct.rs` 与 `mod.rs`：direct Ollama/GLM provider 实现独立成域，根模块只保留公开 DTO、IPC command、共享小型 primitive 和薄编排。

Phase 1 七刀已全部完成：DOCX、文本处理、上传 payload、截图/PDF 渲染、代理协议、文件命令与 direct provider 各自拥有明确模块；公开 IPC command 外壳统一留在 `commands/ocr/mod.rs`，每刀只迁移成套私有领域逻辑与对应测试。闭环复核进一步把 payload/PDF 共同消费的 `strip_data_url_prefix` 提升为根内唯一小型 primitive，消除了两个 sibling 之间的双向依赖，没有复制实现或改变调用行为。

### Phase 2：拆解 Workbench 生命周期

- [x] 抽出 `ocrDomain.ts` 的常量和纯函数，并建立输入输出 characterization tests。
- [x] 抽 `useWorkbenchOcr`，完整保留 Store lease、ACK pending、迟到结果抑制和卸载恢复。
- [x] 抽 `useWorkbenchAsk` 与 `useWorkbenchSpeech`，不改变共享任务所有权。
- [x] 抽 `useMarkdownWorkspace`，将窗口、草稿、冲突、文件命令和 AI 编辑作为一个生命周期迁移。
- [x] 移动现有 dialog/panel 展示组件，禁止进一步碎成无领域意义的微组件。
- [x] 同步把 `Workbench.test.tsx` 按 OCR、Ask、Markdown、History、Speech 分文件，保留所有竞态用例。

Phase 2 六刀已全部完成：纯 OCR 领域逻辑、OCR/Ask/Speech/Markdown 生命周期与领域展示组件均有唯一所有者；原 Workbench 只保留跨域 composition，测试按核心编排、OCR、Ask、Markdown、History、Speech/TTS 归档并共用一个无测试体的 harness。

### Phase 3：拆解 Server 持久化与 Admin

- [x] 从 `db/client.ts` 先搬 Billing、Scene、Audit store。
- [x] 整块搬 Quota ledger，SQL、锁顺序、事务范围、加密 AAD 与错误类型原样保留。
- [x] 搬出 Desktop/provider/OTA store；原 `createPostgresClient` 继续返回同一 `DatabaseClient`。
- [x] 搬出 Admin store，并保留与 control-audit、Quota、Scene 的既有事务接线。
- [x] `routes/admin.ts` 按 capability/domain 纵切，每个领域保留自己的 DTO parser 与错误翻译。
- [x] `admin-panel.ts` 只做纯字符串模块提取，不在该阶段引入 bundler、React 或模板框架。

Phase 3 的 PostgreSQL 持久化子阶段已完成：原 3,202 行 `db/client.ts` 收敛为 39 行连接/facade，Billing、Scene、Audit、Quota、Desktop/provider/OTA 与 Admin store 均拥有独立领域模块；共享 control-audit 与 row-values 只有稳定的跨域 primitive，没有形成新的反向依赖或杂物箱。

Admin routes 纵切已完成：跨域通用 JSON/字段 primitive 位于 `routes/admin/http-fields.ts`，角色门禁与共享 mutation 错误映射位于 `routes/admin/control.ts`；Scenes、System、Providers、OTA、Quota 与 Users 各自拥有 handler、DTO parser 和专属错误翻译，根 `admin.ts` 已收敛为 22 行兼容 re-export。

Admin Panel 十六刀与 Phase 3 总终审均已 APPROVE：77 行根模块只拥有 nonce/CSP/response、bootstrap config、favicon 和两个公开 handler；Dashboard HTML shell 为 370 行，浏览器脚本 composition 为 64 行，Core、共享交互、领域函数和七个 bindings 均有稳定片段边界。固定输入下 Login/Dashboard 响应与基线逐字节一致，模块图无循环；整个迁移未改变最终脚本字节、声明顺序或启动时序，也未引入 bundler、React 或模板框架。Phase 3 正式闭环。

### Phase 4：拆解 Settings、App 与 Store 内部结构

1. `ControlPanel` 先抽 proxy/version/cache 等纯函数和配置持久化协调器。
2. 认证、诊断与 OTA 分别以完整 hook/state machine 迁移；不拆散认证 CAS 或启动重试顺序。
3. `App.tsx` 搬出 Markdown/Capsule window app，再迁移 main startup 与 usage mode transition。
4. `appStore.ts` 抽 types、初始状态与 reducer-like transition；组合方式以 lease/fence 原子性审计为准，最终保持同一 `useAppStore` 与根层单次提交。
5. 同步按领域拆 `ControlPanel.test.tsx` 与 Store tests。

Phase 4 的 Settings 子阶段已完成并闭环：ControlPanel 的代理 URL、version/cache、配置持久化、后台账号、STT/LLM/OCR connection-test、TTS/PDF owner 诊断、OTA 与 UI primitives 均有稳定边界；Input、Speech、AI、System、About、Diagnostics 六个 tab 都是只消费 view facts/actions 的受控 panel。四个主要 panel 不读取 Store、不调用 Tauri、不持有 effect/lease，配置持久化、认证、模型加载、TTS preview 与系统命令继续由根或既有 hook 唯一拥有。`ControlPanel.test.tsx` 已按 core、account、services、diagnostics、persistence、OTA 六域拆分并共用唯一无测试体 harness；模块图无循环或双实现。

App 子阶段五刀已完成：完整 Markdown runtime 位于 `windows/MarkdownEditorWindowApp.tsx`；Capsule 的 Tauri event/theme/config 启动入口位于 `windows/CapsuleWindowApp.tsx`；主窗口 composition 位于 `windows/MainWindowApp.tsx`，其配置/history/dictionary/runtime version 加载、认证同步、启动 OTA、macOS 权限检查与更新安装统一由 `windows/useMainStartup.ts` 拥有，onboarding guard、模式持久化、Home 模式切换、网络重验及所有 lease/fence 统一由 `windows/useMainUsageMode.ts` 拥有。原始 1,391 行 `App.tsx` 已收敛为 21 行窗口判别根，只保留跨窗口认证同步、dataset 与三路分流；App 子阶段闭环。

Store 子阶段第一刀已完成类型边界：37 个既有公共领域类型与内部 `AppState` 迁入 `stores/appStore.types.ts`，原 `appStore.ts` 显式兼容 re-export 原公共集合但不新增导出 `AppState`；全部 consumer 继续从原路径导入。单一 `useAppStore`、6 个运行时导出、lease source、默认状态、helper 与 factory 均留在原文件；后续领域治理只抽纯 transition，不迁移根层运行时所有权。

Store 子阶段第二刀已完成 History 纯状态边界：四项初始状态与 refresh/start/finish/fail/clear transition 迁入 `stores/appStore.history.ts`，可见历史过滤和 idle mutation 构造保持模块私有；根 Store 继续唯一拥有 lease source、时钟、`get/set`、stale fence、boolean 返回和单次原子提交。`appStore.ts` 从 1,107 行降至 1,051 行，没有新增 Store 实例、公开 facade 导出或反向依赖；后续继续只选择能保持事务原子性的纯领域边界。

Store 子阶段第三刀已完成 Recording 纯 transition 边界：pipeline/音量边界、录音 transition、文本追加与 reset patch 迁入 `stores/appStore.recording.ts`，公开 `normalizeAudioVolume` 继续由原 facade 导出。根 Store 保留 transition lease、时钟、`get/set`、matching fence、录音态音量门禁和全部 action wrapper；与 `workbenchFeedback.voice` 原子关联的 completed voice 仍留待 Workbench 域处理。`appStore.ts` 从 1,051 行降至 1,016 行。独立审计确认外置 Zustand slice factory 会隐藏 fence/原子边界，后续固定采用“纯 transition + 单一根 composition”，不创建第二个 Store 或让领域模块持有运行时所有权。

Store 子阶段测试归档已完成：原 1,042 行聚合测试的 56 个 test statement（展开 59 cases）按 Recording、Config、History/Dictionary、Workbench、Settings/Auth 与 OTA 六域迁移，共用唯一 28 行无测试体 harness；标题与 callback AST 多重集无遗漏、重复或变更。连同 History/Recording 的 11 项纯 transition characterization，六文件合计 70 项且可分别独立运行。

Store 子阶段第四刀已完成 OTA 纯 transition 边界：初始 task、start/progress/check/download/fail/cooldown patch 迁入 `stores/appStore.ota.ts`。根 Store 继续唯一拥有 OTA lease、running/cooldown 门禁、`Date.now/new Date`、matching lease、expected-until fence 与 action wrapper；检查清空 result/cooldown、下载保留 result/cooldown、失败检查刷新 cooldown 等顺序不变。`appStore.ts` 从 1,016 行降至 968 行。

Store 子阶段第五刀已完成 Workbench 纯 transition 边界：completed voice/version、surface feedback、TTS busy/lease、OCR 与 Ask 的 idle/start/finish/ACK/fail/reset/dismiss patch 迁入 `stores/appStore.workbench.ts`。根 Store 继续唯一拥有三套 lease source、时钟、`get/set`、running/ack 门禁、matching lease 与 runId/operationId ACK fence；completed voice 与 voice feedback、OCR/Ask start 与 workspace feedback、TTS busy 与 lease 继续各自单次原子提交。`appStore.ts` 从 968 行降至 893 行。

Store 子阶段第六刀已完成 Settings 纯 transition 边界：operation/notices、STT/LLM/OCR outcomes、诊断中间态、模型缓存及其初始 factory/领域映射迁入 `stores/appStore.settings.ts`。根 Store 继续唯一拥有 operation/notice ID source、时钟、`get/set`、全局单互斥与 matching lease fence；`tryStartSettingsOperation` 的 owner/notice、connection outcome、diagnostic outcome 三段提交结构保持不合并，所有完成/失败动作仍以单次原子 patch 收敛。Desktop Auth token/bootstrap/status 与身份 fence 全部留根。`appStore.ts` 从 893 行降至 767 行。

Store 子阶段第七刀已完成 Config/local-OCR 纯 transition 边界：平台默认配置、saved config、normalized OCR key、availability、set/update/persist/reset 与 probe start/finish patch 迁入 `stores/appStore.config.ts`。根 Store 继续唯一拥有 probe lease、`get/set`、configuration key + availability key + lease 三重 fence；配置目标变化时 config、availability、Settings OCR outcome 与 OCR notice 仍在同一 patch 中提交，Desktop Auth 全域留根。`appStore.ts` 从 767 行降至 645 行。

Store 子阶段至此闭环：最终采用“纯 transition + 单一根 composition”，不采用会隐藏 fence/原子边界的外置 Zustand slice factory。固定范围总终审为 APPROVE，P0/P1/P2 均为 0；六个领域 transition 模块无 Zustand、lease、clock、`get/set` 或 Auth runtime，根 facade 的 37 个类型与 6 个运行时导出及唯一 `useAppStore` 均不变。

### Phase 5：Storage 与 Pipeline 高风险收尾

1. Storage 先搬 History、Dictionary，再搬 Config。
2. Desktop Auth 的 envelope、checksum、migration、generation CAS 与 runtime fence 整块迁移。
3. Pipeline 先抽纯 proxy protocol、WAV/stream parser、错误映射和 cloud policy。
4. 只有纯逻辑稳定且并发矩阵完整后，才评估 recording/finalize 内部拆分；若拆分会增加锁或跨对象不变量，则保留现状。

Storage 第一刀已完成 History 域迁移：`HistoryEntry`、clear DTO、SQLite store、5,000 条保留上限、Immediate delete/clear transaction 与原 4 项事务测试整体进入 `storage/history.rs`，根模块直接 re-export 原三项公开契约；新增 newest-first/limit/offset characterization。生产块 4,840 字符与迁移前逐字符一致，未改 SQL、去重、rollback、clear floor 或调用路径。

Storage 第二刀已完成 Dictionary 域迁移：`DictionaryEntry` 与 `DictionaryStore::new/list/words` 整体进入 `storage/dictionary.rs`，根直接 re-export 原两项契约；生产块 1,756 字符与迁移前逐字符一致。新增建表/list DTO、坏 row 跳过及 prepare/query 失败返回空的 3 项 characterization，只固定既有 fail-soft 行为，不新增 repository 抽象或改变无 `ORDER BY` 语义。

Storage 第三刀已完成唯一 atomic file primitive：同目录临时文件、Unix 0600、flush/sync、Windows `MoveFileExW`/非 Windows rename+目录 sync、失败清理与注入式 replace 整体进入 `storage/atomic_file.rs`。Config 与 Desktop Auth 继续直接复用同一 `atomic_write_with/replace_file_atomically`，根模块不保留 wrapper 或第二套实现。

Storage 第四刀已完成 Config 域迁移：36 字段 `AppConfig`、严格 v2 envelope、new-install 初始化/回读、差量合并、串行 persistence transaction 与 `ConfigManager` 整体进入 `storage/config.rs`，10 项配置测试归入同域测试模块。根直接 re-export 原 7 项公开契约，Desktop Auth 不依赖 Config，两个持久化域只共享唯一 atomic primitive。

Storage 第五刀已完成 Desktop Auth 安全域整块迁移：严格 envelope/checksum、legacy 单次迁移、generation floor、generation/authority/raw-cache exact CAS、package 过滤与 runtime fence 连同 13 项测试整体进入 `storage/desktop_auth.rs`，不再继续拆分。根 `storage/mod.rs` 收敛为 20 行模块声明、22 项直接 re-export/常量入口；Config 与 Auth 只共同依赖唯一 atomic primitive。

Pipeline 第一刀已完成纯代理协议迁移：8 MiB LLM stream 上限、完整流解析、STT 错误码/文本解析、16 kHz 单声道 PCM→WAV 与两个 concrete marker error 整体进入 `pipeline/proxy_protocol.rs`，根模块只保留私有接线。三个异步 proxy transport/consume 方法、cloud policy、generation 与 start/stop/finalize 状态机均未移动；原 4 项测试随实现迁移，并新增精确 WAV header/payload characterization。

Pipeline 第二刀已完成用户错误语义迁移：no-speech/timeout/config、audio 初始化/捕获完成与 LLM polish 的 7 个纯 mapper 连同 7 项测试进入 `pipeline/errors.rs`。STT error latch、session matching、generation/capture abort 与 start/stop/finalize 继续留根；根只通过父模块可见函数消费同一错误对象。

Pipeline 第三刀已完成 cloud policy 纯决策迁移：配置来源、Desktop Auth snapshot/runtime fence、cache TTL/identity/service capability、backend STT resolution 与 endpoint 组合整体进入 `pipeline/cloud_policy.rs`。身份失效副作用、preloaded policy 生命周期、LLM 本地访问判断与三个 proxy transport 留根；新增 endpoint base/path 四种斜杠组合 characterization，Pipeline 矩阵增至 47 项。

Pipeline 第四刀已完成输出/历史外层迁移：同一 `PipelineHandle` 的 split impl 在 `pipeline/output_history.rs` 中拥有 history entry、输出 fallback/交付报告与 completed cloud operation 判定。stop 状态机仍在根内按 history 成功→STT ACK→LLM ACK→clear session→Idle 执行；generation guard、三个 proxy transport、start/stop/abort/finalize 与 capture/STT owner 全部留根。继续拆 recording/finalize 会增加跨模块锁与 owner 不变量，Pipeline 在此停止。

### Phase 6：瘦身 Tauri composition root

- [x] 将 Markdown 原生窗口创建、renderer-ready reveal、generation fence 与销毁清理整块迁入既有 `markdown_window.rs`。
- [x] 将 onboarding command 与进程内 guard/fence 迁入 `onboarding_guard.rs`。
- [x] 将全局快捷键 plugin 安装与初始注册迁入 `hotkey.rs`。
- [x] 将 tray menu、builder 与事件接线迁入 `tray.rs`。
- [x] 将主窗、胶囊窗创建及窗口事件接线迁入 `window_runtime.rs`。
- [x] 将 setup 所需 managed state 的构建与注册迁入窄职责 `managed_state.rs`。

根 `lib.rs` 始终保留唯一 `run()`、plugin/setup 的可审计顺序、完整且只注册一次的 `generate_handler!` 清单、三个薄录音 command adapter、single-instance 与最终 `.run()`；不得把整个 setup closure、command registry 或跨域启动顺序藏入 helper。

Onboarding 第二刀已完成：startup checkpoint 校验、主窗口门禁、Pipeline abort、resolve/acquire/release command 与原有 lease/boot-block 状态机现由同一 `onboarding_guard.rs` 拥有；根仅保留 managed state 创建和模块限定的 command 注册。

Hotkey 第三刀已完成：handler 构建、global-shortcut plugin 安装、首次 configured registration 与占用警告收敛为 `hotkey.rs` 的单一 setup 入口；根 setup 仍在 auto-start 之后、tray 之前显式调用该入口。

Tray 第四刀已完成：初始 menu、manager-owned icon builder、menu event 与左键/双击 event 整块进入 `tray.rs`；根 setup 只在 hotkey 之后、窗口创建之前显式调用 `install_tray`，没有把 tray handle 存入 app state。

Window Runtime 第五刀已完成：主窗/胶囊创建、响应式尺寸、close-to-tray、位置保存/恢复、圆角同步、跨窗口 destroyed cleanup 与 devtools 接线集中进入 `window_runtime.rs`；根 setup 继续逐项显式呈现 capsule→main→handler→position→devtools 顺序。

Managed State 第六刀已完成：数据目录、Config/History/Dictionary、idempotency、Markdown speech、Network/Pipeline、ProcessOwners、窗口 lifecycle、cache 与 onboarding state 的构建/注册集中进入 `managed_state.rs`；根从单一入口取得已验证 `initial_config`，三个既有公开 state 类型继续由 crate root 兼容 re-export。

Phase 6 固定范围终审为 APPROVE，P0/P1/P2 均为 0：`lib.rs` 根公开名称仍为 21 项，三个录音 command 逐字符一致，`generate_handler!` 仍为原顺序 73 项且无重复；15 项 managed state 的值和注册顺序不变，setup 继续显式呈现 managed state→auto-start→hotkey→tray→capsule→main→handler→position→devtools→prewarm。六个新边界依赖单向、无循环或双实现。

全计划最终静态终审为 APPROVE，P0/P1/P2 均为 0。Settings 总审发现并补齐四个受控 tab 后，其 16 节点/29 条内部边无循环；OCR 共享 primitive 提升后 payload/pdf_render 不再形成 sibling cycle。Home、Windows、Store、Server DB/Admin/Admin Panel、Storage、Pipeline 与 Tauri composition root 均达到既定边界；`ocr_runtime`、document OCR、Quota、`process_ownership`、Markdown editor shell 与 Pipeline recording/finalize 作为单一安全事务或 owner 状态机明确保留，不再按行数继续拆分。

## 6. 每刀统一门禁

### 通用

- 改动前后 `git status --short` 可解释，不触碰用户或其他 agent 的改动。
- 新旧公开 API、IPC、route spec 或 Store action 契约有 characterization test。
- 最窄领域测试通过；阶段完成后运行所属子项目全量测试。
- formatter、typecheck/build、lint（适用时）与 `git diff --check` 通过。
- 不删除、弱化或跳过已有竞态、安全、卸载恢复、幂等、回滚测试。
- 同一任务更新根目录 `WORKLOG.md`，记录实际范围、验证和边界。

### Rust OCR 专项

- DOCX：标题、无序/有序列表、表格、代码块、分页、Unicode/XML escaping 与 ZIP 必需部件不变。
- Payload：25 MiB、PNG/JPEG/WebP/BMP magic、伪 PDF 与 MIME/magic 不一致继续 fail-closed。
- PDF：20 页成功、21 页哨兵拒绝、合法空白页降级、全空失败不变。
- Proxy：图片/PDF route、幂等 child key、`code/requestId` 与迟到/重放行为不变。

### 前端专项

- Home/Settings 卸载后任务仍保持真实 busy/result/error。
- 只有匹配 lease 的回调能提交或释放；旧任务不得覆盖新任务。
- 独立 WebView 与主窗口的 owner 边界保持 Native 权威。
- 不新增 toast 重复反馈，不改变 panel/dialog 的结果归属。

### Server 专项

- SQL、事务范围、advisory lock、revision CAS 与事务内审计不变。
- `businessRouteSpecs` / `adminRouteSpecs` 的 method、path、access、capability、body/rate/in-flight/audit 逐项不变。
- Admin panel 响应正文结构、CSP nonce、Cookie-only 认证与 actor header 门禁不变。

## 7. 阶段完成标准

一个阶段只有在以下条件全部满足时才完成：

1. 目标领域不再与无关修改原因共享原巨石文件。
2. 生命周期或事务所有权有唯一、可描述的模块边界。
3. 原兼容入口已变薄且没有形成长期双实现。
4. 相关巨型测试文件同步按领域拆分，竞态覆盖没有减少。
5. 全量回归通过，并由独立只读复审确认无 P0/P1。

本计划不预设“每个文件必须少于 N 行”。若拆分会破坏安全事务或增加跨模块状态同步，即使文件仍长，也优先保留内聚性。

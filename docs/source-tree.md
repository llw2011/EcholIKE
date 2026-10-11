# EcholIKE 源码树与改动落点

本文件回答一个问题：**一个需求现在应该落到哪里**。产品行为、安全不变量与发布规则以 [项目权威规范书](project-guidelines.md) 和 [工程红线卡](red-line-card.md) 为准；[巨石源码分阶段拆解计划](2026-08-27-monolith-decomposition-plan.md) 只保留拆解决策和验证证据，不再作为当前源码索引。

源码永远是最终事实源。若本文件与当前代码不一致，先按依赖、公开导出和测试确认唯一所有者，再在同一任务中修正本文件与根目录 `WORKLOG.md`。

## 1. 先分清三种文件角色

| 角色                 | 作用                                 | 修改规则                                   | 当前典型文件                                                             |
| -------------------- | ------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------ |
| 实现所有者           | 持有领域行为、生命周期、状态机或事务 | 功能改动首先落这里，并在同领域补测试       | `useWorkbenchOcr.ts`、`pipeline.rs`、`db/postgres/quota-ledger-store.ts` |
| Composition root     | 按明确顺序装配多个领域               | 只在依赖接线、启动顺序或注册变化时修改     | `windows/MainWindowApp.tsx`、`src-tauri/src/lib.rs`、`server/src/app.ts` |
| 兼容 facade / barrel | 保持既有 import、公开导出或命令入口  | 只做直接转发或 re-export，不承载第二套实现 | `stores/appStore.ts` 的类型 re-export、`db/client.ts`、`routes/admin.ts` |

落代码时依次判断：

1. 哪个模块拥有该任务的完整生命周期或事务？先改唯一实现所有者。
2. 是否新增了依赖、command、route 或公开契约？只有这时才同步 composition root 或 facade。
3. 是否跨越前端、Rust IPC、Server HTTP 或数据库？逐层同步 DTO、bridge、门禁与测试，不能只改其中一层。
4. 找不到稳定边界时，优先把代码留在现有领域，不新建含义模糊的 `common`、`shared`、`helpers` 或第二套 Store。

## 2. 仓库根目录

| 路径                                                           | 性质与职责                              | 落点规则                                                         |
| -------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| `src/`                                                         | React/Vite 桌面 renderer                | 窗口 runtime、UI、前端状态和 Tauri bridge                        |
| `src-tauri/`                                                   | Tauri/Rust 桌面原生层                   | IPC、录音管线、系统窗口、持久化、更新和平台能力                  |
| `server/`                                                      | Hono/Node 后端                          | HTTP、认证授权、业务服务、PostgreSQL 和后台 OCR                  |
| `scripts/`                                                     | 本地构建、正式 OTA 发布、验证与工具测试 | 只在工具链或发布流程本身变化时修改；发布行为仍受正式发布规范约束 |
| `ops/`                                                         | systemd/journald 部署模板               | 只处理 Server 进程部署和日志策略，不放产品业务逻辑               |
| `docs/`                                                        | 权威规范、执行计划与历史记录            | 稳定规则进规范；阶段性过程进计划；所有实际改动写根 `WORKLOG.md`  |
| `.github/`                                                     | CI 与社区仓库配置                       | 不等同于本机发布链；未经授权不得借 CI 写远端 Git 状态            |
| `demo/`、`tweet-reference/`                                    | 参考材料                                | 默认不改、不编译、不纳入产品发布判断                             |
| `dist/`、`server/dist/`、`src-tauri/target*/`、`node_modules/` | 构建产物或依赖                          | 不是源码落点；不要手工修产物来替代修改源文件                     |

### 2.1 文档与受控文件的权威层级

- `AGENTS.md`、`docs/project-guidelines.md`、`docs/red-line-card.md` 与本文件是当前 agent 入口、工程行为、安全红线和源码落点权威；`WORKLOG.md` 是倒序维护的实际改动台账。
- `docs/desktop-ota-release-tool.md` 是当前正式 OTA 操作手册；`desktop-config-ota-release-policy.md` 只保留旧链接兼容入口，不得覆盖权威规范和发布工具。
- `docs/YYYY-MM-DD-*.md`、已闭环计划和旧 worklog 记录当时的设计/迁移证据，不是当前文件索引。需要理解历史决策时阅读，落代码仍回到本文件与源码确认。
- `docs/images/`、`demo/`、`tweet-reference/` 是参考资产；除非任务明确涉及文档展示或视觉参考，不要当产品实现修改。
- `server/src/db/migrations/` 是受控、按 journal 顺序部署的数据库源码，不是可删除的生成产物；`dist/`、`server/dist/` 与 `src-tauri/target*/` 才是构建产物。

## 3. 前端 `src/`

### 3.1 窗口入口与启动链

```text
main.tsx
└── App.tsx                         只做跨窗口认证同步、dataset 与 hash 分流
    ├── windows/MainWindowApp.tsx   主窗口 composition
    │   ├── useMainStartup.ts       启动数据、认证同步、启动 OTA、权限检查
    │   └── useMainUsageMode.ts     onboarding、模式切换、重验与 lease/fence
    ├── windows/CapsuleWindowApp.tsx
    └── windows/MarkdownEditorWindowApp.tsx
```

- `main.tsx` 只装配 React `StrictMode`、`ErrorBoundary` 和全局样式；不要把窗口或领域 runtime 放回浏览器入口。
- `App.tsx` 不再承载 Markdown、主启动、认证恢复或胶囊业务；增加窗口级行为应落到对应 `windows/*WindowApp.tsx` 或其专用 hook。
- `#/settings` 等主窗口页面路由由 `lib/router.ts` 与 `MainWindowApp.tsx` 处理；`App.tsx` 只精确识别 `#capsule` 和 `#markdown-editor` 两个窗口 hash。
- 主窗口页面组合、路由切换和 onboarding surface 落在 `MainWindowApp.tsx`；启动事务与使用模式事务不得拆成散落的 effects。
- 独立 Markdown WebView 的草稿、文件 outcome、语音追加、renderer-ready/reveal 和窗口事件由 `MarkdownEditorWindowApp.tsx` 统一拥有。主窗口内嵌 Markdown 生命周期不在这里，而在 `HomePage/useMarkdownWorkspace.ts`。
- 胶囊窗口启动接线在 `CapsuleWindowApp.tsx`；胶囊表现、皮肤和交互分别在 `components/Capsule/` 与 `styles/capsules.css`。

窗口入口测试位于 `src/__tests__/App*.test.*`，窗口尺寸、边界和样式契约也在 `src/__tests__/`。

### 3.2 Home / Workbench

| 需求                                                      | 唯一落点                            | 不应放入                           |
| --------------------------------------------------------- | ----------------------------------- | ---------------------------------- |
| Home 跨域排布、OCR→Ask/Markdown 映射                      | `components/HomePage/Workbench.tsx` | 各 hook 中复制页面 composition     |
| OCR MIME、上限、label、warning、文本清理等纯逻辑          | `HomePage/ocrDomain.ts`             | React component 或 Tauri bridge    |
| OCR probe、路由、Store lease、ACK、取消和 dialog 生命周期 | `HomePage/useWorkbenchOcr.ts`       | `Workbench.tsx` 新增第二套异步状态 |
| Ask 请求、上下文冻结、流式结果与 ACK fence                | `HomePage/useWorkbenchAsk.ts`       | OCR hook 或局部 busy state         |
| 首页结果朗读、TTS owner/lease、播放与回收                 | `HomePage/useWorkbenchSpeech.ts`    | Markdown speech 生命周期           |
| 主窗口 Markdown 草稿、冲突、AI、文件命令和窗口 fallback   | `HomePage/useMarkdownWorkspace.ts`  | 独立 Markdown window runtime       |
| 结果、历史、OCR dialog、Markdown dialog 展示              | 同目录 `*Views.tsx`、`*Dialog*.tsx` | 新建持有 Store/effect 的展示组件   |

测试按领域位于 `components/HomePage/__tests__/Workbench.<domain>.test.tsx`；公共 mock/reset 在无测试体的 `workbenchTestHarness.tsx`。修改哪个 hook，就优先跑同名领域测试，不能把拆开的测试重新堆回一个巨型文件。

### 3.3 Settings

```text
components/Settings/ControlPanel.tsx       设置页 composition、受控 view model 接线
├── configPersistence.ts                  串行配置持久化协调
├── useBackendAccount.ts                  bootstrap、登录、取消授权与手动重验
├── useSettingsConnectionTests.ts         STT/LLM/OCR 连接测试
├── useSettingsDiagnostics.ts             TTS/PDF owner 诊断
├── useOtaSettings.ts                     OTA 检查、下载、安装状态
├── proxyUrl.ts / settingsCache.ts         纯解析与本地显示缓存
├── settingsUi.tsx                        设置页 UI primitive
└── *SettingsPanel.tsx                    受控展示与用户事件转发
```

- `*SettingsPanel.tsx` 可以持有输入 ref 或纯展示状态，但不得直接订阅 Store、调用 Tauri、启动网络请求、创建 lease 或拥有跨卸载任务。
- 新设置项先确认属于 Input、Speech、AI、System、Diagnostics 或 About，再扩展对应 panel 的 props/view facts；副作用留在 `ControlPanel` 或已有专用 hook。
- panel notice、诊断结果和 OTA 结果仍由各自 surface 独占，不得额外复制 toast。

测试位于 `components/Settings/__tests__/ControlPanel.<domain>.test.tsx`，公共环境在 `controlPanelTestHarness.tsx`；纯解析器各有独立测试。

### 3.4 Store、bridge 与共享领域

| 路径                                         | 职责                                                                                 | 硬边界                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `stores/appStore.ts`                         | 唯一 `useAppStore`、lease/clock、`get/set`、认证 fence、action wrapper、单次原子提交 | 不再拆第二个互订阅 Zustand Store                                                                                         |
| `stores/appStore.types.ts`                   | 公共领域类型与内部 `AppState`                                                        | consumer 继续优先从 `appStore.ts` 兼容入口导入公共类型                                                                   |
| `stores/appStore.<domain>.ts`                | Config/History/Recording/Workbench/Settings/OTA 纯 transition                        | 不得引入 Zustand、lease、clock、Auth、Tauri 或其他副作用                                                                 |
| `stores/fileCommandStore.ts`                 | Native 文件任务跨 surface 恢复与反馈                                                 | 不并入普通组件局部 state                                                                                                 |
| `lib/tauri.ts`                               | 产品自定义 Rust command 的前端 IPC DTO 与 typed `invoke` facade                      | 不实现 Rust 业务，也不绕过该 bridge 到处拼产品 command 名；Tauri 官方 window/event/plugin API 仍可在真实窗口边界直接使用 |
| `lib/desktopAuth*.ts`、`desktopBootstrap.ts` | renderer 认证镜像、启动同步与 bootstrap 归一化                                       | 不提升 local token 为原生 authority                                                                                      |
| `lib/startupData.ts`、`startupUpdate.ts`     | 启动数据和启动更新纯编排支撑                                                         | window 生命周期仍由 `useMainStartup.ts` 拥有                                                                             |
| `lib/userErrors.ts`                          | 用户可见错误归一化                                                                   | 保留后端 `service/status/code/requestId`                                                                                 |
| `lib/filePayload.ts`、`fileNames.ts`         | 文件 payload 与安全文件名                                                            | 组件内不重复 FileReader/base64 实现                                                                                      |
| `hooks/`                                     | 跨页面可复用的 renderer hook                                                         | 单一页面领域行为优先留在该页面目录                                                                                       |

新增 Store action 时，纯状态变换进入对应 `appStore.<domain>.ts`，lease 检查、时间、`get/set` 和跨域原子 patch 留在 `appStore.ts`。类型变化同步 `appStore.types.ts` 与 `stores/__tests__/`。

`useAppStore` 只在**单个 WebView 内**共享，主窗、胶囊窗和独立 Markdown 窗各自有自己的 Store 实例；`useTauriEvents` 和原生 snapshot 只负责同步事实，不会把三个 Store 变成同一块内存。跨 WebView 的 TTS、Markdown AI 和文件任务 owner 必须由 Rust `process_ownership.rs`/IPC 拥有，再由 `fileCommandStore.ts`、`components/MarkdownEditor/markdownAiTask.ts` 等 renderer 领域恢复；不能只加一个 `appStore` lease 就宣称实现了全局互斥。

样式也按所有者分流：`styles/globals.css` 放主窗、Home、Settings、Markdown 的结构与响应式规则，`styles/themes.css` 只放主题 token/profile/material 差异，`styles/capsules.css` 独占胶囊 runtime 与 preview。不要把主题值硬编码回组件，也不要把胶囊 selector 塞回全局结构样式；对应契约测试位于 `src/__tests__/` 和 `components/Capsule/__tests__/`。

## 4. Tauri/Rust `src-tauri/src/`

### 4.1 Composition 与系统 runtime

```text
main.rs
└── lib.rs                 唯一 run()、plugin/setup 顺序、完整 command registry
    ├── managed_state.rs   state 构建与 app.manage 注册
    ├── hotkey.rs          全局快捷键安装与触发
    ├── tray.rs            tray 构建和事件
    ├── window_runtime.rs  主窗/胶囊创建、shape、close/destroy 生命周期
    ├── markdown_window.rs 独立 Markdown window generation/reveal 生命周期
    └── onboarding_guard.rs onboarding guard 与 command
```

- `lib.rs` 只保留三个薄录音 command adapter、插件与 setup 的显式顺序、完整 command registry 和最终 `.run()`。录音行为修改进入 `pipeline.rs`；窗口、托盘、热键或 state 初始化进入上表对应模块。
- `managed_state.rs` 只负责构建、验证和注册依赖；不得把领域操作顺手搬进初始化函数。
- `window_shape.rs` 是 Windows region/圆角能力，`linux_x11.rs` 是 Linux 平台适配；跨平台行为要保留 `cfg` 边界。
- 当前没有 `src-tauri/src/setup/`；不要新建一个目录把可审计的 setup 顺序重新藏起来。

### 4.2 IPC commands

`commands/mod.rs` 是领域模块目录，不是业务实现。当前落点：

| 模块                                   | 职责                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `commands/config.rs`                   | 配置 snapshot、使用模式、代理检测、自动启动与胶囊自动隐藏                 |
| `commands/backend.rs`                  | 后台登录、幂等 ACK、单次代理 Ask/TTS 与 TTS 诊断                          |
| `commands/update.rs`                   | OTA、bootstrap、Desktop Auth candidate/commit/clear/runtime fence command |
| `commands/llm.rs`、`stt.rs`            | 本机/BYOK LLM、STT 模型与连接测试                                         |
| `commands/history.rs`、`dictionary.rs` | 本地数据 IPC 外壳                                                         |
| `commands/markdown_speech.rs`          | Markdown 持久语音生成、资产与目录生命周期                                 |
| `commands/misc.rs`                     | 辅助功能、热键暂停/恢复、tray label 与退出等窄系统命令                    |
| `commands/ocr/mod.rs`                  | OCR DTO、公开 command、共享小 primitive 与薄编排                          |

OCR 子模块按职责固定为：`payload.rs`（base64/magic/MIME/上限）、`capture.rs`（截图）、`pdf_render.rs`（客户端 PDF 栅格化/导出）、`text.rs`（文本清理）、`direct.rs`（本机 direct provider）、`proxy.rs`（后台图片/PDF 协议与聚合）、`docx.rs`（DOCX 构建）、`file_commands.rs`（文件 dialog/save/owner 适配）。不要把这些实现重新写回 `ocr/mod.rs`，也不要让 sibling 模块相互循环依赖。Windows 外部 Router/Pipeline supervisor 是 sibling `commands/ocr_runtime.rs`，不是 `commands/ocr/runtime.rs`，也不依赖 Paseo daemon。

新增 Tauri command 必须完成同一条链：

1. 在唯一领域模块实现并添加相关 Rust 测试；
2. 必要时在 `commands/mod.rs` 声明模块；
3. 在 `lib.rs` 的 `generate_handler!` 中只注册一次；
4. 在 `src/lib/tauri.ts` 增加类型化 bridge，并补前端 bridge/consumer 测试。

### 4.3 状态机、存储与平台能力

| 路径                                                              | 实现所有者                                                                        | 不可破坏的边界                                 |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------- |
| `pipeline.rs`                                                     | 录音 start/stop/abort/finalize、generation、capture/STT owner、三个异步 transport | 不继续把 recording/finalize 按行数拆成多锁对象 |
| `pipeline/{cloud_policy,errors,proxy_protocol,output_history}.rs` | 纯决策、错误、协议和输出/history 外层                                             | 副作用和 generation 提交仍回到根状态机         |
| `commands/ocr_runtime.rs`                                         | 受控本机 OCR 子进程、环境、取消、清理与可信 artifact                              | 作为单一安全边界保留                           |
| `process_ownership.rs`                                            | TTS、Markdown AI、文件任务 lease 和窗口销毁/迟到完成                              | 共享 owner 语义不可复制到各 command            |
| `storage/config.rs`                                               | AppConfig、严格 v2 envelope、事务合并                                             | 新字段同步 renderer 类型/默认值/UI/测试        |
| `storage/desktop_auth.rs`                                         | auth envelope/checksum/migration/generation CAS/runtime fence                     | 必须整域维护、fail-closed                      |
| `storage/history.rs`、`dictionary.rs`                             | SQLite 领域 store                                                                 | 通过 `storage/mod.rs` 兼容 re-export           |
| `storage/atomic_file.rs`                                          | 唯一原子文件替换 primitive                                                        | 不在 Config/Auth 复制写盘实现                  |
| `storage/mod.rs`                                                  | Storage 兼容 facade 与 re-export                                                  | 不承载 Config/Auth/History/Dictionary 实现     |
| `idempotency.rs`                                                  | 待 ACK operation root、session 隔离、retry/retire                                 | 不在各 command 复制 pending/ACK 账本           |
| `network.rs`                                                      | 尊重配置代理的共享 HTTP client                                                    | command 不直接另造绕过代理的 client            |
| `audio/`、`stt/`、`llm/`、`output/`                               | 设备/provider/output 实现                                                         | command 只作 IPC 外壳和编排                    |

Rust 的合法 Pipeline 布局是 `pipeline.rs` 加 `pipeline/*.rs`，不是 `pipeline/mod.rs`。测试通常与模块内联；`storage/config` 的测试位于 `storage/config/tests.rs`。改 command registry 后还要确认注册项无遗漏或重复。

## 5. Server `server/src/`

### 5.1 请求与依赖流

```text
index.ts
├── env.ts
├── services/app-services.ts        生产依赖注入与生命周期
└── app.ts                          route specs、中间件顺序、Hono composition
    └── routes/*                    HTTP 解析、handler、领域错误翻译
        └── services/<domain>/*     业务状态机与接口
            └── db/postgres/*       PostgreSQL 实现、SQL、锁和事务
```

- `index.ts` 只负责加载环境、创建服务、监听端口、warmup 与 graceful shutdown。
- `app.ts` 是 `businessRouteSpecs` / `adminRouteSpecs` 的唯一权威和中间件装配点；不要在里面实现 handler 业务。
- `services/app-services.ts` 是生产依赖 composition；测试通过 `AppServices` 注入替身。新增领域依赖时同步接口、生产构造与测试 helper。
- `routes/` 拥有 HTTP body/headers/DTO parser 和领域错误翻译；`services/` 不依赖 Hono request。

新增或修改**业务/Admin route** 时必须同步：route handler、`app.ts` 中对应的 `businessRouteSpecs` / `adminRouteSpecs`、正确的 auth/capability/body/rate/in-flight/audit 门禁、service 接口/实现和 `server/src/tests/` 契约测试。Health/ready、Stripe webhook、app update、desktop bootstrap、Better Auth 与 Admin Panel 属于 `createApp()` 内显式 public/auth/panel mount；修改或新增这类入口必须先证明 public 边界，保留显式中间件顺序并补独立契约测试，不能为了形式统一塞进业务 spec。

### 5.2 数据库与安全事务

| 路径                                            | 职责                                                            | 落点规则                                                            |
| ----------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| `db/client.ts`                                  | PostgreSQL 连接、`DatabaseClient` 与兼容 re-export              | 不放 SQL 或领域事务                                                 |
| `db/postgres/billing-store.ts`                  | Stripe/billing store                                            | webhook marker、customer lock 与权威 snapshot 同事务                |
| `db/postgres/quota-ledger-store.ts`             | quota/idempotency 持久化状态机                                  | reserve/resolve/commit/release/replay、加密 AAD 与 fencing 整体维护 |
| `db/postgres/desktop-config-store.ts`           | Desktop/provider/OTA store                                      | revision CAS、控制锁、凭据加密与事务内审计整体维护                  |
| `db/postgres/admin-store.ts`                    | 用户/角色/配额/场景 Admin store                                 | actor control context 与审计不可绕过                                |
| `db/postgres/scene-store.ts`、`audit-store.ts`  | 场景和普通审计 store                                            | 不与 Admin 控制事务混成共享 repository                              |
| `db/admin-insights.ts`                          | Admin 用量、审计、operation 与 session 的 PostgreSQL read model | 该专用 store 是当前例外，不要把其 SQL 写进 `db/client.ts`           |
| `db/postgres/control-audit.ts`、`row-values.ts` | 已稳定跨域复用的窄 primitive                                    | 不扩成通用数据库杂物箱                                              |
| `db/schema.ts`、`db/migrations/`                | schema 与顺序 migration                                         | schema 改动必须新增 migration、更新 journal 并跑 migration 测试     |

领域 service 接口与内存测试实现目前仍位于各自 `services/<domain>/`；生产 SQL 跟随既有领域 store：常规 store 位于 `db/postgres/*-store.ts`，Admin insights read model 位于 `db/admin-insights.ts`。`db/client.ts` 保持薄 facade，旧 import 路径存在不代表实现应该写回去。

### 5.3 Admin 与控制面板

- `routes/admin.ts` 只是兼容 re-export；Users、Quota、Providers、OTA、Scenes、System 的 handler、parser 和专属错误分别落在 `routes/admin/<domain>.ts`。
- `routes/admin-insights.ts` 不经过 `routes/admin.ts` barrel，由 `app.ts` 直接纳入 Admin specs；其业务 read model 接口在 `services/admin/admin-insights-service.ts`，PostgreSQL 查询在 `db/admin-insights.ts`。不要把 insights handler 或 SQL 塞回 Admin barrel。
- `routes/admin/http-fields.ts` 只放真正跨域的 JSON primitive；`control.ts` 只放共享角色门禁与 mutation 错误。领域字段不能为了“复用”全部堆到这里。
- `routes/admin-panel.ts` 只拥有两个公开 handler、nonce/CSP/response、config 与 favicon。HTML shell 在 `admin-panel/*-page.ts`，CSS 在 `styles.ts`。
- `admin-panel/dashboard-script.ts` 只按固定顺序拼接同一个内联 `<script>` 词法作用域；Core、交互、Provider/Users/Usage/Quota/OTA/Scene 函数与各 bindings 落在同名脚本片段。不要把这些纯字符串片段误改成彼此隔离的浏览器模块，也不要破坏 nonce、声明顺序和启动顺序。
- Admin 控制面改动优先跑 `admin-panel-dom`、`admin-panel-ui-contract`、`admin-capabilities` 与相应控制事务测试。

### 5.4 其他 Server 领域

- 认证/会话在 `auth/`；通用请求门禁在 `middleware/`；环境解析只在 `env.ts`。
- Provider 协议实现位于 `services/proxy/`，出口验证、DNS/IP、pinned transport 与运行时地址位于 `services/security/`；不得用普通 `fetch` 绕过安全出口。
- 原始 PDF OCR route 是 `routes/proxy-ocr-document.ts`，其完整安全事务在 `services/ocr/document-ocr-service.ts`；artifact、relay、runtime 的可分离支撑位于同目录其他模块。不要按文件长度拆散退出确认、计费与清理顺序。
- Quota 领域契约和状态机在 `services/quota/quota-service.ts`；它与 PostgreSQL ledger 分工为业务协议与持久化实现，不是两套状态机。
- `server/src/tests/` 按 route/领域命名；PostgreSQL、安全出口、OCR runtime 等高风险路径都有独立回归文件，修改时先用文件名检索对应测试。

### 5.5 构建与发布脚本

- `scripts/build-desktop.ps1` 是桌面构建入口；`scripts/release-desktop-ota.ps1` 与 `scripts/ota/` 是正式 OTA prepare/publish、artifact 验证、生产控制和故障注入测试边界。
- `scripts/test-local-llm.ps1` 只用于本机 LLM 检查，不能替代桌面/Server 契约测试。
- `scripts/create-labels.sh` 硬编码的是外部历史仓库并会执行远端 GitHub label 写入，不属于 EcholIKE 正式工具链。未经用户对目标仓库和远端写入的当前任务明确授权，不得运行或把它接入 CI/发布流程。

## 6. 常见跨层需求路由

| 需求                     | 首要实现所有者                                                                      | 常见同步点                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增/修改配置字段        | `stores/appStore.types.ts`、`appStore.config.ts`、`storage/config.rs`               | `appStore.ts` wrapper、Settings panel/composition、config command、bridge、前端/Rust 测试                                                                           |
| 启动/OTA 后认证恢复      | `windows/useMainStartup.ts`、`lib/desktopAuthRuntime.ts`、`storage/desktop_auth.rs` | `commands/update.rs`、`pipeline/cloud_policy.rs`、`routes/desktop-bootstrap.ts` 与认证测试                                                                          |
| 登录、取消授权、手动重验 | `components/Settings/useBackendAccount.ts`、`lib/desktopAuthRuntime.ts`             | `stores/appStore.ts` Auth fence、Rust `commands/backend.rs` / `update.rs`、Settings account 测试；`useMainUsageMode.ts` 只负责 onboarding、模式切换和 Home 网络重验 |
| OCR 上传/截图行为        | `useWorkbenchOcr.ts`、`ocrDomain.ts`、`commands/ocr/<domain>.rs`                    | `lib/tauri.ts`；后台模式再同步 Server OCR route/service、幂等与 quota 测试                                                                                          |
| 录音状态或首帧/停止语义  | `pipeline.rs`                                                                       | `audio/`、`appStore.recording.ts`；Home start/stop/abort 接线在 `Workbench.tsx`，Capsule 接线在 `hooks/useRecording.ts`，两类 surface 都要跑竞态测试                |
| 胶囊皮肤或展示           | `components/Capsule/`、`styles/capsules.css`                                        | `SystemSettingsPanel.tsx` preview、appearance profile、胶囊契约测试；原生窗口能力再改 `window_runtime.rs`                                                           |
| Markdown 编辑器行为      | `components/MarkdownEditor/`                                                        | 主窗生命周期改 `useMarkdownWorkspace.ts`；独立窗生命周期改 `MarkdownEditorWindowApp.tsx`；Native owner/文件命令按需同步 Rust                                        |
| 设置页账号/诊断/OTA      | 对应 Settings hook                                                                  | `ControlPanel.tsx` 接线、受控 panel props、Store transition/action、领域测试                                                                                        |
| 新 Tauri IPC             | Rust 唯一领域模块                                                                   | `commands/mod.rs`、`lib.rs` registry、`lib/tauri.ts`、consumer 与双端测试                                                                                           |
| 新 Server API            | `routes/<domain>.ts` + `services/<domain>/`                                         | 对应 business/admin spec，或经证明的 `createApp()` 显式 public/auth/panel mount；同时同步中间件门禁、`AppServices`、DB store/migration 与 Server tests              |
| Provider 或后台模型能力  | `services/proxy/` 与 `services/desktop/`                                            | `services/security/`、Admin provider route/panel、bootstrap、桌面 Settings/bridge 与测试                                                                            |
| OTA 发布协议或工具       | `services/desktop/`、`routes/app-update.ts` 或 `scripts/ota/`                       | manifest/signature/控制面/发布工具测试、版本五处同步、正式发布规范与 worklog                                                                                        |

## 7. 明确保留的内聚边界

下列文件长，但它们分别拥有一个安全事务或 owner 状态机。除非先证明不变量可以保持在单一认知单元内，否则不要继续按行数拆分：

- `src-tauri/src/pipeline.rs` 的 recording/finalize/generation；
- `src-tauri/src/commands/ocr_runtime.rs`；
- `src-tauri/src/process_ownership.rs`；
- `src-tauri/src/idempotency.rs`；
- `server/src/services/ocr/document-ocr-service.ts`；
- `server/src/services/quota/quota-service.ts`；
- `src/components/MarkdownEditor/MarkdownEditorShell.tsx`。

同理，不要重新拆成多个 Zustand Store，不要把 Admin/Quota/Desktop Auth 事务切成通用 repository，也不要把 Admin Panel 内联脚本改成会改变执行作用域的新前端框架。

## 8. 测试与维护

- 前端测试与领域同目录的 `__tests__/` 对齐；窗口/全局契约在 `src/__tests__/`；共享 harness 不放测试体。
- Rust 测试优先与实现模块内联，迁移实现时连同相关测试一起归属。
- Server 测试统一在 `server/src/tests/`，文件名直接对应 route、service、安全边界或 PostgreSQL 回归。
- Server 默认 Vitest 在没有数据库环境变量时会跳过真实 PostgreSQL 用例：store/事务回归需要 `TEST_DATABASE_URL`，升级 migration 需要隔离的 `TEST_UPGRADE_DATABASE_URL`。涉及这些边界时必须提供对应数据库并执行，或明确披露用例被跳过，不能把默认通过描述成数据库矩阵已通过。
- 迭代时先跑最窄领域测试；跨层契约再补 typecheck/build/相关全量。文档-only 改动不需要桌面编译，但仍要检查链接、路径、UTF-8 与 `git diff --check`。
- 每次新增、删除、移动实现所有者或改变 composition/facade 职责，都必须同步本文件和根 `WORKLOG.md`。不要把新目录只记录在历史拆解计划里。

定位源码优先使用：

```powershell
rg --files src src-tauri/src server/src
rg -n "symbol_or_command" src src-tauri/src server/src
git status --short
```

先找到定义、调用方、注册点和测试，再落代码；不要仅凭旧文件名或历史 plan 猜位置。

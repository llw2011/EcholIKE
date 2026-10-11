# EcholIKE 项目权威规范书

本文件是 EcholIKE 开发、排障、部署和发布的权威规范书。规则以当前源码为准；当源码行为和文档冲突时，先读源码，修本文档，再改实现。任何 agent 开始工作或上下文压缩后恢复工作时，必须先读取根目录 [AGENTS.md](../AGENTS.md)、本规范书、[工程红线卡](red-line-card.md) 和 [WORKLOG.md](../WORKLOG.md) 顶部最新条目。

## 1. 项目边界

- 常规命令从本仓库根目录运行，后端命令使用 `--prefix server`；不依赖开发者的用户名或绝对工作区路径。
- 不存在 `app/` 子目录。不要把前端、后端或 Tauri 命令放到假定的二级应用目录里执行。
- `src/` 是 React/Vite 桌面前端；`src-tauri/` 是 Tauri/Rust 桌面壳、IPC、存储、热键、音频和更新逻辑；`server/` 是 Hono + Better Auth + PostgreSQL/Drizzle 后端；`scripts/` 保存本地构建、正式 OTA 发布、验证与工具测试；`docs/` 保存计划和规范。
- 拆解后的真实实现所有者、composition root、兼容 facade、测试位置与常见需求落点统一见 [源码树与改动落点](source-tree.md)。涉及源码定位或改动时必须先按该表路由；历史拆解计划只作决策记录，不是当前落点索引。
- `demo/`、`tweet-reference/` 等参考材料不是产品源码，除非用户明确要求，不要修改或纳入发布判断。

## 2. 产品架构

- EcholIKE 是本地优先的桌面语音输入、OCR、问答、Markdown 整理工具。
- 桌面端有三个主要窗口形态：主窗口、胶囊窗口、Markdown 编辑器窗口。入口由 `src/App.tsx` 根据 `window.location.hash` 分流。
- 默认配置源是 `backend`。本地配置仍保留 `local/BYOK/local model` 能力，但后端托管模式是当前默认工作流。
- 后端托管模式下，桌面端通过 `/echo-api/proxy/llm`、`/echo-api/proxy/stt`、`/echo-api/proxy/tts`、`/echo-api/proxy/ocr` 与 `/echo-api/proxy/ocr/document` 使用服务端凭据。真实 provider key 不得下发到桌面端。
- 场景模板是后端能力，不是被删除的旧功能。桌面端只把它们作为当前工作流的轻量 preset 使用，不重新引入沉重的全局场景模式。

## 3. 配置与启动

- 每个 WebView 都实例化同一个根 Zustand Store 定义，但不同 WebView 的内存不共享；运行时 lease/clock/`get/set`/认证 fence 与 action wrapper 在 `src/stores/appStore.ts`，类型和纯 transition 分别在 `appStore.types.ts` 与 `appStore.<domain>.ts`。不得新建互相订阅的第二 Store，也不得把 Zustand、lease 或副作用下沉到纯 transition 模块；跨 WebView owner 必须由原生进程状态拥有。新增配置字段必须同步 `AppConfig`、默认值、Tauri 配置读写、设置页 UI、测试。
- 启动数据由 `src/lib/startupData.ts` 并行读取：本地 config、history、dictionary、runtime version。配置读取失败必须 fail-closed 且不得触发首次使用；history、dictionary、runtime version 可独立使用安全 fallback。
- `0.2.0` 起配置只读取 `app-config-v2.json` 的 schema 2 完整 envelope；旧 `app-config.json` 与 `settings.json` 永久忽略且不迁移。v2 文件缺失时必须先写入新安装默认值并回读成功，损坏、不可读或无权限时不得用默认值覆盖。
- 配置声明为 `create:false` 的主窗与胶囊窗必须在 Rust setup 完成全部 state、配置、数据库、网络、快捷键和托盘初始化后再显式创建；禁止用 renderer sleep、重试、屏幕/RDP 分支或延时提示掩盖 native 生命周期竞态。
- `onboarding_version` 是唯一持久化引导事实，只允许由专用 `choose_usage_mode` 命令在配置事务锁内从 0 单调推进到当前版本。普通设置保存必须提交 base→next 字段差量，不得整份回放旧快照，也不得修改首次使用 checkpoint；教程活动态只由 Rust 进程内租约管理，不写入配置文件。
- `onboarding_version=0` 只可能来自已原子创建并回读成功的 v2 新配置；选择使用方式成功后推进为当前版本，后续启动直接读取同一事实，不另设 marker 或兼容分支。
- `config_source` 是本机/后台业务来源的唯一权威和隐私边界；`desktopBootstrap` 只表示后台状态缓存，`policy.preferProxy` 只表示账号代理策略，二者都不得被 UI 用来反推当前模式。模式选择必须在配置事务锁内确认语音管线为 Idle 且没有尚未返回的 start/stop 操作，再由原生 `choose_usage_mode` 持久化；成功返回或收到提交后的原生 patch 后才允许更新 renderer，失败时继续显示旧模式。热键、托盘和首页录音读取配置时必须经过同一事务锁，使并发顺序可线性化，不得读取切换中间态或让已开始的旧来源语音管线跨越模式切换。
- 远程桌面策略由 `src/lib/tauri.ts` 的 `fetchDesktopBootstrap` 通过 Tauri 命令请求 `/desktop/bootstrap`。
- `desktopBootstrap.ts` 明确规定：后端 bootstrap 不得把 provider credentials 写入本地 `AppConfig`。`bootstrapConfigPatch()` 当前必须保持不注入密钥。
- 桌面认证权威与 bootstrap last-known-good 必须共同保存在原生 `desktop-auth-state-v1.json` 单一 envelope 中；envelope 使用严格 schema、校验和、同目录临时文件、落盘同步与原子替换。旧 `runtime-state-v2.json` 的 `desktop_bootstrap_cache` 只允许在新 envelope 缺失时一次性只读迁移，不修改或删除旧记录；新 envelope 存在但损坏时必须 fail-closed，禁止回退旧缓存。
- 认证 envelope 同时保存单调 generation、当前 authority token 与 cache。每次真实 bootstrap 请求先以 generation/authority CAS 取得唯一租约，成功响应再以同一租约和旧 cache 身份原子提交；普通请求不得旋转 authority，只有显式登录、退出或 401 清理可以改变它。进程内 read-CAS-write 由同一互斥锁线性化，跨窗口迟到响应、确认和失效只允许按 exact generation/authority CAS 生效。Windows OTA 的跨版本隔离由 Tauri updater 固有的“启动 NSIS 后退出旧进程，再由安装器完成替换并启动新进程”顺序拥有；不得另加无法约束旧二进制的协作式 lockfile 来冒充跨版本互斥。`storage` 与 `desktop-auth:state-changed` 事件只重新读取 snapshot，不得自行发请求或抢占 generation，也不得改成轮询。
- bootstrap cache 必须在写入时记录当前包版本和认证身份，读取时只接受与运行包及 native authority 完全一致的记录；本地存在 token 不代表已认证，只有 token、authority、已验证 bootstrap 用户身份三者一致时才允许云服务。generation 大于 0 的 native authority 只能由已验证登录产生；当其原始 cache 身份为空（登录已落盘、首次 cache 尚未提交）或与 authority 一致时，可先取得 exact generation/authority 租约，并在确认 localStorage 未于租约期间变化后，用 native authority 修复缺失或落后的 WebView token 镜像，再在线验证当前包 bootstrap。这不允许反向提升 local token。若 localStorage 只残留孤立 token，而 native authority 与原始 cache 身份都为空，或一次性迁移得到的 generation 0 authority 与 local token 不一致，必须用 generation CAS 清掉两侧孤儿身份及可能存在的 public cache，并要求重新登录；取得租约后再发生的身份变化仍只 fail-closed，禁止误伤并发登录。Rust 热键语音管线还必须取得本进程 renderer 对同一 generation/authority 的确认栅栏；栅栏在每次进程启动时默认关闭，认证读取失败或身份不一致时按身份 CAS 失效，禁止仅凭磁盘旧缓存继续调用云服务。显式 Bearer 无效或过期时 `/desktop/bootstrap` 必须返回结构化 401，不得匿名降级；真正无 Authorization 的请求始终返回匿名 200，且该路由不得用浏览器 Cookie 补成桌面身份，其他 Better Auth Cookie 路由保持原契约。设置页“当前版本”以 Tauri runtime version 为唯一事实源，禁止再用 OTA JSON 字段做读时版本修补。
- 远程配置交付契约固定为：

```json
{
  "policy": {
    "remoteConfigDelivery": "startup",
    "activation": "next_start",
    "backgroundPolling": false
  }
}
```

- 不加 WebSocket 推送、不做后台轮询、不在用户运行中的活跃会话里静默替换 provider/model/key。新包首启可在固定 4 秒启动窗口内最多重试一次完整的 auth lease + bootstrap 事务，每次必须重新取得 generation/authority 租约；只有在窗口内返回的传输/超时或 5xx 允许重试，401 立即停止并按 exact CAS 清理，其他 4xx、无效响应和本机状态错误不重试，超过窗口后只能由用户显式重验。桌面 bootstrap HTTP timeout 固定为 75 秒，为服务端最多三轮、每轮 20 秒的能力探测及运行时地址解析留出余量；响应（含错误正文）按 4 MiB 有界读取，正文传输失败与 JSON 解码失败必须分开分类。不得再用 1.5 秒短超时把有效会话永久留在待验证。
- 桌面登录 token 只使用 `echolike.v2.authToken`；改认证链路时要同时考虑主窗口、工作台、设置页和 Markdown 编辑器窗口。

## 4. 前端规范

- UI 以桌面工具为主：紧凑面板、稳定控件高度、清晰状态、少装饰。不要做营销式 landing page 或大面积说明文案。
- 设置页 composition 在 `src/components/Settings/ControlPanel.tsx`；认证、连接测试、诊断、OTA 与配置持久化分别由同目录既有 hook/协调器拥有，`*SettingsPanel.tsx` 只消费 view facts 与 actions，不得直接读 Store、调用 Tauri 或取得 task lease。有固定归属面板的操作只允许一个 Store-backed panel notice，不得再同时发送 toast 或从持久 outcome 复述同一句；notice 在所属面板首次实际显示后统一计时消失。错误/成功提示使用 panel header 的 alert slot，不要塞进输入框或操作按钮组；诊断、OTA 等已有专用结果面的操作由结果面独占。
- 用户反馈由当前可见 surface 独占：胶囊状态、教程 callout、设置 panel、OCR/Markdown dialog 与独立窗口分别呈现自己的结果；共享 Tauri 事件监听器只负责归一化并写入状态，不得无条件向每个 WebView 广播展示型 toast。成功动作若已通过新窗口、内容更新或持久结果面明确可见，不再重复 toast；异步错误必须留在任务所属结果面，不能在页面卸载后迟到到其他路由。
- 需要图标时优先使用 `lucide-react`，不要手写重复 SVG。
- 主窗口必须在 native WebView 创建前按主显示器逻辑工作区确定启动尺寸：理想上限为 `1180×820`，小屏在工作区总计预留 `48px` 后缩小，硬下限 `520×340` 同时供程序化 OTA 紧凑窗口使用；显示器查询失败时使用配置中的 `1180×820`。禁止在 renderer 创建后补 resize，也不按 RDP、设备类别或延时探测分支改写尺寸；布局敏感改动仍须检查普通桌面与高 DPI 显示效果。
- Windows 主窗口的物理裁剪和圆角只由原生 window region 拥有；CSS 只允许在贴满视口的主表面上绘制一条向内的主题边界，并由正常 shell、boot、OTA 与主窗错误页共用。OTA 内容 dialog 不得重新取得窗口级 border/radius/shadow，也不得用 padding 或透明 gutter 制造第二轮廓；Markdown 与胶囊继续使用各自独立的单一边界。
- 文案必须是 UTF-8。当前部分历史中文字符串存在编码损坏，新增或 touched 文案不得继续引入乱码；修改相关区域时优先顺手修正用户可见文案。
- TTS 播放依赖 blob URL。Tauri CSP 必须保留 `media-src 'self' blob: data:`，否则“朗读测试”和结果朗读会失败。
- OCR 上传入口支持 PNG/JPG/WebP/BMP 图片和 PDF，前端与 Rust 双层上限均为 25 MB；Rust 必须按文件 magic 验证真实格式，不得把任意 `image/*` 或伪 PDF 送入识别链。文件转 base64 统一走 `src/lib/filePayload.ts`，不要在组件里重复实现读取逻辑。
- Windows 本机 `glm-ocr` 使用桌面 Rust 进程自有的编排链：图片先走版本化 Router 并按 `direct / tile / pipeline` 处理，PDF 原文件直接走官方 Pipeline artifact；不得依赖 Paseo daemon、WebSocket 或 `6767/6768`。图片 Router、PDF Pipeline 与模型能力必须分别探测和门禁，部分组件故障不得把仍可用的路径一并禁用；PDF 最多处理 20 页，结构化分页 artifact 缺失、损坏、全空或触及 21 页哨兵时 fail-closed，少量合法空白页在仍有正文时保留页数并以 warning/degraded 明示。当前 Router 未提供可验证的跨分块拼接契约，因此 `tile` 结果必须提示核对分块边界，不得标成无损完整结果。
- 后台托管 OCR 的旧 `/proxy/ocr` JSON 路由继续兼容 `0.2.3` 单图片/分页请求，但服务端必须以解码后 25 MiB 为上限、自行按 magic 推导真实 PNG/JPEG/WebP/BMP MIME，并要求 v2 客户端显式声明与 magic 一致的 MIME；认证、授权、频率限制及单用户 1 / 单进程 4 的共享在途门禁必须先于大 JSON body reader。provider 响应须在完整 deadline 内有界读取并检查终止原因，错误保留 `service/status/code/requestId`，成功结果透传 `route / processingReason / warnings / degraded / pageCount`。旧客户端或未协商文档契约的 Windows 客户端继续最多 20 页栅格化后逐页代理，结果必须明确标记为 `client-rasterized/direct/degraded`，不得伪装成服务端 Pipeline；本机 provider 的 endpoint/model 探测失败时，无论客户端是否协商文档契约，Bootstrap 都不得宣称图片或栅格化 PDF 可用。
- WSL 内的 Server 访问 Windows Ollama 时，provider registry 只保存产品逻辑地址 `http://wsl-host.echolike.invalid:11434/api/generate`，不得保存会随 WSL 启停漂移的 NAT 网关 IP。每次取得共享本机推理锁后才解析运行时地址快照：mirrored 模式固定 `127.0.0.1`，NAT/virtioproxy 从 `/proc/net/route` 的唯一最低 metric 私网默认路由解析；非 WSL、未知模式、歧义/畸形路由或错误协议、端口、路径、userinfo/query/fragment 均 fail-closed。一次图片请求及其 500/503 重试必须固定同一已校验 transport 地址，下一次操作才可采用新网关；普通云 provider 继续使用原出口策略，不得被该逻辑地址改写。
- 原始 PDF 后台链固定为独立 multipart `POST /proxy/ocr/document`，只接受一个 `document` 字段、25 MiB 有效 PDF 与最多 20 页；客户端通过 Bootstrap query `docContracts=ocr-document-v1` 声明能力，服务端仅在当前 provider 为本机 `ollama-ocr-local`、模型为 GLM-OCR 且 provider/Pipeline 分层探测均通过时返回 singular `documentContract=ocr-document-v1`、`pdfMode=server-pipeline` 与 `pipeline` route；provider 正常但 Pipeline 缺失时 Windows 显式保留 `client-rasterized`，provider 不可用时两条路径均关闭。服务端用 PyMuPDF 在额度预占和 GPU 推理前可信计页，按“额度可用检查 → 等待共享本机推理锁 → 在锁内重新解析/探测运行时 → 原子预占真实页数 → Pipeline → commit/release”执行；图片 direct 与 PDF Pipeline 共用该锁。
- PDF Pipeline 只能收到 Server 在 `127.0.0.1` 临时监听的随机 token relay，不得接触 provider URL；relay 必须固定同一已校验 Node transport/model，限制请求/响应大小、禁止 redirect、把 GLM-OCR 上下文强制为 16384，并仅允许官方无图片 warmup 的短输出与带图片请求的非空 `done=true/done_reason=stop`。relay 必须分别记录 warmup、正式图片请求、完整结束、非空/空响应、活动请求与不可逆 fatal 证据；任一裁块的状态、JSON、完成原因、空响应、传输或客户端生命周期失败，即使外部 Pipeline 吞错并写出看似合法的部分 artifact，也不得交付或计费。
- Pipeline 必须由已配置且验证可执行的 Python 以 `-m glmocr` 启动，不得信任可能指向另一虚拟环境的 CLI shebang；正式任务关闭 formatter 的公式编号与跨块连字符合并，使 `input_model.json` 的原始区域与 `input.json` 的最终区域可按页、原生 label、bbox 与顺序严格双射。Server 只有在正式请求数、完整非空响应数和 raw 可识别区域数完全一致后才接受主体结果；raw/final 缺失、损坏、页数或区域不符、全空、输出过大或触及 21 页哨兵均 fail-closed。
- 对官方固定跳过的 `chart/image` 区域，Server 从最终 artifact 的 `imgs/` 裁图生成同一任务内的恢复计划：只接受单层安全相对路径、普通单链接文件、匹配的 JPEG/PNG/WebP magic 及数量/单文件/总字节上限；相互覆盖至少 90% 的候选只保留最大区域，其他非重叠区域按原顺序经同一 relay、冻结 target、16K context、共享推理锁、deadline 与取消信号识别。恢复结果按稳定候选 ID 回填并标记 warning/degraded；只有被恢复文本实际包含且几何覆盖至少 90% 的普通 text 区域才去重，table/formula 始终保留。任一恢复失败仍导致整份 PDF 失败并释放原页数预占，禁止静默 direct fallback。少量 raw 为空的合法空白页可在其他页有正文时保留页数并降级提示。
- worker 继续由服务端自有的 WSL/Linux 原生进程组、deadline、TERM/KILL、退出确认、输出上限、唯一 job 与安全清理管理；未确认进程树退出时熔断后续本机推理并保留 job。协商后的 Pipeline 执行失败不得静默回退 direct。
- 当前 `%USERPROFILE%\.local\bin` Windows→WSL CLI 仅是主机已配置环境的过渡 adapter，不是 EchoLike 公共安装契约，在 EchoLike 自有 WSL supervisor/取消确认落地前不得纳入安装包或 OTA。公开分发前必须改为 EchoLike 自有、签名且可迁移的 runtime descriptor/安装链，解决 WSL 发行版与用户发现、进程组取消、运行时升级/卸载及 Router/PyMuPDF 等许可证义务；不得把 Paseo 管理的 wrapper、硬编码用户路径或 daemon 生命周期打进 EchoLike 安装包。过渡 adapter 没有可靠的 WSL 进程组取消协议，因此真实 OCR 不得用只终止 Windows launcher 的外层超时提前解锁任务。
- Markdown 编辑器草稿通过 localStorage 保存活动草稿和最近未保存草稿。改草稿结构时同步 parser/serializer 和测试。
- 用户可见错误统一走 `src/lib/userErrors.ts` 归一化；后端结构化错误要保留 service/status/code/requestId，方便诊断。
- Home/Settings 切换会卸载页面组件，跨页异步任务不得只使用组件局部 busy/result。当前统一修复方案、优先级和测试门禁见 [异步任务生命周期统一修复计划](2026-07-12-async-task-lifecycle-repair-plan.md)，修改 OCR、问答、设置操作、诊断、OTA 或编辑器异步链路前必须先读该计划。

## 5. Tauri/Rust 规范

- Tauri command 的实现按领域放入 `commands/`、`process_ownership.rs`、窗口模块或其他唯一所有者，`src-tauri/src/lib.rs` 只保留三个薄录音 adapter、唯一 `run()`、可审计 setup 顺序和完整 `invoke_handler` 注册表。新增或改名 command 必须同步唯一实现、`commands/mod.rs`（适用时）、`lib.rs` 注册、`src/lib/tauri.ts` bridge 与契约测试；不得把业务实现写进注册表。
- 配置、历史、词典和 bootstrap cache 由 Tauri 本地存储管理。不要在前端绕过 Tauri 直接写桌面端持久化文件。
- 网络请求统一经过 `network::NetworkClient`，必须尊重配置里的代理开关和代理 URL。
- 全局热键、胶囊、托盘、close-to-tray、start minimized 都由 Rust 壳管理。改配置保存时要同步相关缓存或系统状态。
- macOS 辅助功能、Linux X11/NVIDIA workaround、Windows 音频/窗口能力都是平台边界；跨平台改动要避免只在当前 Windows 环境验证。
- Rust 返回给前端的错误字符串必须可读、可诊断。不要返回空错误或吞掉 HTTP body；代理错误优先保留后端 code/requestId。
- 录音状态只有在原生输入流收到首个非空 callback、音频 owner 仍匹配当前 generation 且 handle 已提交后，才允许通过 `pipeline:state` 公开为 `Recording` 并开始 UI 计时；仅成功创建线程或设备流不算麦克风可用。停止录音必须先等待 capture worker 退出、显式关闭 PCM 通道并固化帧数/字节数/峰值/故障统计，再决定 STT finalize；无帧、静音、队列溢出和设备故障必须保持不同错误语义，无效音频不得进入后台代理或文件型 STT 的最终推理。

## 6. 后端规范

- 后端进程入口是 `server/src/index.ts`；`server/src/app.ts` 是 Hono composition root 与 route-spec 权威，不是领域 handler 实现文件。业务/Admin API 的权限、body limit、rate limit、in-flight、审计和控制面板消费关系必须在对应 route spec 中声明；health/ready、webhook、update、bootstrap、Better Auth 与 panel 在 `createApp()` 显式 mount，并保留独立门禁和契约测试。handler 落在 `routes/`，领域逻辑落在 `services/`，PostgreSQL 实现按既有领域 store 落在 `db/postgres/` 或专用 `db/admin-insights.ts`，`db/client.ts` 只作连接与兼容 facade。
- 访问层级只有 `public`、`internal`、`auth`、`pro`、`admin`。新增业务接口不得绕开 `businessRouteSpecs` 或 `adminRouteSpecs`。
- `public` 路由只用于健康检查、认证入口、Stripe webhook、OTA/update/bootstrap 等明确公共能力。业务读写默认必须登录。
- `pro` 路由由 entitlement 和 quota 控制。代理接口允许后端 operator 场景，但不能扩散到普通业务接口。
- 控制面板 `/echo-panel/` 必须登录并通过 PostgreSQL-backed `admin_account` 授权。首个 owner 只能用 `npm run admin:promote --prefix server -- --email ...` 提升，不提供 HTTP 后门。
- 管理台浏览器只使用同源 Better Auth Cookie，不在 localStorage 保存 Bearer token；所有管理 API 继续支持明确 Bearer 自动化，但 Cookie 写请求必须通过同源 Origin/Sec-Fetch-Site 门禁。`viewer / operator / admin / owner` 由服务端 capability 矩阵授权，前端隐藏按钮不能替代路由权限检查；控制写入、权限二次确认与审计必须在同一 PostgreSQL 事务内，缺失或失效的 actor control context 一律 fail-closed。
- 控制面板用户列表必须使用服务端搜索与稳定 cursor 分页，默认每页 25、最大 100；不得一次拉取全部用户，也不得在额度、角色和配额表单中复制多份全量用户下拉。密码自助修改必须校验旧密码并接管 Better Auth 重新签发的 session；管理员重置只允许 owner/admin 操作他人账号，admin 不得重置 owner，成功后必须在同一事务中撤销目标用户全部 session，审计和响应不得包含密码或哈希。
- 环境变量由 `server/src/env.ts` 解析。生产环境拒绝 placeholder secret；`PUBLIC_API_BASE_URL` 必须带 public mount path，例如 `https://api.example.com/echo-api`。
- provider registry 和 provider presets 是后端托管服务源头。新增 provider 要同步 preset、配置校验、proxy 实现、panel 展示和测试。
- 管理台保存 provider 前必须经过服务端出口策略：只允许产品 preset 声明的协议/来源，解析地址逐项拒绝 loopback、私网、链路本地和保留网段；请求绑定已验证 IP 与原 Host/SNI、禁止 redirect 并限制响应字节数。provider 与 OTA 控制记录使用 revision CAS，旧页面不得覆盖新状态。
- provider API key 只保存在后端。bootstrap 的 `apiKeyPreview` 只允许返回固定的 `configured` 状态，不得返回真实 key 或任何前后缀片段。
- 后端 scene packs 是 prompt/preset 的长期来源；桌面端只允许少量离线 fallback，不 fork 长期 prompt 定义。

## 7. 配额与订阅

- 订阅边界只保留 `free` 和 `pro`，不要为了临时提额增加新 plan 名。
- 长期配额倍率属于 `user_quota_profile.quota_level`，等级 `Lv.1` 到 `Lv.5`，倍率作用于当前 plan 的 STT、LLM、OCR、TTS 月度限制。
- 手动 quota adjustment 是账本修正，用于一次性补偿或修复，不作为长期等级来源。
- 代理调用必须遵循 reserve、upstream call、commit/release 的账本流程。失败时释放预占，流式 LLM 完成后再提交。
- Stripe webhook 的 event marker、customer 映射和 subscription mutation 必须处于同一事务；按 customer 获取事务 advisory lock 后，subscription 事件在锁内通过 Stripe API 读取当前权威快照，不按 event ID 字典序猜测同秒先后。customer→user 映射建立后不可被晚到 checkout 跨用户改绑，失败事务不得留下 processed marker。
- `x-request-id` 只用于单次 HTTP 追踪；可计费的 LLM、STT、TTS、图片 OCR 与文档 OCR 必须另用 `x-idempotency-key` 表示一次用户操作，禁止再把追踪 ID 当作重试身份。相同操作的传输重试必须复用同一 key；用户在结果交付后再次主动执行相同内容必须取得新 key。
- 服务端按 `user + idempotency key` 唯一保存 `reserved / completed / released` 操作，使用带 payload HMAC 的身份校验、有限 lease 与 token fencing；预占、最终 adjustment、响应缓存和状态迁移必须处于同一事务。已完成响应在短期加密缓存内原样 replay，缓存过期后保留 completed tombstone 并返回明确的 410，绝不因重试再次调用 provider。PDF 文档重放必须先于 runtime probe、临时文件和 Pipeline。
- 桌面端只持久化尚未 ACK 的随机 operation root，并按后台地址与登录会话隔离；服务端成功结果被当前 Store lease 接受、写入原生 owner/history 或原子保存为本地文件后才 ACK。ACK 失败不得把已交付成功改成失败，也不得泄漏 TTS/OCR owner；根键继续留作下次恢复。PDF 分页与朗读分段必须由 root、子项序号和子项内容派生稳定 child key，避免只完成一部分时重复计费已成功子项。
- 后端进程不会自动执行数据库 migration。部署包含 schema 变更的 Server bundle 前，必须先按 `server/src/db/migrations/meta/_journal.json` 顺序应用全部待执行 SQL，并在切换服务前验证新表、约束和索引；禁止用启动失败来试探生产 schema 是否已就绪。

## 8. OTA 与发布

- Windows 桌面版最低支持 Windows 10 x64 / Windows Server 2016 x64。Windows 7、Windows 8/8.1、Windows Server 2008 R2 与 Windows Server 2012/R2 不受支持；NSIS 必须保留 `src-tauri/nsis/minimum-windows.nsh` 的前置门禁，在 WebView2 bootstrapper 启动前显示兼容性说明并退出。普通 offline WebView2 installer 不能作为旧系统兼容方案。
- 每次 OTA 构建/发布前必须先运行 `git status --short`。本任务所属的源码、版本号、配置和 worklog 必须先本地提交，默认应达到全仓 clean；OTA 请求视为授权为该门禁提交本任务自己的改动，但绝不授权 Git push。
- 如果 dirty worktree 只包含用户或其他 agent 的改动，不得擅自提交、回滚、stash、移动或隐藏。这是允许继续 OTA 的唯一 dirty 例外，不能仅因这些外来改动中断构建或发布。
- 在上述例外下可以按当前工作树继续打包；开始构建前必须在根目录 `WORKLOG.md` 逐项记录外来改动路径、已知归属、是否预计进入产物。发布后补记实际纳入情况、验证结果和风险。
- OTA 的“clean 门禁”至少要求本任务自身不留未提交改动。若仍有外来 dirty 文件，最终交付必须明确披露，不能把工作树描述为 clean。
- 当前版本号必须同步在 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 的 `echolike` 包记录。
- OTA 更新由 Tauri updater 插件消费签名 manifest。不要回退到未签名下载链接或自定义 side-channel 安装。
- 管理台 OTA 记录必须先保存为停用草稿，再按 revision CAS 校验/启用。激活前从 `PUBLIC_API_BASE_URL` 的 origin 派生固定 `/echo-panel/ota/` 前缀，禁止 redirect，流式核对声明长度、上限、SHA-256、Tauri Minisign 双签名和 Windows NSIS 版本资源；生产必须配置与桌面 updater 相同的 `TAURI_UPDATER_PUBLIC_KEY`。x64 NSIS 的外层 launcher 是 PE32/i386，不能把外壳 machine 字段误当成内嵌主程序架构证明。
- Windows OTA 的 tray 生命周期只依赖 Tauri updater 内建的 Rust 退出清理：tray 句柄只能由 Tauri manager 持有，不得再放入 app state 或其他长生命周期引用；前端不得通过隐藏/恢复托盘、延时或平台分支来猜测安装器时序。
- OTA 检查端点固定为：

```text
https://api.example.com/echo-api/app/update/tauri?version={{current_version}}&platform={{target}}&arch={{arch}}&channel=stable
```

- 普通状态检查端点是 `https://api.example.com/echo-api/app/update`；bootstrap 端点是 `https://api.example.com/echo-api/desktop/bootstrap`。
- OTA artifact 公共前缀固定为：

```text
https://api.example.com/echo-panel/ota/
```

- 对应 WSL/nginx 静态目录固定为 `/srv/echolike/ota/`。不要换前缀发布。
- 构建脚本是 `scripts/build-desktop.ps1`，会设置 `CARGO_TARGET_DIR=src-tauri/target-codex-check`、更新检查 URL、bootstrap URL，并从 `TAURI_UPDATER_PUBLIC_KEY` 注入临时 Tauri 配置；公钥、私钥和密码都不得写入源码。
- 用户说“发版 OTA”时，默认含义是只构建 NSIS 在线 WebView2 安装包并发布到 public OTA；不要同时打离线包。只有用户明确要求“离线版”“完整离线安装包”或“双版本”时，才使用 `-WebView2 offline/both`。
- 只打 OTA 用：

```powershell
npm.cmd run build:desktop:ota
```

该命令只构建 NSIS online WebView2 bundle。完整桌面包才使用：

```powershell
npm.cmd run build:desktop
```

- 正式公网 OTA 发布统一使用 [Windows 桌面 OTA 正式发布工具](desktop-ota-release-tool.md)，不要再临时拼接 WSL root 或生产控制面 helper：

```powershell
# 默认 Prepare：只构建、签名和生成 manifest，不写生产
npm.cmd run release:desktop:ota -- -Version <x.y.z> -ReleaseNotesFile <utf8-no-bom.local>

# 检查 manifest 后，从同一产物恢复并完成静态发布、disabled 草稿、CAS 激活、收敛和公网验收
npm.cmd run release:desktop:ota -- -Version <x.y.z> -ReleaseNotesFile <utf8-no-bom.local> -Stage All -Publish -Resume
```

生产写入阶段必须显式提供 `-Publish`；manifest 绑定源码 commit、production API 身份、公共 baseline、说明、长度、SHA 和签名，`-Resume` 只允许产品源码未变化时跳过重复构建。正式工具的 WSL 静态发布器与控制面 CLI 是发布安全边界，修改后必须跑其故障注入测试和独立审计。

- 当前 NSIS OTA artifact 位置是 `src-tauri/target-codex-check/release/bundle/nsis/EcholIKE_<version>_x64-setup.exe`，签名文件是同名 `.sig`。
- 中文 `releaseNotes` 必须从 UTF-8 文件或等价的无损输入写入；禁止把含中文的 PowerShell here-string 通过管道送入 Node stdin。发布后要逐字检查普通更新接口与 Tauri manifest，不能只检查字段非空。
- 发布后至少验证：后端 `/echo-api/healthz`、旧版本到新版本有更新、当前版本无更新、Tauri manifest 非空或 204 符合预期、artifact HEAD 200、bootstrap 只暴露状态和 download availability、不泄露后台真实下载管理信息。

## 9. 本地命令

前端：

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run format:check
```

后端：

```powershell
npm.cmd --prefix server test
npm.cmd --prefix server run typecheck
npm.cmd --prefix server run build
```

桌面/Rust：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
npm.cmd run build:desktop:ota
```

通用检查：

```powershell
git diff --check
```

- 迭代时跑最窄的有效检查；发布、跨模块、用户可见功能改动再跑更完整的矩阵。
- 文档-only 改动不需要跑耗时桌面编译。

## 10. 当前部署约定

- 后端运行在 WSL 内，仓库 `server` 目录构建后以 `node dist/index.js` 启动，默认端口 `8787`。
- nginx 代理 `/echo-api/` 和 `/echo-panel/` 到同一个后端进程，不能丢失 `Authorization` header。
- `/echo-panel/ota/` 是静态 OTA artifact 目录，不走业务 API。
- 如需在 WSL 内使用 root 权限，优先用 `wsl -u root`，并在最终回复里记录做过的 root 操作。
- 从 Windows 调 WSL 执行长命令时要注意引号；复杂命令优先写成 `.ps1` 或拆成清晰的小命令。

## 11. 测试矩阵

- 前端 store、启动、Tauri bridge、设置页和 Workbench 行为使用 Vitest 覆盖。
- 后端 route/auth/quota/provider/bootstrap/update 使用 server tests 覆盖。新增业务 route 必须纳入 `businessRouteSpecs` 或 `adminRouteSpecs`，并由测试覆盖访问层级、限流及 body/in-flight 边界；公共 route 必须有独立契约测试。
- Tauri/Rust 改动至少跑相关 Rust 单测；影响更新、网络、OCR、TTS、热键、存储时补充前端 bridge 测试或后端代理测试。
- 朗读/TTS 相关改动必须同时验证：后端 `/proxy/tts` 返回非空音频、桌面 `proxy_tts_once` 正确拿到 bytes/mime、前端 blob 播放不被 CSP 拦截、诊断结果显示 requestId/code。
- OTA 相关改动必须验证旧版本更新、新版本无更新、签名 manifest、artifact 可访问、CSP 没有破坏 update/bootstrap/connect/media。

## 12. 禁止事项

- **Git 远端红线（最高优先级）**：除非用户在当前任务中明确授权，否则禁止执行 `git push`、强制推送、推送 tag、修改/新增/删除 remote，或通过脚本、CI、发布流程间接触发上述操作。本地 `git add` / `git commit` 授权不等于远端推送授权；“发版”“发布 OTA”也不等于 Git 推送授权。详见 [工程红线卡](red-line-card.md)。
- 不得在发生改动、新增、部署或发布后漏写根目录 `WORKLOG.md`，也不得破坏最新在前的倒序结构。
- 不得为了制造“仓库 clean”的表象而提交、回滚、stash、移动或隐藏用户/其他 agent 的改动。
- 不把真实 provider key 写入前端、bootstrap cache、日志、诊断报告或控制面板列表。
- 不新增未声明权限边界的后端业务 API。
- 不把远程配置改成后台轮询或运行中静默生效，除非先改规范和源码契约。
- 不把 status badge、错误提示混入设置行的输入/按钮组；遵守 panel header alert slot。
- 不把 OTA artifact 发布到新的 public prefix。
- 不用 `build:desktop` 代替 OTA 快速验证，除非确实需要 NSIS + MSI 全量包。
- 不在未确认用户改动来源时回滚 dirty worktree。
- 不用破坏性 git 命令清理环境。

## 13. Worklog 与交接规范

- 全项目只使用根目录 [WORKLOG.md](../WORKLOG.md) 作为当前统一改动台账；旧的日期化日志保留作历史资料，但新任务不得继续分散创建独立 worklog。
- 任何源码、配置、脚本、文档、资源、部署状态或发布状态的改动/新增，都必须在同一任务中创建或更新一条 worklog。
- worklog 严格倒序维护。新任务条目插在固定说明后、旧任务前；同一任务的测试、部署、提交、OTA 结果回写原条目。
- 日志采用 `YYYY-MM-DD HH:mm - 简短说明` 标题和 2～4 个按需小节。普通任务只需写清改动、验证和必要边界；复杂排障、部署、OTA 或异常再补充关键证据，不使用固定冗长模板。
- 内容应简洁但可追溯，不重复用户原话，不机械罗列无关文件或“未发生”的固定字段。提交、部署、OTA、外来 dirty 改动等信息只在相关时记录。
- 普通任务默认格式如下；复杂任务才按需增加“根因与修复”“发布”“残余风险”等小节：

```markdown
## YYYY-MM-DD HH:mm - 简短说明

### 改动

- 关键改动。

### 验证与边界

- 验证结果及必要边界。
```

- 若存在非本任务改动，逐项记录文件路径、已知归属、是否被提交、是否进入构建产物及如何验证；归属不明时明确写“未知”，不得猜测或据此篡改文件。
- 日志不得包含凭据和密钥。需要记录配置时只写字段名、掩码或“已配置/未配置”。
- worklog 是任务完成条件，不是事后可选补充；在最终交付、部署或 OTA 发布前必须补齐实际结果。

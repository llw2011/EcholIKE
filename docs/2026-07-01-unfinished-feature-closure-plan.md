# EcholIKE 未完成能力收口计划

日期：2026-07-01

## 背景

本计划用于收口当前源码中已经露出入口、后端能力或文档承诺，但尚未形成完整产品链路的功能。

当前优先级不是继续堆 UI，而是把链路统一、删掉旧路径、补齐状态恢复和验收测试。桌面端仍保持本地优先；服务端配置只做单向下发，不做常驻轮询。

## 推进记录

- 2026-07-02：Phase 1 已开始推进。旧的 Rust 下载/打开安装包命令已从 invoke handler 移除，前端 `downloadOtaUpdate` facade 已移除；关于页更新卡片开始记录 Tauri updater pending 状态，并在重启后按当前版本清理或提示继续更新。
- 2026-07-02：Phase 2 已开始推进。`/desktop/bootstrap` 支持未登录返回 OTA、功能开关与非敏感 provider 策略；桌面端启动时无 token 也会同步后台策略，设置页新增“后台策略”手动同步入口。
- 2026-07-02：Phase 3 先完成产品诚实收口。设置页不再展示尚未接入 runtime 的“实时翻译”入口，避免把未闭环能力伪装成可用；后续实现 partial STT -> LLM streaming 后再恢复入口。
- 2026-07-02：Phase 4 已开始推进。首页主流程在后台 TTS proxy 可用时展示“朗读结果”和“朗读回答”，音频只走 `/echo-api/proxy/tts`，客户端请求体不携带 provider/key/baseUrl/model。
- 2026-07-02：Phase 5 已开始推进。新增后台 OCR proxy 和 echo-panel 配置入口，首页“AI 看窗口”和“问一个”会优先使用后台 proxy 策略，未启用或无登录 token 时回退本地/BYOK 链路；OCR provider key 不下发到桌面端。
- 2026-07-02：Phase 6 已开始推进。后端新增统一 provider preset，echo-panel 下拉、bootstrap 展示和 proxy resolver 共用同一份支持范围；`proxy` 模式会拒绝 preset 外的 provider。
- 2026-07-02：Phase 7 已开始推进。桌面端继续不暴露账号、订阅、备份入口；用户可见的“先登录”提示改为后台令牌/策略状态提示，README、SUPPORT、CONTRIBUTING、SECURITY、CHANGELOG 改为 EcholIKE 当前产品口径，旧品牌仅保留在 LICENSE/NOTICE 法律归属说明中。

## 总原则

- 后端单向下发：echo-panel 负责配置 provider、OTA、功能开关；桌面端只在启动、手动同步、OTA 后重新拉取。
- 不做 6-12 小时轮询，不做后台长连接推送，避免给客户端增加常驻负担。
- 有密钥下发时必须满足两点：桌面 UI 只展示脱敏值；用户手动保存自己的 key 后，回读仍只展示脱敏值。
- OTA 只保留一条正式更新路径：Tauri updater。旧的下载 exe 后打开安装包路径必须废弃。
- 强制更新只锁主功能，不锁“更新”和“退出”。
- 未真正可用的能力不在 UI 中伪装成已完成；要么隐藏，要么标明未启用。

## 当前未完成清单

### 1. OTA 双链路与 pending 状态未收口

现状：

- Tauri updater 已接入。
- 旧的 Rust 命令仍存在：`download_ota_update`、`download_and_install_ota_update`。
- 前端仍暴露旧的 `downloadOtaUpdate`。
- “检查更新”读取旧 JSON 策略，安装动作读取 Tauri updater manifest，存在双源头风险。
- pending update、异常退出恢复、安装成功清理尚未完整落地。

目标：

- 更新检查、下载安装、重启替换都走 Tauri updater 主链路。
- 旧下载/打开安装包命令从 invoke handler 和 TS facade 删除。
- 下载/安装中禁止重复触发。
- 本地持久化 update pending 状态，异常退出后可恢复提示。
- 更新成功启动后清理 pending 状态。

涉及文件：

- `src-tauri/src/commands/update.rs`
- `src-tauri/src/lib.rs`
- `src/lib/tauri.ts`
- `src/components/Settings/ControlPanel.tsx`
- `src-tauri/tauri.conf.json`
- `server/src/routes/app-update.ts`
- `server/src/services/desktop/desktop-config-service.ts`
- `docs/desktop-config-ota-release-policy.md`

验收：

- 无更新时点击检查不报错。
- 有更新时只出现一个更新动作入口。
- 重复点击不会发起多个下载/安装。
- 强制更新时首页主功能锁定，但设置页更新入口可用。
- 关闭/崩溃后重开，仍能识别 pending 更新状态。
- 旧 `download_ota_update` / `download_and_install_ota_update` 不再被导出或调用。

## Phase 1：OTA 收口

### 1.1 删除旧安装路径

动作：

- 删除或私有化 `download_ota_update`。
- 删除或私有化 `download_and_install_ota_update`。
- 从 `tauri::generate_handler!` 移除旧命令。
- 从 `src/lib/tauri.ts` 移除 `downloadOtaUpdate`。
- 保留 `check_ota_update` 仅作为非安装策略展示；如能合并到 updater check，则继续缩短。

### 1.2 统一前端状态机

状态：

- `idle`
- `checking`
- `current`
- `available`
- `downloading`
- `readyToRestart`
- `installing`
- `failed`

动作：

- 按钮根据状态禁用。
- `checking/downloading/installing` 期间不可重复点击。
- 不在按钮下方额外冒出更新结果行；更新信息保持在同一张更新卡片内。

### 1.3 pending update 本地持久化

建议存储：

```json
{
  "version": "0.1.10",
  "status": "readyToRestart",
  "checkedAt": "2026-07-01T00:00:00.000Z",
  "source": "tauri-updater"
}
```

动作：

- 下载/安装准备完成后写入 pending。
- 启动时读取 pending。
- 当前版本大于等于 pending.version 时清理。
- pending 与服务端策略冲突时，以当前版本和最新服务端策略重新计算。

## Phase 2：后台配置下发链路收口

现状：

- `/desktop/bootstrap` 需要认证。
- 桌面端只有 localStorage 中存在 `echolikeAuthToken` 或 `echoAuthToken` 时才会拉取。
- 桌面端没有完整登录/设备绑定入口。
- `bootstrapConfigPatch` 只把 `direct` 模式 provider 写入本地配置；`proxy` 由 pipeline 读取缓存策略使用。

目标：

- 非敏感策略可稳定下发：功能开关、OTA、provider 显示名、脱敏 key、模型列表。
- 敏感 key 仅在后端明确允许、且客户端具备认证/设备令牌时下发。
- 桌面端增加“同步后台配置”按钮，仅手动触发，不做周期轮询。
- 启动和 OTA 后自动同步一次；失败时继续使用本地配置或缓存。

设计：

- `/desktop/bootstrap` 保持认证版本，用于可能包含密钥或 proxy 权限的完整策略。
- 另加非敏感 bootstrap 或让现有接口在未认证时返回只读策略：OTA、features、provider 名称、脱敏状态，不返回完整 key。
- 桌面端设置页显示：
  - 后台策略状态：未连接 / 已同步 / 缓存中 / 同步失败。
  - 服务商状态：后台托管 / 用户自备 / 本地。
  - key 回显：只展示脱敏，不展示完整 key。

涉及文件：

- `src/App.tsx`
- `src/lib/desktopBootstrap.ts`
- `src/components/Settings/ControlPanel.tsx`
- `src-tauri/src/commands/update.rs`
- `src-tauri/src/storage/mod.rs`
- `server/src/routes/desktop-bootstrap.ts`
- `server/src/routes/admin.ts`
- `server/src/routes/admin-panel.ts`

验收：

- 未登录客户端也能拿到 OTA 与非敏感功能开关。
- 登录或设备令牌有效时，可以拿到后台允许下发的 provider 策略。
- UI 不显示完整 key。
- 用户手动输入自己的 key 并保存后，回读仍只显示脱敏。
- 点击“同步后台配置”只触发一次请求，不产生轮询。

## Phase 3：实时翻译

现状：

- “结束后翻译”可用。
- “实时翻译”设置项存在，但标记为未启用。
- 本地 STT 有 partial 事件；proxy STT 当前是录音结束后一次性上传。
- LLM proxy 支持 streaming，但还未形成 partial STT -> streaming translation 的产品链路。

目标：

- 把“结束后翻译”和“实时翻译”彻底区分。
- 实时翻译仅在 STT partial + LLM streaming 都满足时启用。
- 不满足条件时隐藏或明确显示“后台未启用”。

实现路径：

- 第一阶段只支持本地/具备 partial 的 STT provider。
- 第二阶段再做 proxy STT partial streaming。
- LLM streaming translation 通过 `llm:chunk` 增量渲染。
- 增加节流，避免每个 partial 都触发一次 LLM 请求。

涉及文件：

- `src-tauri/src/pipeline.rs`
- `src-tauri/src/stt/*`
- `src-tauri/src/llm/*`
- `server/src/routes/proxy-llm.ts`
- `server/src/services/proxy/llm-proxy.ts`
- `src/hooks/useTauriEvents.ts`
- `src/components/Settings/ControlPanel.tsx`

验收：

- 支持 provider 下录音时能看到 partial 原文和增量翻译。
- 不支持 provider 下不显示可用开关。
- 结束后翻译不被实时翻译破坏。

## Phase 4：TTS 从测试进入主流程

现状：

- 后端 `/proxy/tts` 已有。
- 设置页只有朗读测试。
- 首页、历史、问答结果没有实际朗读动作。

目标：

- 后台启用 TTS 后，结果区出现朗读按钮。
- TTS 音频只通过后端 proxy 获取，不暴露真实 provider URL。
- 没启用 TTS 时不展示主流程按钮。

涉及文件：

- `server/src/routes/proxy-tts.ts`
- `server/src/services/proxy/tts-proxy.ts`
- `src/components/HomePage/Workbench.tsx`
- `src/components/Settings/ControlPanel.tsx`
- `src/lib/tauri.ts`

验收：

- 转写/润色结果可以一键朗读。
- “问一下”的回答可以一键朗读。
- 后台停用 TTS 后按钮消失或置灰。
- 请求体不接受客户端传入 provider/key/baseUrl。

## Phase 5：AI 看窗口与 OCR 云能力

现状：

- OCR 只走本地 Ollama。
- `cloudOcr` 固定为 false。
- 首页“问一下”走 BYOK/本地 LLM，不走后台 LLM proxy。

目标：

- AI 看窗口可选择本地 OCR 或后台 OCR。
- “问一下”优先使用后台 proxy 策略；没有后台策略时回落 BYOK/本地。
- 后端不把 OCR provider key 暴露给客户端。

涉及文件：

- `server/src/routes/desktop-bootstrap.ts`
- `server/src/services/proxy/provider-config.ts`
- 新增 `server/src/routes/proxy-ocr.ts`
- `src-tauri/src/commands/ocr.rs`
- `src/components/HomePage/Workbench.tsx`
- `src/components/Settings/ControlPanel.tsx`

验收：

- 后台开启 cloud OCR 后，桌面端能读取当前窗口文字。
- 后台关闭 cloud OCR 后，仍可使用本地 Ollama。
- “问一下”不再只依赖本地 BYOK。

## Phase 6：Provider 支持范围统一

现状：

- 前端可选 LLM provider 比后端 proxy 支持范围更大。
- 后端 LLM proxy 目前主要支持 OpenAI-compatible 的固定集合。

目标：

- echo-panel 的 provider 选择、后端 proxy 支持、桌面端显示三者一致。
- 不支持的 provider 不出现在后台可选项里，或必须显式标明“direct only / BYOK only”。

动作：

- 建立统一 provider registry preset。
- 每个 provider 标注：
  - `kind`: llm/stt/tts/ocr
  - `mode`: proxy/direct/byok/local/disabled
  - `supportsStreaming`
  - `supportsTranslate`
  - `supportsPartialStt`
  - `requiresApiKey`
- echo-panel 下拉框从同一份 preset 生成。

验收：

- 后台下拉框不再出现空白项。
- 选择 provider 后模型默认值能正确填充。
- proxy 不支持的 provider 不会被错误保存成 proxy 模式。

## Phase 7：桌面备份、订阅、品牌文档收尾

现状：

- 后端已有 backup、subscription、checkout、OAuth。
- 桌面端没有完整账号/备份/订阅入口。
- README、SUPPORT、CONTRIBUTING、LICENSE 等还有 OpenTypeless 残留。

目标：

- 明确是否保留桌面账号体系。
- 如果保留，补登录/设备绑定、订阅状态、云备份入口。
- 如果不保留，后端相关能力降级为 admin/运维能力，不在桌面 UI 暴露。
- 品牌文档统一为 EcholIKE。

验收：

- 用户不会在桌面端看到无法完成的登录/订阅/备份流程。
- 文档中不再出现旧品牌作为产品名。

## 推荐实施顺序

1. OTA 收口：最优先，因为它决定后续版本能否可靠自更新。
2. 后台配置下发：解决 provider/OTA/功能开关的真实消费链路。
3. 实时翻译：补齐已经露出的“未启用”能力。
4. TTS 主流程：把已有后端能力转成用户可用功能。
5. 云 OCR 与 AI 看窗口统一 proxy。
6. Provider registry 统一。
7. 账号、备份、订阅、品牌文档收尾。

## 每阶段必须跑的断言

桌面端：

```powershell
npm.cmd run test
npm.cmd run build
cargo check
```

服务端：

```powershell
npm.cmd test --prefix server
npm.cmd run typecheck --prefix server
npm.cmd run build --prefix server
```

发布前：

```powershell
npm.cmd run build:desktop
```

OTA 发布前额外检查：

- 构建产物存在。
- `.sig` 存在。
- echo-panel OTA release 填入 version、downloadUrl、signature。
- `GET /echo-api/app/update/tauri` 能返回 updater manifest。
- `HEAD /echo-panel/ota/<artifact>` 可访问。

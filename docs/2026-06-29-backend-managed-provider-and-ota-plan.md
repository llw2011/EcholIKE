# EcholIKE 后端下发 Provider 与 OTA 落地计划

## 目标

把 EcholIKE 从“桌面端自己保存 LLM/STT/OCR 配置”的形态，升级为“后端统一下发云能力策略，桌面端只消费策略与代理 API”的形态。

本计划覆盖：

- LLM provider 配置由后端统一管理与下发。
- STT、TTS、OCR 以同一套能力配置模型接入。
- OTA 更新策略由后端统一下发，桌面端不展示详细下载 URL。
- `echo-panel` 成为管理入口，`/echo-api/` 成为桌面端统一消费入口。
- 本地 BYOK / 本地模型仍保留为兜底与高级模式。

## 当前事实

项目已有后端服务目录 `server/`，Hono + Better Auth + PostgreSQL/Drizzle 已经落地。

公开路径形态已经在 `server/README.md` 固化：

- API：`/echo-api/`
- 管理面板：`/echo-panel/`
- 当前示例公开 API Base：`https://api.example.com/echo-api`

nginx 反代设计为不 rewrite：

```nginx
location ^~ /echo-api/ {
    proxy_pass http://127.0.0.1:8787;
}

location = /echo-panel { return 302 /echo-panel/; }
location ^~ /echo-panel/ {
    proxy_pass http://127.0.0.1:8787;
}
```

后端已有：

- `GET /echo-api/app/update`：OTA 检测策略。
- `POST /echo-api/proxy/llm`：后端 LLM 代理，已做鉴权、Pro、配额、限流。
- `POST /echo-api/proxy/stt`：后端 STT 代理，已做鉴权、Pro、配额、限流。
- `GET /echo-panel/`：管理员控制面板。
- `GET /echo-api/admin/proxy-status`：安全展示 STT/LLM 代理状态。

桌面端现状：

- `src-tauri/src/storage/mod.rs` 和 `src/stores/appStore.ts` 仍保存本地 `llm_api_key`、`llm_base_url`、`llm_model`、`stt_api_key` 等配置。
- 主录音链路仍优先使用本地 AppConfig 直连 provider。
- “边说边翻译”已有配置和 prompt 支持，但当前实际语义是录音结束后的 LLM 翻译，不是真实时翻译。
- OTA 目前是“检查并展示策略”，还没有完整下载、安装、强制拦截链路。

## 总体原则

### 后端管什么

- 云端 LLM/STT/TTS/OCR provider registry。
- 当前启用的默认 provider、模型、参数、能力开关。
- 用户/套餐/渠道/平台维度的策略。
- OTA 更新策略、最低版本、强制更新、下载地址。
- Provider API Key、服务端 endpoint，以及它们的下发/脱敏策略。
- 配额、限流、审计、故障降级。

### 桌面端管什么

- 快捷键、窗口、托盘、主题、胶囊样式。
- 本地输入/输出偏好：键盘写入、剪贴板写入。
- 本地模式：Ollama、SenseVoice、本地 OCR、本地 BYOK。
- 缓存最近一次后端策略，离线时可继续使用本地兜底。

### Key 下发与脱敏规则

- 允许后端向已授权桌面端下发 provider API Key，用于桌面端直连 provider 或作为 proxy 迁移期兜底。
- 前台 UI 不展示完整 key，只显示部分脱敏值，例如 `sk-****abcd`。
- 用户可以手动输入自己的 key；保存后再次回读仍然只显示部分脱敏值。
- 如果输入框显示的是脱敏值，保存时不得把脱敏字符串覆盖真实 key。只有用户主动输入新值时才更新真实 key。
- `echo-panel` 只显示 set/missing 或部分脱敏值；非必要不回显完整 key。
- 日志、审计、错误、备份仍然必须过滤 `apiKey`、`secret`、`token` 等敏感字段。
- 不在“关于/OTA”页面展示下载 URL。
- 不让桌面端拼接云 provider endpoint 执行业务调用。
- 不让未鉴权业务接口绕过 `/echo-api/` 路由分组、配额、限流、审计。

## 目标架构

```text
echo-panel
  管理 provider / 模型 / OTA / 功能开关
        |
        v
server PostgreSQL
  provider_registry
  desktop_policy
  ota_release
        |
        v
/echo-api/desktop/bootstrap
  下发安全策略，不下发密钥
        |
        v
EcholIKE Desktop
  使用后端策略决定走 proxy 还是 local
        |
        +--> /echo-api/proxy/stt
        +--> /echo-api/proxy/llm
        +--> /echo-api/proxy/tts
        +--> /echo-api/app/update 或 /echo-api/desktop/bootstrap.ota
```

## 新增核心接口

### `GET /echo-api/desktop/bootstrap`

桌面端启动、打开设置、手动刷新云配置时调用。

建议鉴权：`auth`。  
如果未登录，返回公开默认策略：只启用本地/BYOK，不给 Pro 云代理能力。

请求参数：

- `version`: 当前桌面版本。
- `platform`: `windows | macos | linux`。
- `channel`: `stable | beta | dev`。
- `arch`: `x64 | arm64`。

响应示例：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-29T00:00:00.000Z",
  "apiBaseUrl": "https://api.example.com/echo-api",
  "features": {
    "cloudStt": true,
    "cloudLlm": true,
    "cloudTts": false,
    "cloudOcr": false,
    "translate": true,
    "selectedTextEdit": true,
    "ota": true
  },
  "services": {
    "stt": {
      "mode": "proxy",
      "providerId": "glm-asr",
      "displayName": "GLM ASR",
      "defaultLanguage": "multi",
      "streaming": false
    },
    "llm": {
      "mode": "direct",
      "providerId": "openrouter",
      "displayName": "OpenRouter",
      "defaultModel": "google/gemini-2.5-flash",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "test-server-owned-key",
      "apiKeyPreview": "sk-****-key",
      "models": [
        {
          "id": "google/gemini-2.5-flash",
          "label": "Gemini 2.5 Flash",
          "supportsStreaming": true,
          "supportsTranslate": true,
          "maxInputChars": 24000
        }
      ]
    },
    "tts": {
      "mode": "disabled"
    },
    "ocr": {
      "mode": "local",
      "defaultBaseUrl": "http://127.0.0.1:11434",
      "defaultModel": "glm-ocr:latest"
    }
  },
  "ota": {
    "enabled": true,
    "autoUpdate": false,
    "forceUpdate": false,
    "currentVersion": "0.1.0",
    "latestVersion": "0.1.1",
    "minVersion": "0.1.0",
    "releaseNotes": "修复托盘关于页跳转和图标缓存提示。",
    "status": "available"
  },
  "policy": {
    "preferProxy": true,
    "allowByok": true,
    "allowLocalModels": true,
    "configTtlSeconds": 3600
  }
}
```

关键点：

- `services.*.mode` 决定桌面端业务链路。
- `mode=proxy` 时，桌面端只调用后端 `/proxy/*`，不需要 provider endpoint/API Key。
- `mode=direct` 时，后端可以下发 provider endpoint/API Key，桌面端本地保存真实 key，但 UI 只显示脱敏值。
- `mode=local` 时，只下发安全默认值，用户仍可改本地地址。
- `ota` 不包含下载 URL。下载 URL 只给后端下载接口或 updater 内部消费。

### `GET /echo-api/app/update`

保留现有接口，但它应成为 `desktop/bootstrap.ota` 的兼容子集。

短期：

- 关于页继续使用该接口。
- 返回 `downloadUrl` 给桌面内部消费，但 UI 不展示。

中期：

- 改为返回 `updateToken` 或 `downloadId`。
- 新增 `GET /echo-api/app/update/download/:id`，由后端 302 到真实对象存储地址，或流式下载。

### `POST /echo-api/proxy/tts`

未来新增。形态与现有 `proxy/llm`、`proxy/stt` 一致：

- `pro` 鉴权。
- 请求体只接收文本、voice、format、speed 等业务字段。
- 禁止客户端传 `apiKey`、`baseUrl`、`provider`。
- 服务端读取 provider registry 或 env 中的 TTS 配置。
- 计费类型可新增 `tts_chars` 或 `tts_seconds`。

## 数据库设计

### `provider_registry`

管理所有 provider 能力，不直接暴露密钥。

字段建议：

- `id`
- `kind`: `llm | stt | tts | ocr`
- `provider_id`: `openrouter | deepseek | glm-asr | ...`
- `display_name`
- `enabled`
- `mode`: `proxy | local | byok | disabled`
- `endpoint_encrypted`
- `api_key_encrypted`
- `default_model`
- `models_json`
- `capabilities_json`
- `priority`
- `created_at`
- `updated_at`

第一阶段可以先不建表，继续读取 env。第二阶段再迁移到 DB + echo-panel 管理。

### `desktop_policy`

按渠道、平台、套餐下发策略。

字段建议：

- `id`
- `channel`
- `platform`
- `plan`: `free | pro | all`
- `features_json`
- `services_json`
- `policy_json`
- `enabled`
- `created_at`
- `updated_at`

### `ota_release`

管理 OTA 版本。

字段建议：

- `id`
- `app_name`
- `version`
- `channel`
- `platform`
- `arch`
- `enabled`
- `force_update`
- `min_version`
- `download_url_encrypted`
- `sha256`
- `signature`
- `release_notes`
- `created_at`
- `published_at`

短期可继续使用 env：

- `DESKTOP_UPDATE_ENABLED`
- `DESKTOP_AUTO_UPDATE_ENABLED`
- `DESKTOP_UPDATE_FORCE`
- `DESKTOP_UPDATE_LATEST_VERSION`
- `DESKTOP_UPDATE_MIN_VERSION`
- `DESKTOP_UPDATE_DOWNLOAD_URL`
- `DESKTOP_UPDATE_RELEASE_NOTES`

DB 化以后，env 只保留兜底默认值和加密密钥。

## 后端改造计划

### 1. Provider 配置模型

新增文件建议：

- `server/src/services/desktop/bootstrap-service.ts`
- `server/src/routes/desktop-bootstrap.ts`
- `server/src/services/provider/provider-registry.ts`

第一阶段实现 env-backed registry：

- LLM 读取 `LLM_PROVIDER`、`LLM_API_KEY`、`LLM_MODEL`。
- STT 读取 `STT_PROVIDER`、`STT_API_KEY`。
- TTS 先返回 disabled。
- OCR 先返回 local 默认值。

第二阶段实现 DB-backed registry：

- `echo-panel` 可编辑 provider。
- API Key 加密存储；桌面端/`echo-panel` 回读展示必须脱敏。
- 管理面板只展示 `set/missing` 或部分脱敏值，默认不回显完整密钥。

### 2. 新增 `/desktop/bootstrap`

在 `server/src/app.ts` 增加 auth route：

- `GET /desktop/bootstrap`
- access: `auth`
- rate limit: business read
- panelConsumer: `/echo-panel/#operations`

返回策略应包含：

- safe provider metadata。
- feature flags。
- OTA policy。
- current quota/plan 摘要可选。

测试：

- 未登录访问应 401 或返回 public fallback，二选一固定。
- 登录 Free 用户不应拿到 Pro-only proxy capability。
- Pro 用户可拿到 proxy mode。
- 响应体允许包含已授权桌面端需要消费的 `apiKey` / `baseUrl`，但必须同时提供 `apiKeyPreview` 供 UI 展示。
- 响应体仍不得把 `downloadUrl` 当作展示字段；URL 只能作为更新器内部消费字段。

### 3. echo-panel 管理面板

第一阶段只新增只读展示：

- 当前 LLM provider：configured/missing、provider、model。
- 当前 STT provider：configured/missing、provider。
- OTA：enabled、latestVersion、force、minVersion、downloadUrl set/missing。
- Desktop bootstrap 预览 JSON，自动红acted。

第二阶段新增可写控制：

- Provider 启用/停用。
- 默认模型。
- 功能开关。
- OTA 发布与撤回。

写接口放在 `/echo-api/admin/*`：

- `GET /admin/desktop-policy`
- `POST /admin/desktop-policy`
- `GET /admin/providers`
- `POST /admin/providers`
- `GET /admin/ota-releases`
- `POST /admin/ota-releases`

所有写操作进入 audit log。

### 4. Proxy 服务升级

现有 `server/src/services/proxy/provider-config.ts` 只支持单一 env provider。

升级方向：

- 允许 registry 决定当前 provider。
- LLM 支持 provider registry 中的 endpoint/model/capabilities。
- STT 支持 provider registry 中的 model/extraFields。
- 新增 TTS proxy service。

安全边界保持不变：

- `/proxy/llm` 继续拒绝客户端传 provider/baseUrl/apiKey/model 覆盖字段。
- 模型选择如果允许客户端传，只能传 registry allowlist 中的 model id。
- 所有 provider request 由服务端签名/鉴权。

## 桌面端改造计划

### 1. 新增 CloudPolicy Store

新增类型：

- `DesktopBootstrap`
- `CloudFeatureFlags`
- `CloudServicePolicy`
- `OtaPolicy`

新增持久化缓存：

- Tauri store key：`desktop_bootstrap_cache`
- 缓存 TTL：来自 `policy.configTtlSeconds`

启动流程：

1. 读取本地 AppConfig。
2. 读取 bootstrap cache。
3. 后台请求 `/echo-api/desktop/bootstrap`。
4. 成功后更新 store/cache。
5. 失败时使用 cache。
6. 无 cache 时使用本地默认配置。

### 2. 配置优先级

最终生效配置按以下优先级合成：

1. 强制策略：后端下发，如强制 OTA、禁用某能力。
2. 用户本地偏好：快捷键、主题、输出方式。
3. 后端默认：provider、模型、功能默认开关。
4. 桌面内置默认：完全离线兜底。

### 3. STT 主链路切换

当前 `pipeline.rs` 直接根据 `AppConfig` 创建 STT provider。

改造：

- 如果 `cloudPolicy.services.stt.mode === proxy`：
  - 音频采集仍在本地。
  - stop 后把 wav/blob 发给 `/echo-api/proxy/stt`。
  - 返回 text 后进入 LLM 阶段。
- 如果 `mode === local/byok`：
  - 保持现有本地 provider 逻辑。

### 4. LLM 主链路切换

当前 `polish_text` 根据本地 `llm_*` 直连。

改造：

- 如果 `cloudPolicy.services.llm.mode === proxy`：
  - 桌面端构造 messages。
  - 调 `/echo-api/proxy/llm`。
  - streaming 时消费 SSE。
- 如果 `mode === local/byok`：
  - 保持现有 `llm::create_provider` 逻辑。

边说边翻译第一阶段：

- 保持录音结束后翻译。
- 由后端 `features.translate` 控制是否展示开关。
- 由 LLM proxy 执行翻译，不走桌面端直连 provider。

边说边翻译第二阶段：

- STT partial streaming。
- partial transcript 在 UI 展示。
- LLM streaming translation 做增量译文。
- 最终输出仍以 final transcript + final translation 为准。

### 5. TTS 接入

当前没有完整 TTS 链路。

第一阶段：

- Bootstrap 中返回 `tts.mode=disabled`。
- UI 不展示 TTS 或显示“后台未启用”。

第二阶段：

- 新增 `/proxy/tts`。
- 桌面端新增 TTS 设置页/朗读动作。
- 支持返回 audio bytes 或临时文件。

### 6. OTA 链路打通

短期落地：

- 关于页调用 bootstrap 或 app/update。
- UI 只展示状态、版本、自动更新/强制更新，不展示 URL。
- 有更新时按钮文案变为“下载更新”。
- 强制更新时禁用部分主功能，只允许更新/退出。

中期落地：

- 使用 Tauri updater 插件，或者自定义下载到临时目录后启动安装包。
- 校验 `sha256` 或签名。
- 下载地址由后端内部消费或以短期 token 获取，不在 UI 显示。

强制更新行为：

- 启动时检查。
- 若 `forceUpdate=true`：
  - 主窗口展示强制更新状态。
  - 禁止录音/LLM/STT 等业务入口。
  - 保留“立即更新”和“退出”。

## API 与鉴权策略

公开接口：

- `GET /echo-api/healthz`
- `GET /echo-api/readyz`
- `GET /echo-api/app/update`，可保留公开，但不返回长期可复用敏感 URL。

鉴权接口：

- `GET /echo-api/desktop/bootstrap`
- `POST /echo-api/proxy/llm`
- `POST /echo-api/proxy/stt`
- `POST /echo-api/proxy/tts`
- `GET /echo-api/scenes`

管理员接口：

- `/echo-api/admin/*`
- `/echo-panel/`

桌面端必须具备 bearer token 才能使用云代理能力。未登录时仍可使用本地/BYOK。

## 测试计划

后端测试：

- `desktop-bootstrap.test.ts`
  - 返回 schemaVersion。
  - Pro 用户拿到 proxy mode。
  - Free 用户能力被降级或禁用。
  - 未授权响应不含 secret/url 明文；授权桌面端响应可以含 provider key，但 UI 只能使用 preview 展示。
  - OTA 强制更新策略正确合并。
- `provider-registry.test.ts`
  - env-backed provider 正确解析。
  - unsupported provider fail closed。
  - missing key fail closed。
- `app-update.test.ts`
  - 保持现有测试。
  - 增加不展示 URL 的安全响应模式。
- `proxy-provider.test.ts`
  - LLM/STT 从 registry 取模型。
  - 客户端不能覆盖 provider/baseUrl/apiKey。

桌面测试：

- bootstrap 成功后更新 cloud policy store。
- bootstrap 失败时使用缓存。
- `mode=proxy` 时 STT/LLM 不读本地 API Key。
- `mode=local/byok` 时保留原逻辑。
- 强制 OTA 时禁用主操作。
- 关于页不展示 download URL。

验收命令：

```powershell
npm test --prefix server
npm run typecheck --prefix server
npm run build --prefix server
npm run test
npm run lint
npm run build
npm run build:desktop
```

## 分阶段交付

### Phase 1：Bootstrap 与只读策略

目标：后端可以下发安全策略，桌面端能读取并缓存。

范围：

- 新增 `/echo-api/desktop/bootstrap`。
- env-backed provider registry。
- echo-panel 增加只读策略预览。
- 桌面端新增 cloud policy store/cache。
- 不改主业务链路。

验收：

- 桌面端关于页/设置页能显示“云端策略已同步”。
- 响应包含授权桌面端可消费的 provider API Key，并同时提供脱敏 preview。

### Phase 2：LLM/STT 代理主链路

目标：后端控制 provider，桌面端业务走 proxy。

范围：

- 桌面 STT proxy client。
- 桌面 LLM proxy client。
- pipeline 按 `mode` 切换。
- 设置页显示云 provider API Key 的脱敏值，并允许用户输入自己的 key 覆盖。
- BYOK/local 作为备用高级模式。

验收：

- 后端改 `LLM_MODEL` 后，桌面无需发版即可生效。
- 后端改 `STT_PROVIDER` 后，桌面无需发版即可生效。
- 云 proxy 使用配额、限流、审计。

### Phase 3：OTA 完整链路

目标：后台控制更新，桌面端可下载/安装/强制更新。

范围：

- OTA policy 合并进 bootstrap。
- 关于页更新状态改为完整状态机。
- 下载地址不展示。
- sha256/signature 校验。
- 强制更新入口拦截。

验收：

- 后台开启强制更新后，旧客户端主功能被锁定。
- 点击更新能拿到安装包并校验。

### Phase 4：TTS 与实时翻译

目标：补齐未启用能力。

范围：

- `/proxy/tts`。
- TTS provider registry。
- STT partial streaming。
- LLM streaming translation。
- UI 中将“边说边翻译”区分为“结束后翻译”和“实时翻译”。

验收：

- TTS 后台启用后桌面端自动出现能力。
- 实时翻译能显示 partial/final 状态。

### Phase 5：DB 化与 echo-panel 可写管理

目标：不依赖 env 改 provider/OTA。

范围：

- Drizzle migrations。
- provider registry DB store。
- ota release DB store。
- echo-panel CRUD。
- 审计日志。

验收：

- 管理员在 echo-panel 修改 LLM provider/model 后立即影响 bootstrap。
- 管理员发布 OTA 后无需重启服务。

## 风险与处理

### 云能力不可用

处理：

- Provider registry fail closed。
- 桌面端 fallback 到 cached policy。
- cached policy 过期后降级 local/BYOK。

### 后端密钥泄露

处理：

- bootstrap 响应测试需要区分未授权/授权：未授权不得含 secret；授权可含 provider `apiKey`，但必须含 `apiKeyPreview`。
- `echo-panel` 只显示 set/missing 或部分脱敏值。
- DB 中密钥加密存储。

### OTA 下载 URL 泄露

处理：

- UI 不展示。
- 短期只内部消费。
- 中期使用 `downloadId/updateToken`。
- 长期使用签名校验和短期 URL。

### 本地用户被云策略破坏

处理：

- `allowLocalModels` 和 `allowByok` 默认 true。
- 后端强制策略只用于 OTA、安全禁用、套餐限制。
- 用户本地交互偏好不被后端覆盖。

## 推荐立即开始的任务

1. 新增 `GET /echo-api/desktop/bootstrap`，先 env-backed。
2. 桌面端新增 cloud policy cache，但暂不切主链路。
3. echo-panel 增加只读 Desktop Policy 区块。
4. 把 OTA policy 合并到 bootstrap，同时保留 `/app/update` 兼容。
5. 第二轮再切 LLM/STT proxy 主链路。

这个顺序风险最低：先把“后端能下发、桌面能消费、管理面板能看见”打通，再改语音主链路。

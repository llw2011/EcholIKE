# EcholIKE 前台配置来源切换计划书

## 背景

后端已经具备统一入口形态：桌面端访问 `https://api.example.com/echo-api/`，由后端 proxy 再调用后台机器上的本地服务，例如 STT、OCR、TTS、LLM。
但前台当前仍把“后台托管”和“本机手动配置”混在一起：有些地方优先走后台，有些地方失败后会静默回退本机配置。这会让用户不知道当前到底消费的是后台能力，还是本机端口。

本计划把前台配置明确收口为两个来源：

- **后台托管**：自动拉取后台配置，功能走 `/echo-api/proxy/*`，界面只展示能力是否可用。
- **本机配置**：保留当前手动指定 provider、base url、model、api key 的方式。

OCR 也纳入同一选择，不再特殊处理。

## 产品目标

- 用户只需要理解一个选择：`后台托管` 或 `本机配置`。
- 选择后台托管后，不展示 endpoint、端口、模型、API Key 等详细链路。
- 选择本机配置后，完整保留当前高级配置能力。
- 两种模式之间切换时，本机配置值不丢失。
- 后台托管模式下不做静默本机回退，失败就明确提示后台能力不可用。

## 非目标

- 不在这次引入新的 provider DB 表结构。
- 不把后台机器上的 `127.0.0.1:*` 地址下发给前台展示。
- 不在启动时自动跑昂贵的真实模型探测。
- 不改 OTA、主题、胶囊样式等无关功能。
- 禁止运行 `npm audit fix`。

## 配置模型

新增配置来源字段：

```ts
type ConfigSource = 'backend' | 'local'
```

落地位置：

- `src/stores/appStore.ts`
  - `AppConfig.config_source: ConfigSource`
- `src-tauri/src/storage/mod.rs`
  - `AppConfig.config_source: String`

默认策略：

- 新安装用户默认 `backend`。
- 老用户迁移缺省值建议为 `local`，避免突然改变已有手动配置行为。
- 本机配置字段继续持久化；切到后台托管时只是隐藏和停用，不清空。

## 后台托管模式

启动和手动同步时：

- 调用 `desktop/bootstrap`。
- 保存最新 bootstrap cache。
- UI 只展示后台能力状态。

能力状态只展示四项：

- 文本 AI：可用 / 不可用 / 异常
- 语音转写：可用 / 不可用 / 异常
- 语音合成：可用 / 不可用 / 异常
- OCR：可用 / 不可用 / 异常

MVP 状态语义：

- `可用`：bootstrap 显示该服务 `mode=proxy` 且 `configured !== false`，并且当前有桌面 token。
- `不可用`：后台未配置、用户未登录、套餐不允许，或 bootstrap 不可用。
- `异常`：实际调用 proxy 后失败，或用户手动点击检测后失败。

行为规则：

- LLM 问答走 `/proxy/llm`。
- OCR 截图和附件识别走 `/proxy/ocr`。
- TTS 朗读走 `/proxy/tts`。
- STT 主链路走 `/proxy/stt`。
- proxy 失败时不自动回退本机配置，只提示失败并建议切换到本机配置。

## 本机配置模式

保持当前手动配置体验：

- STT 展示本机/云厂商 provider 配置。
- LLM 展示 provider、API Key、base URL、model。
- OCR 展示本机 OCR base URL 和 model。
- TTS 如果后续补本机链路，也归入这里。

行为规则：

- 不主动消费后台 proxy 能力。
- OCR 走本机 OCR 命令。
- AI 问答走本机 LLM 命令。
- STT/LLM 主链路走当前本机配置。
- 后台 bootstrap 仍可用于 OTA、登录、订阅等公共信息，但不参与业务能力选择。

## UI 方案

设置页顶部新增一个清晰入口：

```text
配置来源    后台托管 | 本机配置
```

选择 `后台托管` 时：

- 展示“后台托管状态”卡片。
- 显示四个能力状态。
- 提供“同步后台配置”按钮。
- 显示最近同步时间。
- 隐藏本机 API Key、base URL、model、端口配置。

选择 `本机配置` 时：

- 展示现在的手动配置表单。
- 隐藏后台能力状态详情，最多保留一行“后台配置未参与当前业务调用”。

首页工作台：

- 状态文案按配置来源变化。
- 后台托管：`后台托管可用` / `后台托管不可用`。
- 本机配置：`本机可用` / `缺配置`。
- 禁用状态不要混合显示“后台可用但本机缺配置”这类容易误解的组合。

## 代码改动范围

前端：

- `src/stores/appStore.ts`
- `src/lib/desktopBootstrap.ts`
- `src/components/Settings/ControlPanel.tsx`
- `src/components/HomePage/Workbench.tsx`
- 相关测试文件

Tauri/Rust：

- `src-tauri/src/storage/mod.rs`
- `src-tauri/src/pipeline.rs`
- 可能涉及 OCR/LLM 命令调用处的模式判断

后端：

- 理论上无需 DB migration。
- 如前台需要更干净的状态字段，可微调 `desktop/bootstrap` 返回内容，但不暴露详细 endpoint。

## 分期计划

### Phase 1：配置字段与迁移

- 增加 `config_source`。
- 新安装默认后台托管。
- 老配置缺省迁移为本机配置。
- TS/Rust 类型和默认值对齐。

验收：

- 切换配置来源后能持久化。
- 原有本机配置不会被清空。
- 老配置加载不报错。

### Phase 2：设置页 UI 收口

- 增加“后台托管 / 本机配置”分段控件。
- 后台托管模式只显示能力状态和同步按钮。
- 本机配置模式显示当前手动配置表单。
- OCR 配置也被纳入本机配置区域。

验收：

- 后台托管模式看不到 endpoint、端口、API Key、model 输入框。
- 本机配置模式所有当前配置项仍可编辑。
- 同步后台配置按钮能刷新 bootstrap 状态。

### Phase 3：业务调用按来源硬切换

- `Workbench` 的 AI 问答按配置来源决定 proxy 或本机。
- OCR 截图/附件按配置来源决定 proxy 或本机。
- TTS 按配置来源决定是否可用。
- `pipeline.rs` 的 STT/LLM 主链路按配置来源决定 proxy 或本机。
- 移除后台失败后静默本机回退。

验收：

- 后台托管模式下 proxy 失败，只提示后台不可用，不再调用本机配置。
- 本机配置模式下不调用 `/proxy/ocr`、`/proxy/llm`。
- OCR 在两个模式下都遵守同一个配置来源选择。

### Phase 4：状态与错误体验

- 将调用失败后的服务标记为“异常”。
- 错误提示明确说明当前配置来源。
- 提供“切换到本机配置”的显式动作入口。

验收：

- 用户能看懂失败发生在后台托管还是本机配置。
- 不出现“明明选后台托管却偷偷跑本机”的现象。

### Phase 5：测试与回归

需要补充：

- 设置页配置来源切换测试。
- 后台托管模式隐藏手动配置测试。
- 本机配置值切换后保留测试。
- `Workbench` 后台托管不回退本机测试。
- OCR 后台/本机模式分流测试。
- Rust config 反序列化兼容测试。
- pipeline proxy/local 分流测试。

建议验证命令：

```powershell
npm.cmd test -- --run src/components/Settings/__tests__/ControlPanel.test.tsx src/components/HomePage/__tests__/Workbench.test.tsx src/stores/__tests__/appStore.test.ts
cargo test --manifest-path src-tauri/Cargo.toml storage pipeline --lib
npm.cmd run build
npm.cmd run build:desktop
```

## 最终验收标准

- 用户能在前台明确选择后台托管或本机配置。
- 后台托管模式只展示服务可用性，不展示详细链路。
- OCR、AI 问答、STT、TTS 都遵守同一个配置来源。
- 后台托管失败不会静默回退本机。
- 本机配置模式保持现有高级配置能力。
- 切换模式不丢失本机配置。

# EcholIKE Tauri Updater OTA 落地计划

## 目标

把现有 OTA 从“检查更新后打开安装包”升级为“在线下载、校验、重启替换、自动进入新版”。

最终用户体感：

1. 用户在应用内点击检查更新，或启动时发现强制更新。
2. 应用展示版本、自动更新/强制更新状态，不展示真实下载 URL。
3. 应用下载并校验更新包。
4. 下载完成后提示“立即重启更新”。
5. 应用退出，由 updater 完成替换。
6. 新版 EcholIKE 自动启动。

## 当前状态

项目当前版本为 0.1.9，Tauri 版本为 2.11.x。

已有链路：

- 后端 GET /echo-api/app/update 可以返回 OTA 策略、版本、下载地址、sha256。
- 后端 /echo-api/admin/ota-releases 已有 OTA release 管理。
- 后端 ota_release 使用 app/version/channel/platform/arch 维度 upsert，发布记录具备幂等性。
- 前端设置页关于区域已有更新入口。
- 桌面端 src-tauri/src/commands/update.rs 可以检查、下载、校验并打开安装包。
- 发布路径固定为 https://api.example.com/echo-panel/ota/。

当前缺口：

- 客户端不是 Tauri updater 管理的安装流程，只是下载后打开安装包。
- 不能保证更新完成后自动重启到新版。
- 下载过程没有 .part 临时文件和原子替换。
- 已下载且 hash 一致时没有复用，重复点击可能重复下载。
- 缺少 pending update 状态恢复。
- 缺少 updater 签名发布规范。

## 推荐方案

采用 Tauri 官方 updater 作为主路径。

不要手搓运行时覆盖主程序。Windows 下主进程运行时无法可靠覆盖自身 exe，稳定做法是：

```text
检查更新 -> 下载更新包 -> 校验签名/hash -> 标记 pending -> 退出主程序 -> updater 替换 -> 自动重启新版
```

保留现有 /echo-api/app/update 作为后端策略来源，但客户端安装动作由 Tauri updater 接管。

## 设计原则

- 后端决定是否更新、是否强制、目标版本、渠道、平台、发布说明。
- 前端只展示状态，不展示下载 URL。
- 客户端只在明确边界触发检查：启动、关于页手动检查、OTA 后首次启动。
- 不做后台轮询，不做 WebSocket 推送。
- 强制更新只锁主功能，不锁“更新”和“退出”。
- 下载与安装必须幂等：重复点击、失败重试、应用重启后都不能破坏状态。
- 更新包必须可校验：优先签名，其次 sha256。

## 后端改造

### 1. 新增 Tauri updater manifest 响应

新增或扩展一个专供 updater 消费的接口：

```text
GET /echo-api/app/update/tauri
```

请求参数：

```text
version=0.1.9
platform=windows
arch=x64
channel=stable
```

响应遵循 Tauri updater 能消费的 manifest 结构，并只在有更新时返回真实下载信息。

建议响应形态：

```json
{
  "version": "0.1.10",
  "notes": "修复 OTA 安装与重启替换链路。",
  "pub_date": "2026-07-01T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "base64-signature",
      "url": "https://api.example.com/echo-panel/ota/EcholIKE_0.1.10_x64-setup.exe"
    }
  }
}
```

说明：

- url 只给 updater 内部消费，不在 UI 明文展示。
- 后台面板列表仍只展示 downloadUrl set/missing。
- 如果没有更新，返回 no update 语义或 204，具体按 updater 插件要求实现。

### 2. 保留现有策略接口

继续保留：

```text
GET /echo-api/app/update
```

它面向 UI 状态展示，返回：

```json
{
  "appName": "EcholIKE",
  "currentVersion": "0.1.9",
  "latestVersion": "0.1.10",
  "updateAvailable": true,
  "autoUpdate": false,
  "forceUpdate": false,
  "sha256": "optional-sha256",
  "releaseNotes": "修复 OTA 安装与重启替换链路。",
  "message": "发现新版本"
}
```

UI 响应不展示 URL。若该接口继续返回 downloadUrl，只能在 Tauri command 内部消费，React 层不渲染。

### 3. OTA release 数据补齐

ota_release 建议补齐或明确这些字段：

- version
- channel
- platform
- arch
- enabled
- force_update
- auto_update
- min_version
- download_url_encrypted
- sha256
- signature
- release_notes
- published_at

其中 signature 是 Tauri updater 主校验凭据。sha256 可以作为额外校验和排障信息。

## 桌面端改造

### 1. 接入 Tauri updater 插件

新增 Rust 依赖：

```toml
tauri-plugin-updater = "2"
```

新增前端依赖：

```json
"@tauri-apps/plugin-updater": "^2"
```

Tauri 初始化注册 updater 插件。

tauri.conf.json 增加 updater 配置，endpoint 指向后端 manifest：

```json
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://api.example.com/echo-api/app/update/tauri?version={{current_version}}&platform={{target}}&arch={{arch}}&channel=stable"
      ],
      "pubkey": "TAURI_UPDATER_PUBLIC_KEY"
    }
  }
}
```

实际字段以 Tauri v2 updater 插件 schema 为准落地，计划实现时以当前依赖版本校验。

### 2. 替换当前安装命令

当前：

```text
download_and_install_ota_update -> 下载文件 -> opener.open_path(...)
```

目标：

```text
check_update -> download_and_install -> relaunch
```

客户端状态机：

```text
idle
checking
available
downloading
ready_to_restart
installing
updated
failed
```

按钮行为：

- idle：检查更新
- checking：禁用按钮
- available：下载更新
- downloading：禁用按钮并展示进度
- ready_to_restart：立即重启更新
- installing：禁用按钮
- failed：允许重试

同一时间只允许一个 OTA action in-flight。

### 3. 幂等要求

即使用 Tauri updater，也保留这些客户端规则：

- 重复点击不会启动多个下载。
- 下载失败后可重试。
- 已下载且签名/hash 通过的包不重复下载。
- pending update 状态写入本地 store。
- 应用异常退出后，下次启动能识别 pending 状态并继续提示重启更新或清理失败状态。
- 安装成功后清理 pending 状态。

### 4. 强制更新行为

启动时读取 bootstrap / update policy。

当 forceUpdate=true 且当前版本低于 minVersion 或 latestVersion：

- 首页主功能禁用。
- 设置页仍可打开更新入口。
- 托盘保留“关于/检查更新/退出”。
- 弹窗只提供“立即更新”和“退出应用”。
- 下载失败时允许重试，不允许继续使用主功能。

## 发布流程

### 1. 生成 updater key

首次接入时生成 Tauri updater 签名 key。

要求：

- private key 只放在构建环境或发布机器环境变量中。
- public key 写入 tauri.conf.json。
- private key 不进入 git。

### 2. 构建更新包

发布版本时执行：

```powershell
npm run build:desktop
```

生成 updater 可消费的 bundle 和签名文件。

### 3. 上传 OTA 目录

统一上传到：

```text
/srv/echolike/ota/
```

公网前缀：

```text
https://api.example.com/echo-panel/ota/
```

### 4. 注册 OTA release

通过 echo-panel 或 admin API upsert release：

- version
- channel
- platform
- arch
- enabled
- forceUpdate
- autoUpdate
- minVersion
- downloadUrl
- sha256
- signature
- releaseNotes

同版本重复发布必须是 upsert，不产生重复 release。

### 5. 发布验证

发布后必须验证：

```text
GET /echo-api/healthz
GET /echo-api/app/update?version=上一版本&platform=windows&arch=x64
GET /echo-api/app/update/tauri?version=上一版本&platform=windows&arch=x64&channel=stable
HEAD /echo-panel/ota/<artifact>
```

桌面端验证：

- 旧版本能发现更新。
- UI 不展示 URL。
- 下载时按钮不能重复点击。
- 下载完成后出现“立即重启更新”。
- 重启后版本号变为新版本。
- 强制更新时主功能被锁定。

## 分阶段落地

### Phase 1：接入 updater 基础能力

- 增加 Tauri updater 插件依赖。
- 增加 updater endpoint 配置。
- 后端新增 /app/update/tauri manifest。
- 发布一个测试 manifest。
- 不改 UI，只跑通 updater check。

验收：

- 客户端能通过 updater 插件识别新版本。
- 无更新时不报错。
- 有更新时能读到版本和 notes。

### Phase 2：替换当前下载/安装命令

- 废弃 opener.open_path 安装方式。
- 新增 updater command：检查、下载、安装、重启。
- 设置页按钮接入新状态机。
- 禁止重复点击。

验收：

- 点击一次后不能重复触发。
- 下载失败能回到可重试状态。
- 下载完成能提示立即重启。

### Phase 3：强制更新与 pending 状态

- 启动时检查 OTA policy。
- 强制更新锁定主功能。
- 本地持久化 pending update。
- 异常退出后恢复 pending 状态。

验收：

- 强制更新版本无法继续使用主功能。
- 下载完成后关闭再打开仍提示重启更新。
- 更新成功后 pending 状态被清理。

### Phase 4：发布规范固化

- 更新 docs/desktop-config-ota-release-policy.md。
- 增加发布脚本校验：版本号、artifact、signature、sha256、URL HEAD。
- 后端 admin 面板补齐 signature 字段。
- 测试覆盖 app-update manifest。

验收：

- 每个 OTA 版本都有签名。
- 发布脚本重复执行不产生重复 release。
- 从该版本开始，OTA 发布流程固定走 updater。

## 需要避免的做法

- 不做运行时热替换 exe。
- 不在 React UI 展示真实下载 URL。
- 不用 WebSocket 或后台轮询推送更新。
- 不让用户无限点击检查更新。
- 不把 updater private key 写进仓库。
- 不让强制更新阻塞退出应用。

## 最小验收清单

- npm run test
- npm run build
- npm run build:desktop
- npm test --prefix server
- npm run build --prefix server
- 旧版本升级到新版本成功。
- 新版本再次检查显示已是最新。
- OTA release upsert 重复执行不新增重复记录。
- 关于页只展示更新状态，不展示 URL。

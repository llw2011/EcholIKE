# EcholIKE

本仓库公开 EcholIKE `0.2.31` 的独立 AGPL 源码快照，基于源码提交 `a7ce82a89850a2527616c4cf950056258527b82a`，包含许可和项目声明修订。来源、第三方义务与商业销售规则分别见 [NOTICE.md](NOTICE.md)、[第三方许可清单](docs/third-party-licenses.md) 和 [COMMERCIAL.md](COMMERCIAL.md)。

EcholIKE 是一个 Windows 桌面效率工具。

它最核心的作用很简单：按下快捷键，说话，自动转成文字，必要时用 AI 润色，然后把结果写回你正在使用的软件里。

除了语音输入，它也支持截图识别、窗口问答、Markdown 编辑、历史记录、后台托管额度和 OTA 自动更新。

## 它适合谁

- 经常写消息、邮件、文档，但不想一直打字的人。
- 想用语音快速输入，再让 AI 帮忙整理成自然文本的人。
- 需要从截图、PDF、窗口内容里提取文字的人。
- 想把识别出来的 Markdown 内容继续编辑、导出的人。
- 团队或工作室想统一管理模型、额度和更新版本。

## 主要功能

### 语音输入

按快捷键开始录音，松开或再次按下结束录音。EcholIKE 会把你的语音转成文字，并按设置输出到当前应用。

你可以选择：

- 直接输出识别文本。
- 先让 AI 润色，再输出。
- 用剪贴板粘贴。
- 用键盘模拟输入。
- 显示悬浮胶囊，方便确认录音状态。

### AI 润色

语音识别出来的内容可能会有口语、重复或断句问题。AI 润色会把它整理成更适合发送或写入文档的文字。

常见用法：

- 把口语改成正式表达。
- 修正错别字和标点。
- 保留原意，但让句子更顺。
- 根据场景生成更自然的回复。

### 看图识别和窗口问答

EcholIKE 可以读取当前窗口或你选择的图片/PDF。

常见用法：

- 截图识别文字。
- 识别 PDF 页面内容。
- 对当前窗口内容提问。
- 把 OCR 结果保存为 Markdown。
- 把识别结果导出为 DOCX 或图片包。

### Markdown 编辑器

应用内置了一个轻量 Markdown 编辑器，适合处理识别结果、AI 输出和临时文稿。

它支持：

- Markdown 编辑和预览。
- 标题、列表、引用、代码块等常用格式。
- 草稿恢复。
- 与主应用主题联动。
- 把识别结果或 AI 输出继续整理后保存。

### 历史和词典

你可以在本地查看历史记录，也可以维护自己的词典，让人名、产品名、专业词更容易被正确识别。

### 后台托管模式

如果管理员启用了后台托管，用户登录授权账户后，可以直接使用后台配置好的 STT、LLM、OCR、TTS 服务。

这种模式下：

- 用户不需要自己填写模型 API Key。
- 后台统一管理模型、额度和功能开关。
- 桌面端只拿到必要的策略，不暴露后台密钥。

### 自动更新

EcholIKE 使用 Tauri updater 做 OTA 更新。正常情况下，客户端可以在应用内检查并更新，不需要用户反复手动下载安装包。

## 普通用户怎么用

### 1. 安装

下载 Windows 安装包，运行安装程序，然后打开 EcholIKE。

系统要求：Windows 10 x64 或 Windows Server 2016 x64 及以上版本。Windows 7、Windows 8/8.1、Windows Server 2008 R2 与 Windows Server 2012/R2 不受支持；安装程序会在下载或启动 WebView2 之前明确提示并退出。

如果你已经安装过旧版本，后续通常可以通过应用内更新升级。

### 2. 打开设置

首次使用建议先进入设置页，确认以下内容：

- 录音快捷键。
- 语音识别方式。
- 是否启用 AI 润色。
- 输出方式是粘贴还是键盘输入。
- 是否登录后台托管账户。
- 是否允许保存本地历史。

### 3. 选择使用模式

EcholIKE 有两种常见用法。

后台托管模式：

登录管理员提供的账户。模型和额度由后台管理，你只需要正常使用。

本地或自带 Key 模式：

自己填写 STT、LLM、OCR 等服务的 API Key、接口地址和模型名。配置保存在本机。

### 4. 开始语音输入

打开任意输入框，例如微信、浏览器、编辑器或文档软件。

按下快捷键开始说话，结束录音后，EcholIKE 会把文字写入当前输入框。

### 5. 使用 OCR 和 Markdown

如果你要处理截图、PDF 或识别结果，可以在首页选择对应功能，然后把文本送入 Markdown 编辑器继续修改和导出。

## 管理员怎么用

管理员可以部署 `server/` 后端，用来管理：

- 用户账户。
- 管理员权限。
- 用户额度。
- 后台托管模型。
- Provider 配置。
- 桌面策略。
- OTA 更新版本。

管理后台入口一般是：

```text
https://你的域名/echo-panel/
```

公开 API 一般挂在：

```text
https://你的域名/echo-api/
```

更详细的后端部署说明在 [server/README.md](server/README.md)。

## 开发者快速开始

需要准备：

- Node.js 22 或更新版本。
- Rust 工具链。
- Windows 上构建 Tauri 所需的系统依赖。

安装依赖：

```powershell
npm install
```

启动前端开发环境：

```powershell
npm run dev
```

启动 Tauri 桌面开发环境：

```powershell
npm run tauri dev
```

运行测试：

```powershell
npm test
```

检查前端构建：

```powershell
npm run build
```

构建桌面安装包：

```powershell
npm run build:desktop
```

构建产物会出现在：

```text
src-tauri/target-codex-check/release/bundle/
```

## 后端开发

安装后端依赖：

```powershell
npm install --prefix server
```

复制环境变量文件：

```powershell
Copy-Item server/.env.example server/.env
```

启动后端：

```powershell
npm run dev --prefix server
```

后端测试和构建：

```powershell
npm test --prefix server
npm run typecheck --prefix server
npm run build --prefix server
```

## 项目结构

```text
src/                  React 前端
src/components/       页面、设置、首页、胶囊、Markdown 编辑器
src/lib/              Tauri 调用、启动配置、工具函数
src/stores/           本地状态管理
src-tauri/src/        Rust 桌面端、录音、输出、存储、OTA
server/src/           后端 API、管理后台、鉴权、额度、代理
docs/                 计划书、审计记录、阶段性工作文档
scripts/              构建和辅助脚本
```

## 常见问题

### 提示语音额度不足

如果你使用后台托管模式，说明当前账户额度不够，或者管理员还没有给这个账户分配对应额度。

如果你使用本地模式，请检查是否误开了后台托管，或对应服务的配置是否正确。

### 提示 LLM quota exceeded

这是文本问答或 AI 润色额度不足。后台托管模式下需要管理员增加 LLM 额度。

### 识别成功但没有写入当前应用

可以尝试把输出方式切换为剪贴板粘贴。有些软件会拦截键盘模拟输入，粘贴模式通常更稳定。

### 首次打开加载失败

新版本会自动回退到安全启动数据。如果仍然失败，可以尝试重新载入，或者清理本地配置后再启动。

### 检查不到更新

确认当前版本是否已经是最新版本。OTA 只有在服务器登记了更高版本时才会提示更新。

## 隐私和安全

- 本地模式下，你填写的 API Key 保存在本机。
- 后台托管模式下，桌面端不会拿到后台真实密钥。
- 录音只在你触发录音时进行。
- 历史记录默认是本地数据，是否保留取决于你的设置。
- OTA 更新包需要签名，客户端会校验后再安装。

## 许可证

本快照的 EcholIKE 自有代码及组合项目使用 **AGPL-3.0-only**。完整条款见 [LICENSE](LICENSE)；上游原有 MIT 部分的版权与许可见 [NOTICE.md](NOTICE.md) 和 [LICENSES/OpenTypeless-MIT.txt](LICENSES/OpenTypeless-MIT.txt)。第三方依赖保持各自的许可。

可以遵循 AGPL 销售安装包、托管、部署和支持服务；分发或提供修改后的网络服务时，应按条款提供对应源码，不另附禁止再分发或禁止商用的限制。商业规则见 [COMMERCIAL.md](COMMERCIAL.md)。

第三方和上游说明见 [NOTICE.md](NOTICE.md)。

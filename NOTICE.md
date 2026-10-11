# EcholIKE 0.2.31 来源与许可声明

## 本快照的许可范围

本目录是源码提交 `a7ce82a89850a2527616c4cf950056258527b82a` 的独立开源快照。EcholIKE 自有修改、新增代码和该组合项目按 **GNU Affero General Public License version 3 only（`AGPL-3.0-only`）** 发布，全文见 [LICENSE](LICENSE)。本快照的版权声明为 Copyright © 2026 EcholIKE Rebuild Contributors；第三方部分的版权和许可保持各自原状。

本次修改统一许可、来源说明、包元信息和相关显示/测试文本，不追溯撤销历史副本已经获得的有效 MIT 授权。原有 `0.2.31` 安装包没有因这份源码快照而被重新构建或重新发布。

## OpenTypeless 来源

本次核实发现实际源码复用，不能把本快照描述为“仅借鉴创意”或“全仓独立原创”。上游仓库为 [tover0314-w/opentypeless](https://github.com/tover0314-w/opentypeless)，核对版本为 `1cfda3050e5ee5402e4ed86a31f372fd643fc9f7`。

以下五个文件在本快照的基准提交中与该上游版本逐字节一致，共 22,544 bytes、688 行：

- `src-tauri/src/output/clipboard.rs`
- `src-tauri/src/output/keyboard.rs`
- `src-tauri/src/output/mod.rs`
- `src-tauri/src/stt/assemblyai.rs`
- `src-tauri/src/stt/deepgram.rs`

其他改造文件也有源代码重合证据；具体核对方法和边界见 [来源核实报告](docs/open-source-provenance.md)。这些结果证明存在复用，不用于计算原创比例或断言每个文件的完整权属。

上游原有部分保留 **MIT License** 和 **Copyright (c) 2025 OpenTypeless Contributors**。完整原许可逐字节保存在 [LICENSES/OpenTypeless-MIT.txt](LICENSES/OpenTypeless-MIT.txt)。组合项目的 AGPL 主许可不移除第三方原有许可，也不把上游版权替换成 EcholIKE 的版权。

以下六个文档图像也与上游完全相同，保留同一 MIT 通知：`docs/images/app-history.png`、`app-main-light.png`、`app-settings.png`、`demo.gif`、`voice-flow-demo.gif`、`website.png`。截图中的第三方品牌和内容不因此成为 EcholIKE 独占资产。

## 项目图标的来源边界

九个应用图标未与该上游逐字节相同；项目历史记录了生成图稿及后续放大处理，早期 PNG 元数据含 OpenAI gpt-image 标识。未验证 C2PA 签名、输入参考素材或生成授权，因此本声明不主张这些文件的独占法定版权或完整清证。证据见 [图标补审](docs/icon-history-supplement.md)。侧栏 `🐉` 是系统字体渲染的独立字符，快照不分发该字体，也不将它作为应用图标的来源证明。

## 第三方与外部运行时

npm、Cargo 依赖保留各自的 MIT、Apache、BSD、ISC、MPL 等许可，不能将其包记录一律改成 AGPL。具体版本和核实范围见 [第三方许可清单](docs/third-party-licenses.md)。本源码快照不包含已安装依赖、Python/GLM-OCR/PyMuPDF 运行时、模型权重、签名私钥或生产环境配置。

`server/src/tests/tauri-updater-signature.test.ts` 保留了 `minisign-verify` 0.2.5 的公开公钥与签名测试向量，按原 MIT 许可使用，Copyright (c) 2019-2025 Frank Denis。原文见 [LICENSES/minisign-verify-MIT.txt](LICENSES/minisign-verify-MIT.txt)，固定上游和字节核对见 [测试向量来源回执](docs/minisign-test-vector-verification.json)。该向量没有私钥，仅用于签名验证测试。

后端 PDF 链路实际调用外部 Python 的 PyMuPDF；其 AGPL／商业双许可义务需要按实际分发或部署的版本履行。本项目的 AGPL 声明不代替 PyMuPDF 或其他运行时自身的许可。

## 商业销售与名称

允许在遵循 AGPL 的前提下销售安装包、托管服务、部署和技术支持，规则见 [COMMERCIAL.md](COMMERCIAL.md)。收费不会取消接收者及网络交互用户按适用许可获得对应源码的权利。本声明不授予闭源商业例外，也不授予第三方商标权。

EcholIKE 不声称与 OpenTypeless、Typeless 或其他参考产品存在隶属或认可关系。

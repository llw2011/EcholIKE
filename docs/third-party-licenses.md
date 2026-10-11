# EchoLike 0.2.31 第三方许可证据与分发边界

核查日期：2026-10-07。范围为源码提交 `a7ce82a89850a2527616c4cf950056258527b82a`；只核查许可证元数据、关键原文及源码调用边界。此次目标是独立的 `0.2.31` AGPL-3.0-only 源码快照，商业销售也遵循 AGPL。

## 已确认的依赖元数据

- [依赖许可清单](third-party-license-inventory.json)记录全部条目、原始许可表达式、版本、锁文件校验值、证据来源及覆盖率。npm 两锁分别为 307/307、211/211；Cargo 为 633/633 个第三方包。
- Cargo 的 390 条来自本机现有精确名称/版本的 `Cargo.toml`，保存该文件 SHA，但未验证完整缓存压缩包。其余 243 条来自 crates.io 官方精确版本 API，返回版本及 checksum 均与 Git 锁文件一致。正式核查并发上限 8、超时 12 秒、不自动重试，0 未确认、0 API 错误。没有安装、升级依赖或修改 registry/mirror。
- 此清单是上游声明的完整元数据覆盖，不是所有源码文件、原生库、构建 feature、二进制实际内容或著作权来源的完整验收。

## 可组合条件与必须保留的许可

主项目选择 AGPL-3.0-only，不会把第三方代码或数据原有许可改写为 AGPL。已确认的宽松许可声明未显示明显的整体组合阻断，必须保留适用的第三方版权、许可文本、免责、NOTICE 和例外条款。[GNU 许可说明](https://www.gnu.org/licenses/license-list.html.html)、[Apache 官方兼容说明](https://apache.org/licenses/GPL-compatibility.html)。

| 已确认对象                                                                                               | 原始声明与具体义务                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| npm/Cargo 中的 MIT、ISC、BSD、Apache-2.0 等依赖                                                          | 保留原版权及适用许可/免责。Apache-2.0 的原有 NOTICE 和修改声明应依其条件保留；可以用于 AGPL 整体，但不能抹掉原许可。原始 `OR` 表示选择分支，`AND` 表示同时满足，不能互相替换。 |
| `lightningcss` 1.32.0 与 11 个平台包                                                                     | MPL-2.0。前端锁标记 dev，Server 锁未标记 dev；这不等于实际分发/执行证明。若分发其代码或二进制，需要保留 MPL、相关源码及告知。                                                  |
| `cssparser` 0.36.0、`cssparser-macros` 0.6.1、`dtoa-short` 0.3.5、`option-ext` 0.2.0、`selectors` 0.36.1 | MPL-2.0。已检查本机这些包的 `.rs/.md/.toml`，未发现实际的 Secondary Licenses 不兼容标记。                                                                                      |
| `r-efi` 5.3.0、6.0.0                                                                                     | `MIT OR Apache-2.0 OR LGPL-2.1-or-later`，可选择 MIT 分支；不能据此说整个应用必须采用 LGPL。                                                                                   |
| `ring` 0.17.14                                                                                           | `Apache-2.0 AND ISC`。本机 `LICENSE` 明确区分 BoringSSL、ISC 新代码及 once_cell 来源，相关文本均应保留；这里不是二选一。                                                       |
| `target-lexicon` 0.12.16 等 LLVM-exception 表达式                                                        | 保留原 Apache-2.0 及适用 LLVM exception，不删除例外或把它变成主项目自有许可。                                                                                                  |
| `webpki-root-certs` 1.0.8                                                                                | CDLA-Permissive-2.0；共享其数据时提供协议文本。这是数据许可，不应改成 AGPL。[CDLA 原文](https://cdla.dev/permissive-2-0/)。                                                    |
| `libsqlite3-sys` 0.28.0 / `rusqlite` 0.31.0                                                              | Rust 包声明 MIT；底层 bundled SQLite 与包装层是不同来源，不能只按主项目许可覆盖底层来源说明。                                                                                  |

MPL 2.0 第 3.3 节允许满足条件的 Larger Work 与 GNU AGPLv3 组合，但原 MPL 文件仍须向接收者提供 MPL 许可选择。[Mozilla FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)、[MPL 原文](https://www.mozilla.org/en-US/MPL/2.0/)。`lightningcss/LICENSE` 的标准全文含 Exhibit B 示例，示例本身不证明该项目实际宣布不兼容；本机 JS 文件未见该声明。此检查不代替未来实际分发包的完整源码/标记复核。

锁中未发现仅限 GPL/AGPL、EPL、CDDL 或 LicenseRef 的声明。Rust GTK/WebKit bindings 的宽松许可不代表其系统原生库也采用相同许可。WebKit 官方说明原生代码包含 BSD/LGPL；将来若打包 Linux 原生库，应按实际库版本与分发方式保留原许可及对应源码/替换或重链接义务，不能给库批量换许可证。[WebKit 原生许可](https://docs.webkit.org/Other/Licensing.html)。本次没有分发系统库，也未验收 Linux 二进制。

## OCR 运行时：源码引用与实际分发分别核对

- `server/src/services/ocr/document-ocr-service.ts:80` 的页数检查明确执行 `import fitz`；同文件 377–391 行探测外部 Python 的 `-m glmocr` 与 PyMuPDF，730 行起构造实际 Pipeline 参数。这些不是 npm/Cargo 锁依赖，因此上述 100% 元数据覆盖不包含它们。
- `src-tauri/src/commands/ocr_runtime.rs:424` 在当前用户 `.local/bin` 查找 `vision-router.cmd`、`glmocr-pipeline.cmd`。`src-tauri/src/commands/ocr/pdf_render.rs:34` 的普通 Windows PDF 栅格化使用系统 `Windows.Data.Pdf`，不是此处的 PyMuPDF 链。
- `src-tauri/tauri.conf.json` 没有 externalBin/resources 声明；仓库权威规范 `docs/project-guidelines.md:69` 明确禁止将当前 Windows→WSL adapter、Paseo wrapper、硬编码用户路径纳入公开安装包/OTA，直到自有 runtime descriptor、取消链与许可证义务闭环。此次快照仅复制 Git tracked 源码，不包含这些外部运行时、Python 包或模型。

| 外部对象                          | 官方已确认许可及边界                                                                                                                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PyMuPDF / MuPDF                   | 官方提供 GNU AGPL 或 Artifex 商业许可。遵循 AGPL 的商业销售本身不会自动要求购买商业许可；若不能满足 AGPL 条件，需要另获 Artifex 授权。[PyMuPDF 官方许可](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright)。                      |
| GLM-OCR SDK/Pipeline 仓库代码     | 当前官方 `LICENSE` 为 Apache-2.0，官方 pyproject 声明依赖 PyMuPDF；不能因 SDK 主许可宽松就忽略依赖的 AGPL。[SDK LICENSE](https://github.com/zai-org/GLM-OCR/blob/main/LICENSE)、[pyproject](https://github.com/zai-org/GLM-OCR/blob/main/pyproject.toml)。 |
| GLM-OCR 模型权重与 PP-DocLayoutV3 | 官方分别声明 MIT 与 Apache-2.0；不是同一种资产、不是主项目 AGPL 自动覆盖的内容。[官方模型卡](https://huggingface.co/zai-org/GLM-OCR)、[官方 README](https://github.com/zai-org/GLM-OCR#license)。                                                          |
| Ollama 软件                       | 官方主项目为 MIT；各模型及嵌入第三方仍有各自条件。HTTP 接口调用不代表把 Ollama 或模型版权转移给 EchoLike。[Ollama LICENSE](https://github.com/ollama/ollama/blob/main/LICENSE)。                                                                           |

上述外部项目官方当前许可不证明本机或生产实际安装版本、patch、完整 Python 依赖及模型文件已验收。本次没有读取生产环境或运行服务，也没有修改/复制这些运行时。

Artifex 对其开源代码在服务中使用明确要求面向交互用户披露应用 AGPL 源码；不能仅凭外部进程、子进程或 HTTP 调用形式宣称免除许可义务。[Artifex 官方说明](https://artifex.com/licensing)。将来收费安装包/托管服务应提供与实际交付、部署版本一致的对应源码和构建/安装脚本；只公开历史 0.2.31 不证明一个不同版本的运行服务已经满足条件。[AGPL 对应源码与网络条款](https://www.gnu.org/licenses/agpl.en.html)。

## 本次快照的来源与残余问题

- 签名测试还有明确的第三方数据来源：`server/src/tests/tauri-updater-signature.test.ts` 的公开测试向量来自 `minisign-verify` 0.2.5。与官方标签提交 `3a91d03f86a8462a1af953c2854687d3f953d541` 核对三段 payload 一致（仅移除 Rust 字符串续行），其 MIT 原文与 Copyright (c) 2019-2025 Frank Denis 另存 [LICENSES/minisign-verify-MIT.txt](../LICENSES/minisign-verify-MIT.txt)。[固定来源回执](minisign-test-vector-verification.json)记录证据；这是现有测试数据的署名补全，不增加运行时依赖或改写 518/633 条锁清单。向量只含公钥与签名，没有私钥，且不对应生产公钥。

- 基准提交的根 `LICENSE` 与原 `NOTICE.md` 曾保存 OpenTypeless Contributors 的 MIT 说明。独立源码/资产比对已确认实际复用，详见 [来源报告](open-source-provenance.md)；本快照主 `LICENSE` 统一为 AGPL，上游 MIT 原文逐字节保留在 [LICENSES/OpenTypeless-MIT.txt](../LICENSES/OpenTypeless-MIT.txt)，原署名和适用范围见 [NOTICE](../NOTICE.md)，不擅自清除第三方许可。
- Git tracked 中有产品图标及 `docs/images` 二进制资产，没有单独字体包或 vendored 依赖目录。其著作权来源不能从 npm/Cargo 锁推定，也不能仅凭“原创”口头陈述当作全仓证明；应随源码来源审查记录。
- 此证据支持带清楚第三方保留条款的独立 AGPL 源码快照。它没有验证源码下载入口、未来安装包许可证告知、实际部署网络源码告知、完整对应源码可重建性或外部 OCR 运行时的分发合规。

公开清单将 390 条本机 Cargo manifest 的绝对缓存路径替换为 `${CARGO_REGISTRY_SRC}` 占位符；版本、许可、manifest SHA 和证据类型保持原始核实结果，不分发机器的缓存内容。

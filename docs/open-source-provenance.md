# 0.2.31 开源快照来源核实

## 核对对象与结论

本快照从正式源码提交 `a7ce82a89850a2527616c4cf950056258527b82a` 导出，包含此次许可、声明和相关显示文本修订。公开上游为 [OpenTypeless 的固定提交](https://github.com/tover0314-w/opentypeless/tree/1cfda3050e5ee5402e4ed86a31f372fd643fc9f7)，时间为 2026-06-15T06:07:33Z。

**核实结果不支持“只借鉴创意、没有复用源码”的描述。** 五个功能性 Rust 文件与该上游逐字节一致，共 22,544 bytes、688 行；此外还有改造文件的连续代码重合和六个完全相同的文档图像。主项目可以采用 AGPL，但须保留这些上游部分的 MIT 原许可和版权通知，见 [NOTICE](../NOTICE.md) 及 [原 MIT 全文](../LICENSES/OpenTypeless-MIT.txt)。

## 源码字节证据

| 文件                                | bytes | 行数 | SHA-256                                                            |
| ----------------------------------- | ----: | ---: | ------------------------------------------------------------------ |
| `src-tauri/src/output/clipboard.rs` | 3,046 |   85 | `b266b2d4c24fb5e8cf587977e362396d8beb85d813d40cbfed117ed56b317b70` |
| `src-tauri/src/output/keyboard.rs`  | 5,217 |  160 | `b962507fcd8f52b7a55de63ed232311cec44d7585b82a3b677428ea6a9c523ce` |
| `src-tauri/src/output/mod.rs`       | 2,192 |   67 | `6065abfb22b3205247be63f51ea13af27a9b43c5c299875f1f48873715146c4b` |
| `src-tauri/src/stt/assemblyai.rs`   | 5,649 |  164 | `439ed960a9c8a692904c32645d26471091bf750dbe6f142a4ecff3933cd2f3b6` |
| `src-tauri/src/stt/deepgram.rs`     | 6,440 |  212 | `df2b9e4891ba08fa79bee1b423d8772850f684dca8d0261205a2111cc391b9f4` |

审查分别比较 Git 中的原始文件与固定上游归档；另一次独立验证直接读取五个固定 raw URL，核对完整字节、长度、行数和 SHA。结果均一致，详见 [独立验证回执](independent-upstream-verification.json) 与 [完整来源证据](source-provenance.json)。

同路径连续块比较的门槛为至少六行且至少 200 bytes，38 个文件中记录 4,085 行重合块。这些块包含常见语法和接口结构，不能据此计算原创比例或直接判定每行权属。最早可达的本地恢复提交 `41246d1fa79ffa2f9586d24daed9a923905ac11d` 有 16 个功能源码文件、106,270 bytes、3,364 行与上游完全相同；恢复提交之前的开发历史未包含在可达 Git 图中。

## 图像与图标

六个完全相同的上游图像为 `docs/images/` 下的 `app-history.png`、`app-main-light.png`、`app-settings.png`、`demo.gif`、`voice-flow-demo.gif`、`website.png`。保留上游项目的 MIT 通知；截图出现的品牌、界面及内容不会因该声明转成 EcholIKE 独占权利。

九个应用 PNG/ICO/ICNS 文件没有与本次固定上游完全相同的字节。进一步核对项目历史：

- `ea2ca6cbac14b768caeb5eb0e4dcf650730698a4` 记录替换为 E／闪电几何 SVG；该中间文件后来删除。
- `cc64c026d62953f974d7eed23270791e0776e325` 记录引入生成图稿，最初的 1024×1024 PNG 的 caBX/C2PA 元数据含 OpenAI Media Service API、gpt-image、trainedAlgorithmicMedia 及创建动作标识。
- `f26813b3532d1c157c2d813f0d8d85466c49896b` 记录项目图稿放大处理；九个 `0.2.31` 文件均与该提交逐字节一致。

这条记录说明生成和后处理方法，**未验证 C2PA 签名、输入参考素材或生成授权，不构成独占版权或完整素材清证结论**。逐文件证据与限定结论见 [图标补审报告](icon-history-supplement.md) 和 [JSON](icon-history-supplement.json)。侧栏 `🐉` 是系统 emoji 字体渲染的独立字符，不能当作这九个二进制文件的来源；快照没有分发系统字体。

## 依赖与本次修改

518 条 npm、633 条 Cargo 的第三方许可元信息已核对，详见 [第三方许可报告](third-party-licenses.md)。完整原许可不被主项目 AGPL 替换。外部 OCR 运行时、模型、实际安装环境和完整二进制对应源码可重建性有各自边界；本次没有分发它们或验收运行服务。

签名测试沿用了 `minisign-verify` 0.2.5 的公开测试向量，三段公钥／签名 payload 与固定官方标签一致，补全其 [MIT 原文](../LICENSES/minisign-verify-MIT.txt) 和作者通知，证据见 [来源回执](minisign-test-vector-verification.json)。它没有私钥，不能把签名文本中出现的“secret key”注释误判为泄漏私钥。

此次导出原有 546 个 Git tracked 文件，没有 Git 历史、工作树秘密、已安装依赖或构建产物。许可修订落在主许可证、来源通知、包自身 license 字段、README、项目及商业声明、贡献指引、About 文案与对应测试；第三方锁条目和功能实现保持基准事实。社区配置移除上游维护者、赞助和支持渠道的误指向；历史记录和来源链接保留为历史证据。

AGPL 全文采用 SPDX 的 `AGPL-3.0-only` 文本，SHA-256 为 `d8a6cc31abc16b6748c7a21f21611f5a1ec33f67d22ca23d7da1c19b95496bee`。原 MIT 全文从基准提交逐字节保存，SHA-256 为 `244b7cf218fcf3164c912775c6b97e2b70be0cf8b62233a1ade2b5fab0aa7084`。本仓库提供独立源码快照，没有重新构建或发布历史安装包；自行分发和托管时仍须履行对应版本的 AGPL 义务。

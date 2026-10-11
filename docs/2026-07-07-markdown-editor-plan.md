# EcholIKE 内置 Markdown 编辑器落地计划

## 背景

EcholIKE 已经在多个核心链路里产生或消费 Markdown：

- 屏幕 OCR 与附件 OCR 要求模型输出工整 Markdown，并在首页结果弹窗里提供预览、复制、保存 `.md`、导出 Word。
- AI 回答、追问上下文、历史记录、导出文件名清洗等逻辑都围绕“可复制、可整理、可交付的文本”展开。
- 当前 `HomePage/Workbench.tsx` 内已有轻量 Markdown 预览解析和 `.echo-markdown-view` 样式，但它只是结果展示，不是可编辑工作区。

因此新增一个内置轻量 Markdown 编辑器是合理的。它不应该变成 Notion/Obsidian，而应该成为 EcholIKE 的“文本整理台”：把 OCR、AI、历史和导出能力串起来，让用户在主应用里完成最后一公里编辑。

## 目标

第一版目标：

- 提供轻量 Markdown 源码编辑器。
- 支持编辑、预览、分屏预览三种视图。
- 支持常用 Markdown 工具栏操作。
- 支持从 OCR 结果、AI 回答、历史记录一键送入编辑器。
- 支持复制 Markdown、保存 `.md`、导出 `.docx`。
- 主题、字体、边框、按钮、预览样式跟随主应用换肤设置。
- 保持本地优先，不引入云同步、协作、复杂富文本模型。

明确不做：

- 不做多人协作。
- 不做完整笔记系统、文件树、双链、标签库。
- 不做复杂 WYSIWYG 块编辑。
- 不做图片资产管理和拖拽排版。
- 不做插件市场。

## 产品定位

推荐命名：

- 主功能名：`Markdown 编辑器`
- 面向用户的轻量文案：`整理文稿`
- 入口行为：`发送到编辑器` / `整理 Markdown`

编辑器是工作流增强能力，不是首页主角。入口应嵌在已有 OCR/AI/历史结果附近，而不是新增一个营销式页面。

## 互操作原则

内置编辑器不做成孤岛。它应该像 EcholIKE 的“文本中转站”，让现有能力围绕同一份 Markdown 草稿协作。

核心原则：

- 任何产生文本的能力都可以 `发送到编辑器`：截图 OCR、附件 OCR、AI 回答、历史记录、手动输入。
- 任何编辑后的草稿都可以回到现有输出链路：复制 Markdown、保存 `.md`、导出 `.docx`。
- AI 能力应优先作用于选区，其次作用于全文，避免用户为了润色一小段而复制粘贴。
- OCR 和 AI 的原始结果必须保持只读，不被编辑器反向污染；编辑器保存的是整理后的草稿。
- “追加 / 替换 / 新建”是跨功能发送文本时的基本三态，避免用户当前草稿被静默覆盖。
- 主题、按钮、弹层、预览、编辑区都跟随主应用 token，不允许出现编辑器自己的孤立皮肤。

建议统一一个打开入口函数：

```ts
openMarkdownEditor({
  source,
  title,
  text,
  sourceName,
  mode: 'new' | 'append' | 'replace',
})
```

第一版可以由 `HomePage` 内部持有；等入口变多后再抽到 store 或专用 hook。

## 开源参考与取舍

### 采用倾向

CodeMirror 6 作为编辑器核心。

理由：

- 官方模块化，核心由 `@codemirror/state`、`@codemirror/view` 等组成。
- 有 Markdown language support。
- 适合源码编辑、快捷键、撤销重做、搜索、选择区替换等能力。
- 比完整 WYSIWYG 编辑器更可控，适合 EcholIKE 的桌面工具气质。

参考：

- CodeMirror reference: https://codemirror.net/docs/ref/
- `@codemirror/lang-markdown`: https://codemirror.net/docs/ref/#lang-markdown

### 可参考但不直接采用

TOAST UI Editor。

- 值得参考它的 Markdown / WYSIWYG 切换、Live Preview、Scroll Sync、工具栏组织。
- 不建议第一版直接接入，整体偏重，且容易把产品方向带到完整文档编辑套件。
- 参考：https://ui.toast.com/tui-editor/

MDXEditor。

- 值得参考它的工具栏、表格、代码块、Markdown shortcuts。
- 它偏富文本/MDX，功能面比当前需要更大。
- 参考：https://mdxeditor.dev/editor/docs/getting-started

Milkdown。

- 值得参考插件化和 WYSIWYG Markdown 体验。
- 第一版不采用，避免引入 ProseMirror 生态的复杂状态模型。
- 参考：https://milkdown.dev/

### 预览渲染与安全

候选：

- `markdown-it`：轻量、成熟，适合 Markdown 到 HTML。
- `DOMPurify`：用于清洗 HTML，防止预览里的脚本和危险链接。
- `rehype-sanitize`：如果后续转向 unified/remark/rehype 管线，可作为安全层。

参考：

- markdown-it: https://markdown-it.github.io/markdown-it/
- DOMPurify: https://github.com/cure53/DOMPurify
- rehype-sanitize: https://unifiedjs.com/explore/package/rehype-sanitize/

第一版建议：

- 编辑器用 CodeMirror 6。
- 预览先抽离并复用现有 `MarkdownView` 行为，保证导出/预览不回退。
- 如果要支持更完整 GFM，再引入 `markdown-it` + `DOMPurify`，并用测试覆盖 HTML 注入。

## 当前项目接入点

现有相关文件：

- `src/components/HomePage/Workbench.tsx`
  - OCR、附件、AI 问答主工作区。
  - 已有 Markdown 结果弹窗、复制、保存 `.md`、导出 `.docx`。
  - 已有 `parseMarkdownBlocks` 和 `.echo-markdown-view` 使用点。
- `src/lib/tauri.ts`
  - `saveMarkdownFile`
  - `exportMarkdownDocx`
  - `getHistory`
  - OCR 与 AI 调用边界。
- `src/stores/appStore.ts`
  - `history`
  - `config.theme`
  - `config.theme_profile`
  - `config.capsule_style`
- `src/hooks/useTheme.ts`
  - 负责写入 `dark`、`data-theme-profile`、`data-capsule-style`。
- `src/styles/globals.css`
  - 已有 `.echo-markdown-view` 预览样式。
  - 已有主题 token 体系。
- `src-tauri/src/commands/ocr.rs`
  - OCR 清洗、Markdown 保存、DOCX 导出。
  - 后续若做草稿文件持久化，可在这里或新增 command。

## 信息架构

新增功能形态建议：

1. 结果弹窗内新增 `整理` / `发送到编辑器` 按钮。
2. AI 回答区域新增 `整理` 按钮。
3. 历史记录项新增 `发送到编辑器`。
4. 首页右侧或全屏弹层打开 `Markdown 编辑器`。
5. 编辑器内提供：
   - 顶部工具栏。
   - 左侧编辑区。
   - 右侧预览区或可切换预览。
   - 底部状态：字数、行数、是否有未保存草稿、来源。

推荐第一版用弹层或抽屉，不新增全局路由。原因是 `src/lib/router.ts` 当前只有 `home | settings`，编辑器更像 HomePage 工作流中的整理面板，而不是一级页面。

## 交互设计

### 打开方式

从 OCR 结果打开：

- 用户完成截图或附件 OCR。
- 结果弹窗显示 Markdown 预览。
- 点击 `整理`。
- 打开编辑器，标题默认使用 OCR source name/window title。
- 正文填入清洗后的 OCR Markdown。

从 AI 回答打开：

- 用户得到 AI 回答。
- 点击 `整理`。
- 打开编辑器，标题默认使用当前场景或“AI 回答”。
- 正文填入回答文本。

从历史打开：

- 用户在历史记录中选择一条。
- 点击 `发送到编辑器`。
- 可选择 `新建草稿` / `追加到当前草稿` / `替换当前草稿`。

### 编辑器动作

MVP 工具栏：

- 标题：H1/H2/H3。
- 加粗。
- 斜体。
- 行内代码。
- 代码块。
- 引用。
- 无序列表。
- 有序列表。
- 链接。
- 表格模板。
- 撤销/重做。
- 搜索。
- 复制 Markdown。
- 保存 `.md`。
- 导出 Word。

后续增强：

- 选中文本后调用 AI：润色、翻译、总结、改写。
- 将 AI 结果 `替换选区` / `插入到下方` / `追加到文末`。
- 从剪贴板导入。
- 一键清理 OCR 尾部噪声。
- 表格格式化。

### 视图模式

第一版视图：

- `编辑`：只显示 CodeMirror。
- `预览`：只显示 Markdown preview。
- `分屏`：左编辑，右预览。

默认：

- 桌面宽度充足时默认 `分屏`。
- 小窗口/窄屏默认 `编辑`，预览通过 tab 切换。

## 主题联动

编辑器必须继承主应用主题，不做独立主题系统。

规则：

- 读取现有 DOM 状态：
  - `document.documentElement.classList.dark`
  - `data-theme-profile`
  - `data-capsule-style`
- CSS 优先使用现有 token：
  - `--echo-app-bg`
  - `--echo-surface`
  - `--echo-surface-2`
  - `--echo-text`
  - `--echo-muted`
  - `--echo-border-strong`
  - `--echo-border-soft`
  - `--echo-accent`
  - `--echo-accent-soft`
  - `--echo-ok`
  - `--echo-warn`
  - `--echo-danger`
- CodeMirror theme 应用这些 token，而不是写死颜色。
- 预览区复用 `.echo-markdown-view` 的排版，并补齐主题 token。
- 编辑器 toolbar 使用现有 `.echo-button`、icon button、segmented control 风格。

验收：

- 在 `echo`、`pearl`、`mint`、`graphite`、`ray`、`linear` 下都能读、能写、能看清光标和选区。
- 暗色/亮色/system 切换后编辑器无需刷新即可跟随。
- 不出现单独一套突兀的 CodeMirror 默认浅色/深色皮肤。

实现约束：

- `useTheme` 继续是唯一写入 DOM 主题状态的位置。
- 编辑器组件只读取 CSS 变量或 DOM data attribute，不单独保存 theme state。
- CodeMirror theme extension 应由 CSS token 生成，并在 theme/profile/capsule 变化时重新计算。
- 预览区、工具栏、状态栏不要写死颜色；新增颜色必须先进入 `DESIGN.md` 已列 token 或现有 CSS token。
- OTA 前至少人工切换一次亮色、暗色、system 和两个 profile，确认编辑区光标、选区、搜索高亮可见。

## 技术方案

### 新增模块

建议目录：

```text
src/components/MarkdownEditor/
  MarkdownEditorShell.tsx
  MarkdownEditorToolbar.tsx
  MarkdownEditorInput.tsx
  MarkdownEditorPreview.tsx
  markdownActions.ts
  markdownPreview.ts
  markdownDraft.ts
  __tests__/
```

职责：

- `MarkdownEditorShell.tsx`
  - 编辑器弹层/抽屉外壳。
  - 管理标题、来源、模式、关闭确认。
- `MarkdownEditorInput.tsx`
  - CodeMirror 适配层。
  - 接收 `value/onChange/themeProfile/dark`。
- `MarkdownEditorToolbar.tsx`
  - 工具栏按钮。
  - 调用 `markdownActions.ts` 操作选区。
- `MarkdownEditorPreview.tsx`
  - 预览渲染。
  - 第一阶段抽出现有 `MarkdownView`。
  - 后续可切换到 `markdown-it` + sanitizer。
- `markdownActions.ts`
  - 纯函数，便于测试：
    - `wrapSelection`
    - `toggleLinePrefix`
    - `insertTable`
    - `insertCodeBlock`
    - `insertLink`
- `markdownDraft.ts`
  - 草稿模型、来源模型、脏状态判断。

### 依赖建议

Phase 1 需要：

```text
@codemirror/state
@codemirror/view
@codemirror/commands
@codemirror/search
@codemirror/lang-markdown
@codemirror/language
@lezer/highlight
```

可选后续：

```text
markdown-it
dompurify
```

暂不引入：

```text
@toast-ui/react-editor
@mdxeditor/editor
milkdown
```

### 状态模型

建议类型：

```ts
type MarkdownEditorSource = 'ocr' | 'upload_ocr' | 'screen_ocr' | 'ai_answer' | 'history' | 'manual'

interface MarkdownDraft {
  id: string
  title: string
  text: string
  source: MarkdownEditorSource
  sourceName?: string
  createdAt: string
  updatedAt: string
  dirty: boolean
}
```

第一版不必进全局 store。推荐由 `HomePage` 管理当前编辑器草稿状态：

- `editorDraft: MarkdownDraft | null`
- `editorOpen: boolean`
- `openMarkdownEditor(input, mode)`

后续如需要跨路由保留，再考虑 Zustand store。

### 持久化策略

MVP：

- 关闭前若 dirty，提示用户保存或放弃。
- 可保存 `.md` 到下载目录，复用 `saveMarkdownFile`。

Phase 2：

- 自动保存最近一个草稿到 Tauri store 或 localStorage。
- 启动时如果有未完成草稿，提示恢复。

Phase 3：

- 新增多个本地草稿管理。
- 这一步需要谨慎，不要变成笔记系统。

## 与现有能力交互

### OCR

入口：

- 屏幕 OCR 结果弹窗。
- 附件 OCR 结果弹窗。

行为：

- `整理` 按钮将 `cleanOcrResult(result).text` 送入编辑器。
- 标题用 `source_name || window_title || echolike-ocr`。
- 导出 Word 时继续复用 `exportMarkdownDocx`，保留 `page_count` 分页逻辑。

验收：

- OCR 结果被编辑后，保存 `.md` 用编辑后的文本。
- 导出 Word 用编辑后的文本。
- 原 OCR 结果仍可复制/保存，不被编辑器误改。

### AI 回答

入口：

- AI 回答区域。
- OCR 追问回答区域。

行为：

- `整理` 将回答作为新草稿。
- 后续支持选中文本再问 AI。

验收：

- AI 回答不因进入编辑器而丢失。
- 编辑器内可复制/保存/导出。

### 历史记录

入口：

- 历史列表项。

行为：

- 发送 `raw_text` 或 `final_text` 到编辑器。
- 第一版可先使用当前历史展示中最接近“最终文本”的字段。
- 历史项发送到编辑器时默认新建草稿；如果当前编辑器已有 dirty 草稿，再弹出 `追加 / 替换 / 新建`。

验收：

- 历史项能打开编辑器。
- 不改变历史原始记录。

### 导出

复用：

- `.md`：`saveMarkdownFile(fileName, text)`
- `.docx`：`exportMarkdownDocx({ text, source_name, page_count })`

后续可加：

- HTML 导出。
- PDF 导出。

PDF 不放第一版，避免引入渲染/分页复杂度。

### 剪贴板和输出

第一版：

- `复制 Markdown`。
- `复制预览纯文本` 可作为后续能力。

不建议：

- 直接把编辑器内容模拟键盘输出到当前应用。这个动作风险高，应等基础编辑器稳定后再做。

## 安全边界

Markdown 预览必须默认安全：

- 不执行 HTML 内脚本。
- 不允许 `javascript:` 链接。
- 不允许内联事件属性。
- 不允许 iframe/object/embed。
- 外链点击建议 `target="_blank"` 且加 `rel="noreferrer"`。

MVP 可以选择更保守策略：

- 不渲染原始 HTML，只把 HTML 当文本或跳过。

如果引入 `markdown-it`：

- 默认 `html: false`。
- 如未来允许有限 HTML，必须使用 DOMPurify 或 rehype-sanitize。

测试必须覆盖：

- `<script>alert(1)</script>`
- `[x](javascript:alert(1))`
- `<img src=x onerror=alert(1)>`

## 可访问性与快捷键

第一版快捷键：

- `Ctrl/Cmd+B`：加粗。
- `Ctrl/Cmd+I`：斜体。
- `Ctrl/Cmd+K`：链接。
- `Ctrl/Cmd+S`：保存 `.md`。
- `Ctrl/Cmd+F`：搜索。
- `Esc`：关闭弹层前检查 dirty。

可访问性：

- 工具栏按钮必须有 `aria-label`。
- icon button 必须有 tooltip 或可读标签。
- 弹层 focus trap。
- 关闭时焦点回到触发按钮。
- 预览与编辑 tab 可键盘切换。

## UI 原则

遵守 `DESIGN.md`：

- 这是桌面工具，不做大 hero，不做装饰卡片。
- 编辑器表面要像工作区，不像博客后台。
- 工具栏用紧凑 icon button。
- 不把卡片套卡片。
- 文本不挤压、不溢出按钮。
- 分屏区域高度稳定，避免预览内容加载导致工具栏跳动。

布局建议：

```text
┌──────────────────────────────────────────────┐
│ 标题 / 来源                 编辑 预览 分屏  │
│ [工具栏按钮...]             复制 保存 导出  │
├───────────────────────┬──────────────────────┤
│ Markdown 编辑区        │ 预览区               │
│ CodeMirror             │ echo-markdown-view   │
└───────────────────────┴──────────────────────┘
```

窄屏：

```text
标题 / 来源
工具栏
编辑 / 预览 tabs
单列内容区
```

## 分期计划

### Phase 0：计划与依赖确认

产出：

- 本计划书。
- 确认第一版采用 CodeMirror 6。
- 确认预览先复用现有 renderer，后续再决定是否引入 `markdown-it`。

验收：

- 文档落库。
- 后续每个阶段按本文件更新状态。

### Phase 1：抽离现有 Markdown 预览

任务：

- 从 `HomePage/Workbench.tsx` 抽出 `MarkdownEditorPreview` 或通用 `MarkdownPreview`。
- 保持 `.echo-markdown-view` 样式不回退。
- 保持现有 OCR 结果弹窗行为不变。

验收：

- 当前 OCR Markdown 预览测试全部通过。
- 表格、标题、列表、代码块显示不回退。
- Word 导出和 `.md` 保存不受影响。

### Phase 2：编辑器壳与 CodeMirror 输入

任务：

- 安装 CodeMirror 6 相关依赖。
- 新增 `MarkdownEditorShell`。
- 新增 `MarkdownEditorInput`。
- 接入主应用主题 token。
- 支持编辑/预览/分屏三种模式。

验收：

- 手动输入 Markdown 能实时预览。
- 暗色/亮色/主题 profile 切换后编辑器同步更新。
- CodeMirror 默认主题颜色不外泄。
- 弹层打开关闭无 console error。

### Phase 3：工具栏与 Markdown 操作

任务：

- 新增 toolbar。
- 用纯函数实现文本变换。
- 支持加粗、斜体、标题、列表、引用、代码块、链接、表格。

验收：

- 有选区时包裹选区。
- 无选区时插入模板并放置光标。
- 多行列表转换稳定。
- 工具栏按钮不会撑坏布局。

### Phase 4：接入 OCR / AI / 历史入口

任务：

- OCR 结果弹窗加 `整理`。
- AI 回答区域加 `整理`。
- 历史项加 `发送到编辑器`。
- 支持新建/追加/替换当前草稿。

验收：

- OCR、AI、历史都能打开编辑器。
- 原结果内容不被编辑器污染。
- 关闭 dirty 草稿有确认。

### Phase 5：复制、保存、导出闭环

任务：

- 编辑器内支持复制 Markdown。
- 保存 `.md` 复用 `saveMarkdownFile`。
- 导出 Word 复用 `exportMarkdownDocx`。
- 导出时使用编辑后的内容。

验收：

- `.md` 文件内容等于编辑器当前内容。
- `.docx` 内容来自编辑器当前内容。
- 空内容不可保存/导出，并给出明确提示。
- 导出失败不关闭编辑器、不丢草稿。

### Phase 6：草稿恢复

任务：

- 自动保存最近一个草稿。
- 启动或重新打开编辑器时提示恢复。
- 只保留一个最近草稿，避免笔记系统化。

验收：

- 输入后意外关闭应用，再打开可恢复。
- 保存或明确丢弃后清理草稿。
- 草稿不包含云端密钥、token、用户敏感配置。

### Phase 7：AI 选区互动

任务：

- 选中文本后支持 `润色`、`翻译`、`总结`。
- 结果可替换选区、插入下方、追加到文末。
- 复用当前 LLM 配置来源：后端托管或本机配置。

验收：

- 无 LLM 可用时按钮禁用或提示配置。
- AI 调用错误不破坏原文。
- 替换/插入/追加都有测试。

### Phase 8：预览渲染增强与安全收口

任务：

- 评估是否引入 `markdown-it` + `DOMPurify`。
- 补齐 GFM 表格、链接、代码高亮需求。
- 明确 raw HTML 策略。

验收：

- XSS 测试通过。
- 表格与现有 Word 导出解析行为没有明显冲突。
- 预览样式仍跟随主题。

## 测试计划

单元测试：

- `markdownActions.ts`
  - wrap selection。
  - toggle heading。
  - toggle list。
  - insert table。
  - insert link。
- `markdownDraft.ts`
  - dirty 判断。
  - source metadata。

组件测试：

- 编辑器打开后显示来源标题。
- 工具栏按钮修改文本。
- 模式切换显示编辑/预览/分屏。
- OCR 结果点击 `整理` 后内容进入编辑器。
- AI 回答点击 `整理` 后内容进入编辑器。
- 保存 `.md` 调用 `saveMarkdownFile`。
- 导出 Word 调用 `exportMarkdownDocx`。

安全测试：

- Markdown 预览不执行 script。
- 危险链接不生成可点击 `javascript:`。
- HTML 事件属性不进入 DOM。

主题测试：

- 切换 `theme` 后编辑器根节点类名或 CSS 变量更新。
- 切换 `theme_profile` 后预览和 CodeMirror surface 不突兀。

回归测试：

- OCR 弹窗现有复制、保存、导出 Word 行为不回退。
- 附件 PDF 导出图片不受影响。
- 历史列表渲染不受影响。

## 验收标准

MVP 完成定义：

- 用户可以从 OCR 结果打开编辑器。
- 用户可以编辑 Markdown。
- 用户可以预览 Markdown。
- 用户可以复制、保存 `.md`、导出 `.docx`。
- 编辑器视觉跟随主应用主题。
- 关闭未保存内容时不会静默丢失。
- 相关测试通过。

可发布标准：

- `npm test -- --run` 通过。
- `npm run build` 通过。
- 如涉及 Tauri 命令，`cargo test` 或相关 Rust 单测通过。
- `git diff --check` 通过。
- 需要发 OTA 时，走 `npm run build:desktop`。

## 风险与对策

风险：编辑器依赖过重。

- 对策：第一版只引入 CodeMirror 6 必要包，不引入 TOAST UI / MDXEditor / Milkdown。

风险：预览和 Word 导出解析不一致。

- 对策：先复用现有预览逻辑；若引入 markdown-it，增加表格、标题、代码块与 DOCX 导出对照测试。

风险：主题适配割裂。

- 对策：CodeMirror theme 只使用 EcholIKE CSS token；所有 profile 截图检查。

风险：Markdown 预览 XSS。

- 对策：默认不允许 raw HTML；如允许，必须 sanitize。

风险：功能膨胀成笔记系统。

- 对策：草稿只做“最近一个恢复”；文件管理和多文档库暂不做。

## 后续记录

- 2026-07-07：创建计划。第一版方向确定为 CodeMirror 6 源码编辑器，预览先复用现有 Markdown renderer，核心目标是与 OCR、AI、历史、导出和主题系统互通。
- 2026-07-07：完成 Phase 1。已把 `HomePage/Workbench.tsx` 内的 Markdown 预览抽到 `src/components/MarkdownEditor/MarkdownEditorPreview.tsx`，解析逻辑抽到 `markdownPreview.ts`，并补充标题、列表、表格、代码块、内联格式和 raw HTML 安全断言。当前 OCR 结果弹窗继续复用同一预览组件。
- 2026-07-07：完成 Phase 2。已安装 CodeMirror 6 必要依赖，新增 `MarkdownEditorShell.tsx`、`MarkdownEditorInput.tsx`、`markdownDraft.ts`、`markdownEditorTheme.ts`，支持编辑 / 预览 / 分屏三种模式；CodeMirror theme 使用 EcholIKE CSS token，并通过监听 `class`、`data-theme-profile`、`data-capsule-style` 跟随主应用换肤。
- 2026-07-07：完成 Phase 3。已新增 `MarkdownEditorToolbar.tsx` 和 `markdownActions.ts`，支持标题 H1/H2/H3、加粗、斜体、行内代码、代码块、引用、无序列表、有序列表、链接、表格模板；CodeMirror 选区会同步到 Shell，工具栏操作后会回写文本并恢复/选中插入区域。已补纯函数断言和 Shell 工具栏断言。
- 2026-07-07：完成 Phase 4。`HomePage` 已管理当前 Markdown 草稿和编辑器弹层；OCR 结果弹窗、AI 回答区域、最近历史项均可发送到编辑器。若已有 dirty 草稿，会弹出新建 / 追加 / 替换选择。CodeMirror 编辑器改为懒加载，避免主工作台首屏直接打包完整编辑器内核。
- 2026-07-07：完成 Phase 5。编辑器底部已支持复制 Markdown、保存 `.md`、导出 Word；保存复用 `saveMarkdownFile`，导出 Word 复用 `exportMarkdownDocx` 和现有二进制下载链路，保存成功后会清理当前草稿 dirty 状态。已补 Shell 动作断言和 HomePage 保存/导出断言。
- 2026-07-07：完成 Phase 6。新增最近一个 dirty 草稿的 localStorage 持久化，存储键为 `echolike.markdownEditor.recentDraft.v1`；启动时如发现未保存草稿，会提示恢复或明确丢弃。保存 `.md` 成功后会清理持久化草稿。已补序列化校验、恢复、丢弃、保存后清理断言。
- 2026-07-07：完成 Phase 7。编辑器新增 AI 工具栏，支持润色、翻译、总结；处理范围优先使用选区，无选区时回退全文。AI 返回内容先进入结果面板，不会直接改写原文；用户可选择替换选区、插入下方或追加文末。已复用当前本机/后台托管 LLM 配置，并补充 prompt、替换、插入、追加及 HomePage 调用链断言。
- 2026-07-07：完成 Phase 8。第一版继续采用自研轻量预览 parser，明确 raw HTML 只作为文本渲染，不引入可执行 HTML DOM；危险链接、`script`、带事件属性的 `img` 均不会生成 live DOM。已覆盖 XSS 安全断言，表格、标题、列表、代码块等现有 OCR/导出预览行为保持一致。
- 2026-07-07：Markdown 编辑器 MVP 闭环。Phase 0-8 均已落地，当前边界保持为“最近一个本地草稿 + OCR/AI/历史整理台 + Markdown/Word 输出”，暂不扩展为多文档笔记系统。

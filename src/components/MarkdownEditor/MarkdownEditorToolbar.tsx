import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Strikethrough,
  Table2,
  Underline,
} from 'lucide-react'
import { Tooltip } from '../Tooltip'
import type { MarkdownAction } from './markdownActions'

export interface MarkdownEditorToolbarProps {
  onAction: (action: MarkdownAction) => void
  disabled?: boolean
}

const toolbarGroups: Array<
  Array<{
    action: MarkdownAction
    label: string
    icon: typeof Bold
  }>
> = [
  [
    { action: 'heading-1', label: '一级标题', icon: Heading1 },
    { action: 'heading-2', label: '二级标题', icon: Heading2 },
    { action: 'heading-3', label: '三级标题', icon: Heading3 },
  ],
  [
    { action: 'bold', label: '加粗', icon: Bold },
    { action: 'italic', label: '斜体', icon: Italic },
    { action: 'strikethrough', label: '删除线', icon: Strikethrough },
    { action: 'underline', label: '下划线', icon: Underline },
    { action: 'highlight', label: '高亮', icon: Highlighter },
    { action: 'inline-code', label: '行内代码', icon: Code2 },
  ],
  [
    { action: 'quote', label: '引用', icon: Quote },
    { action: 'unordered-list', label: '无序列表', icon: List },
    { action: 'ordered-list', label: '有序列表', icon: ListOrdered },
    { action: 'task-list', label: '任务列表', icon: ListChecks },
  ],
  [
    { action: 'link', label: '插入链接', icon: Link },
    { action: 'table', label: '插入表格', icon: Table2 },
    { action: 'code-block', label: '代码块', icon: Code2 },
    { action: 'horizontal-rule', label: '分隔线', icon: Minus },
  ],
  [
    { action: 'align-left', label: '左对齐', icon: AlignLeft },
    { action: 'align-center', label: '居中', icon: AlignCenter },
    { action: 'align-right', label: '右对齐', icon: AlignRight },
  ],
]

export function MarkdownEditorToolbar({ onAction, disabled = false }: MarkdownEditorToolbarProps) {
  return (
    <div className="echo-markdown-toolbar" role="toolbar" aria-label="Markdown 工具栏">
      {toolbarGroups.map((group, groupIndex) => (
        <div className="echo-markdown-toolbar-group" role="group" key={groupIndex}>
          {group.map((item) => {
            const Icon = item.icon
            return (
              <Tooltip key={item.action} content={item.label} side="bottom">
                <button
                  type="button"
                  className="echo-markdown-tool-button"
                  aria-label={item.label}
                  onClick={() => onAction(item.action)}
                  disabled={disabled}
                >
                  <Icon size={16} />
                </button>
              </Tooltip>
            )
          })}
        </div>
      ))}
    </div>
  )
}

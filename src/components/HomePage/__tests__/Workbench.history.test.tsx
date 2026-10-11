import { describe } from 'vitest'
import { expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { workbenchTestHarness } from './workbenchTestHarness'

const {
  ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY,
  homePageFixture: HomePage,
  tauriMocks,
  useAppStore,
} = workbenchTestHarness

describe('HomePage History', () => {
  it('shows recent history content first and keeps process names as metadata', () => {
    useAppStore.setState({
      history: [
        {
          id: 11,
          created_at: '2026-07-07T09:00:00.000Z',
          app_name: 'chrome.exe',
          app_type: 'Browser',
          raw_text: '浏览器里的可读内容',
          polished_text: '',
          language: 'zh',
          duration_ms: 600,
        },
        {
          id: 12,
          created_at: '2026-07-07T10:00:00.000Z',
          app_name: 'Notepad3.exe',
          app_type: 'Writing',
          raw_text: '\u0000\u0001',
          polished_text: '',
          language: null,
          duration_ms: 200,
        },
      ],
    })

    render(<HomePage />)

    expect(screen.getByText('浏览器里的可读内容')).toBeInTheDocument()
    expect(screen.getByText(/Chrome/)).toBeInTheDocument()
    expect(screen.queryByText('chrome.exe')).not.toBeInTheDocument()
    expect(screen.getByText('这条历史没有可读文本')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '发送到编辑器' })[1]).toBeDisabled()
  })

  it('uses one dynamic delete action and keeps selection separate from editor actions', async () => {
    tauriMocks.deleteHistoryEntries.mockResolvedValue([21])
    useAppStore.setState({
      history: [
        {
          id: 21,
          created_at: '2026-07-07T09:00:00.000Z',
          app_name: 'Chrome',
          app_type: 'Browser',
          raw_text: '待删除记录',
          polished_text: '',
          language: 'zh',
          duration_ms: 600,
        },
        {
          id: 22,
          created_at: '2026-07-07T10:00:00.000Z',
          app_name: 'Code',
          app_type: 'Development',
          raw_text: '保留记录',
          polished_text: '',
          language: 'zh',
          duration_ms: 800,
        },
      ],
    })

    render(<HomePage />)

    const panel = screen.getByRole('region', { name: '最近历史' })
    expect(within(panel).getAllByRole('button', { name: /删除/u })).toHaveLength(1)
    expect(within(panel).getByRole('button', { name: '删除所有' })).toBeVisible()
    const selectors = within(panel).getAllByRole('checkbox')
    expect(selectors).toHaveLength(2)
    const firstSelector = selectors[0]!
    expect(
      firstSelector.closest('.echo-history-item')?.querySelector('.echo-history-selector'),
    ).toBe(firstSelector.parentElement)
    expect(firstSelector.closest('.echo-history-item-copy')).toBeNull()
    expect(
      firstSelector
        .closest('.echo-history-item')
        ?.querySelector('.echo-history-item-copy .echo-history-send-button'),
    ).toBeInTheDocument()

    fireEvent.click(firstSelector)
    expect(within(panel).getByRole('button', { name: '删除选中' })).toBeVisible()
    expect(within(panel).queryByRole('button', { name: '删除所有' })).toBeNull()

    fireEvent.click(within(panel).getByRole('button', { name: '删除选中' }))
    const confirmation = await screen.findByRole('alertdialog', {
      name: '删除选中的 1 条历史？',
    })
    fireEvent.click(within(confirmation).getByRole('button', { name: '删除选中' }))

    await waitFor(() => expect(tauriMocks.deleteHistoryEntries).toHaveBeenCalledWith([21]))
    await waitFor(() =>
      expect(useAppStore.getState().history.map((entry) => entry.id)).toEqual([22]),
    )
    expect(screen.queryByText('待删除记录')).not.toBeInTheDocument()
    expect(screen.getByText('保留记录')).toBeInTheDocument()
    expect(tauriMocks.clearHistory).not.toHaveBeenCalled()
  })

  it('drops a selection when a new history entry pushes it out of the visible list', async () => {
    const entry = (id: number) => ({
      id,
      created_at: `2026-07-07T0${id}:00:00.000Z`,
      app_name: 'Chrome',
      app_type: 'Browser',
      raw_text: `历史 ${id}`,
      polished_text: '',
      language: 'zh',
      duration_ms: 600,
    })
    useAppStore.setState({ history: [entry(1), entry(2), entry(3)] })
    render(<HomePage />)

    fireEvent.click(screen.getByRole('checkbox', { name: '选择第 3 条历史记录' }))
    expect(screen.getByRole('button', { name: '删除选中' })).toBeVisible()

    act(() => {
      useAppStore.getState().setHistory([entry(4), entry(1), entry(2), entry(3)])
    })

    await waitFor(() => expect(screen.getByRole('button', { name: '删除所有' })).toBeEnabled())
    const visibleSelectors = screen.getAllByRole('checkbox')
    expect(visibleSelectors).toHaveLength(3)
    visibleSelectors.forEach((checkbox) => expect(checkbox).not.toBeChecked())
    expect(tauriMocks.deleteHistoryEntries).not.toHaveBeenCalled()
    expect(tauriMocks.clearHistory).not.toHaveBeenCalled()
  })

  it('requires confirmation before the dynamic action clears all stored history', async () => {
    tauriMocks.clearHistory.mockResolvedValue({ clearedThroughId: 32 })
    useAppStore.setState({
      history: [
        {
          id: 31,
          created_at: '2026-07-07T09:00:00.000Z',
          app_name: 'Chrome',
          app_type: 'Browser',
          raw_text: '第一条历史',
          polished_text: '',
          language: 'zh',
          duration_ms: 600,
        },
        {
          id: 32,
          created_at: '2026-07-07T10:00:00.000Z',
          app_name: 'Code',
          app_type: 'Development',
          raw_text: '第二条历史',
          polished_text: '',
          language: 'zh',
          duration_ms: 800,
        },
      ],
    })

    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: '删除所有' }))

    const confirmation = await screen.findByRole('alertdialog', { name: '删除所有历史记录？' })
    expect(within(confirmation).getByText(/包括当前列表未显示的记录/u)).toBeInTheDocument()
    expect(tauriMocks.clearHistory).not.toHaveBeenCalled()

    fireEvent.click(within(confirmation).getByRole('button', { name: '删除所有' }))

    await waitFor(() => expect(tauriMocks.clearHistory).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('region', { name: '最近历史' })).toBeNull())
    expect(useAppStore.getState().history).toEqual([])
    expect(tauriMocks.deleteHistoryEntries).not.toHaveBeenCalled()
  })

  it('keeps history and the confirmation surface when native deletion fails', async () => {
    tauriMocks.deleteHistoryEntries.mockRejectedValue(new Error('database busy'))
    useAppStore.setState({
      history: [
        {
          id: 41,
          created_at: '2026-07-07T09:00:00.000Z',
          app_name: 'Chrome',
          app_type: 'Browser',
          raw_text: '不能误删',
          polished_text: '',
          language: 'zh',
          duration_ms: 600,
        },
      ],
    })

    render(<HomePage />)
    fireEvent.click(screen.getByRole('checkbox', { name: '选择第 1 条历史记录' }))
    fireEvent.click(screen.getByRole('button', { name: '删除选中' }))
    const confirmation = await screen.findByRole('alertdialog', {
      name: '删除选中的 1 条历史？',
    })
    fireEvent.click(within(confirmation).getByRole('button', { name: '删除选中' }))

    expect(await within(confirmation).findByRole('alert')).toHaveTextContent('删除历史记录失败')
    expect(screen.getByText('不能误删')).toBeInTheDocument()
    expect(useAppStore.getState().history.map((entry) => entry.id)).toEqual([41])
    expect(within(confirmation).getByRole('button', { name: '删除选中' })).toBeEnabled()
  })

  it('sends history entries to the editor and asks before replacing a dirty draft', async () => {
    useAppStore.setState({
      history: [
        {
          id: 1,
          created_at: '2026-07-07T01:00:00.000Z',
          app_name: 'Chrome',
          app_type: 'Browser',
          raw_text: '第一条原文',
          polished_text: '第一条整理文本',
          language: 'zh',
          duration_ms: 1200,
        },
        {
          id: 2,
          created_at: '2026-07-07T02:00:00.000Z',
          app_name: 'Code',
          app_type: 'Development',
          raw_text: '第二条原文',
          polished_text: '第二条整理文本',
          language: 'zh',
          duration_ms: 800,
        },
      ],
    })

    render(<HomePage />)

    fireEvent.click(screen.getAllByRole('button', { name: '发送到编辑器' })[0])

    expect(await screen.findByRole('dialog', { name: 'Markdown 编辑器' })).toBeInTheDocument()
    expect(screen.getByDisplayValue('第一条整理文本')).toBeInTheDocument()
    expect(screen.getAllByText('第一条整理文本').length).toBeGreaterThan(0)
    expect(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY)).toContain('第一条整理文本')

    const titleInput = screen.getByLabelText('文稿标题')
    await waitFor(() => expect(titleInput).not.toHaveAttribute('readonly'))
    fireEvent.change(titleInput, { target: { value: '改过的草稿' } })
    await waitFor(() =>
      expect(localStorage.getItem(ACTIVE_MARKDOWN_DRAFT_STORAGE_KEY)).toContain('改过的草稿'),
    )
    fireEvent.click(screen.getByRole('button', { name: '关闭编辑器' }))
    fireEvent.click(screen.getAllByRole('button', { name: '发送到编辑器' })[1])

    const conflictDialog = await screen.findByRole('dialog', {
      name: '处理当前 Markdown 草稿',
    })
    expect(conflictDialog.querySelector('.echo-dialog-titlebar')).toHaveClass(
      'echo-dialog-titlebar--inline',
    )

    fireEvent.click(screen.getByRole('button', { name: '追加到当前' }))

    expect(await screen.findByRole('dialog', { name: 'Markdown 编辑器' })).toBeInTheDocument()
    expect(screen.getAllByText('第一条整理文本').length).toBeGreaterThan(0)
    expect(screen.getAllByText('第二条整理文本').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '保存 .md' }))
    await waitFor(() => expect(tauriMocks.runSaveMarkdownFile).toHaveBeenCalledTimes(1))
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownSpeechDialog } from '../MarkdownSpeechDialog'

const asset = {
  id: 8,
  key: {
    draftId: 'draft-1',
    contentRevision: 'rev-1',
    voiceKey: 'alloy',
    speedMilli: 1000,
  },
  fileName: '测试文稿_20260721.wav',
  directoryPath: 'C:\\Users\\TestUser\\Documents\\EcholIKE\\朗读音频',
  createdAt: '2026-07-21T00:00:00.000Z',
  byteLength: 2048,
  durationMs: 62_000,
}

describe('MarkdownSpeechDialog', () => {
  it('keeps the generated artifact while routing all explicit choices', () => {
    const onPlay = vi.fn()
    const onReveal = vi.fn()
    const onRegenerate = vi.fn()
    const onClose = vi.fn()
    render(
      <MarkdownSpeechDialog
        asset={asset}
        playing={false}
        onPlay={onPlay}
        onReveal={onReveal}
        onRegenerate={onRegenerate}
        onClose={onClose}
      />,
    )

    expect(screen.getByText('测试文稿_20260721.wav')).toBeInTheDocument()
    expect(screen.getByText(/1 分 2 秒 · 2 KB/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '立即朗读' }))
    fireEvent.click(screen.getByRole('button', { name: '打开所在文件夹' }))
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))

    expect(onPlay).toHaveBeenCalledOnce()
    expect(onReveal).toHaveBeenCalledOnce()
    expect(onRegenerate).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('exposes playback failure without losing the stop/reopen surface', () => {
    render(
      <MarkdownSpeechDialog
        asset={asset}
        playing
        error="系统播放器未能朗读，音频仍然可用。"
        onPlay={vi.fn()}
        onReveal={vi.fn()}
        onRegenerate={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('音频仍然可用')
    expect(screen.getByRole('button', { name: '停止朗读' })).toBeInTheDocument()
  })
})

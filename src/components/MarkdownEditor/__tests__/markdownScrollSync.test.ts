import { describe, expect, it, vi } from 'vitest'
import {
  createMarkdownScrollCoordinator,
  scrollTopToSourceLine,
  sourceLineToScrollTop,
  type MarkdownAnimationFrameScheduler,
  type MarkdownScrollSide,
} from '../markdownScrollSync'

describe('Markdown source-anchor interpolation', () => {
  const points = [
    { sourceLine: 0, scrollTop: 0 },
    { sourceLine: 10, scrollTop: 100 },
    { sourceLine: 11, scrollTop: 900 },
    { sourceLine: 20, scrollTop: 1000 },
  ]

  it('interpolates inside adjacent semantic anchors instead of using a document-wide ratio', () => {
    expect(sourceLineToScrollTop(points, 5)).toBe(50)
    expect(sourceLineToScrollTop(points, 10.5)).toBe(500)
    expect(scrollTopToSourceLine(points, 500)).toBe(10.5)
  })

  it('sorts, de-duplicates, and clamps boundary anchors safely', () => {
    const unsorted = [
      { sourceLine: 10, scrollTop: 100 },
      { sourceLine: 0, scrollTop: 0 },
      { sourceLine: 10, scrollTop: 120 },
      { sourceLine: 20, scrollTop: 500 },
      { sourceLine: Number.NaN, scrollTop: 999 },
    ]

    expect(sourceLineToScrollTop(unsorted, -1)).toBe(0)
    expect(sourceLineToScrollTop(unsorted, 10)).toBe(120)
    expect(sourceLineToScrollTop(unsorted, 99)).toBe(500)
    expect(scrollTopToSourceLine(unsorted, 120)).toBe(10)
  })
})

describe('Markdown scroll coordinator', () => {
  it('coalesces to the latest source position and suppresses the programmatic echo', () => {
    const scheduler = createTestScheduler()
    const sourceLines: Record<MarkdownScrollSide, number> = { editor: 2, preview: 0 }
    const writes: Array<[MarkdownScrollSide, number]> = []
    const echoResults: string[] = []
    const coordinator = createMarkdownScrollCoordinator({
      scheduler,
      ports: {
        editor: {
          readSourceLine: () => sourceLines.editor,
          writeSourceLine: (line) => {
            sourceLines.editor = line
            writes.push(['editor', line])
            echoResults.push(coordinator.onScroll('editor'))
          },
        },
        preview: {
          readSourceLine: () => sourceLines.preview,
          writeSourceLine: (line) => {
            sourceLines.preview = line
            writes.push(['preview', line])
            echoResults.push(coordinator.onScroll('preview'))
          },
        },
      },
    })

    expect(coordinator.onScroll('editor')).toBe('scheduled')
    sourceLines.editor = 4
    expect(coordinator.onScroll('editor')).toBe('scheduled')
    expect(scheduler.pending()).toBe(1)
    scheduler.flushFrame()

    expect(writes).toEqual([['preview', 4]])
    expect(echoResults).toEqual(['suppressed'])
    expect(coordinator.owner()).toBe('editor')
    expect(scheduler.pending()).toBe(0)
  })

  it('lets explicit user intent take ownership in the opposite direction', () => {
    const scheduler = createTestScheduler()
    const sourceLines: Record<MarkdownScrollSide, number> = { editor: 3, preview: 3 }
    const writeEditor = vi.fn((line: number) => {
      sourceLines.editor = line
    })
    const coordinator = createMarkdownScrollCoordinator({
      scheduler,
      ports: {
        editor: { readSourceLine: () => sourceLines.editor, writeSourceLine: writeEditor },
        preview: {
          readSourceLine: () => sourceLines.preview,
          writeSourceLine: (line) => {
            sourceLines.preview = line
          },
        },
      },
    })

    coordinator.onUserIntent('preview')
    sourceLines.preview = 8
    coordinator.onScroll('preview')
    scheduler.flushFrame()

    expect(writeEditor).toHaveBeenCalledWith(8)
    expect(coordinator.owner()).toBe('preview')
  })

  it('releases unused suppression after two animation frames and cancels all work when inactive', () => {
    const scheduler = createTestScheduler()
    const sourceLines: Record<MarkdownScrollSide, number> = { editor: 1, preview: 0 }
    const writePreview = vi.fn((line: number) => {
      sourceLines.preview = line
    })
    const coordinator = createMarkdownScrollCoordinator({
      scheduler,
      ports: {
        editor: {
          readSourceLine: () => sourceLines.editor,
          writeSourceLine: (line) => {
            sourceLines.editor = line
          },
        },
        preview: { readSourceLine: () => sourceLines.preview, writeSourceLine: writePreview },
      },
    })

    coordinator.onScroll('editor')
    scheduler.flushFrame()
    expect(writePreview).toHaveBeenCalledOnce()
    scheduler.flushFrame()
    scheduler.flushFrame()
    expect(coordinator.onScroll('preview')).toBe('scheduled')

    sourceLines.editor = 5
    coordinator.onScroll('editor')
    coordinator.setActive(false)
    scheduler.flushAll()
    expect(writePreview).toHaveBeenCalledOnce()
    expect(coordinator.owner()).toBeNull()
  })
})

function createTestScheduler(): MarkdownAnimationFrameScheduler & {
  flushFrame(): void
  flushAll(): void
  pending(): number
} {
  let nextId = 1
  const callbacks = new Map<number, FrameRequestCallback>()
  return {
    request(callback) {
      const id = nextId
      nextId += 1
      callbacks.set(id, callback)
      return id
    },
    cancel(id) {
      callbacks.delete(id)
    },
    flushFrame() {
      const frame = Array.from(callbacks.entries())
      callbacks.clear()
      for (const [, callback] of frame) callback(0)
    },
    flushAll() {
      while (callbacks.size) this.flushFrame()
    },
    pending() {
      return callbacks.size
    },
  }
}

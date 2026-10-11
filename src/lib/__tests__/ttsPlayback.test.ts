import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  acknowledge: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
}))

vi.mock('../tauri', () => ({
  acknowledgeIdempotentOperation: mocks.acknowledge,
  acquireTtsPlaybackOwner: mocks.acquire,
  releaseTtsPlaybackOwner: mocks.release,
}))

import { playTtsChunkQueue } from '../ttsPlayback'

class ControlledAudio {
  static instances: ControlledAudio[] = []
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  play = vi.fn().mockResolvedValue(undefined)
  constructor(public url: string) {
    ControlledAudio.instances.push(this)
  }
}

beforeEach(() => {
  mocks.acknowledge.mockReset().mockResolvedValue(undefined)
  mocks.acquire.mockReset().mockResolvedValue({ leaseId: 17, ownerWindow: 'main' })
  mocks.release.mockReset().mockResolvedValue(true)
  ControlledAudio.instances = []
  vi.stubGlobal('Audio', ControlledAudio)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})

describe('playTtsChunkQueue', () => {
  it('does not fetch when the process owner denies acquisition', async () => {
    mocks.acquire.mockResolvedValue(null)
    const fetchAudio = vi.fn()
    await expect(playTtsChunkQueue(['one'], fetchAudio, vi.fn())).resolves.toBe(false)
    expect(fetchAudio).not.toHaveBeenCalled()
    expect(mocks.release).not.toHaveBeenCalled()
  })

  it('releases a Ready owner when bridge/fetch rejects before audio exists', async () => {
    const failure = new Error('IPC dispatch failed')
    await expect(
      playTtsChunkQueue(['one'], vi.fn().mockRejectedValue(failure), vi.fn()),
    ).rejects.toBe(failure)
    expect(mocks.release).toHaveBeenCalledOnce()
    expect(mocks.release).toHaveBeenCalledWith(17)
  })

  it('uses one lease, waits for each ended event, and releases only after the queue', async () => {
    const fetchAudio = vi.fn(async (chunk: string) => `blob:${chunk}`)
    const promise = playTtsChunkQueue(['one', 'two'], fetchAudio, vi.fn())
    await vi.waitFor(() => expect(ControlledAudio.instances).toHaveLength(1))
    expect(fetchAudio).toHaveBeenCalledWith('one', { leaseId: 17, ownerWindow: 'main' })
    expect(fetchAudio).toHaveBeenCalledTimes(1)
    expect(mocks.release).not.toHaveBeenCalled()

    ControlledAudio.instances[0].onended?.()
    await vi.waitFor(() => expect(ControlledAudio.instances).toHaveLength(2))
    expect(fetchAudio).toHaveBeenLastCalledWith('two', { leaseId: 17, ownerWindow: 'main' })
    expect(mocks.release).not.toHaveBeenCalled()

    ControlledAudio.instances[1].onended?.()
    await expect(promise).resolves.toBe(true)
    expect(mocks.acquire).toHaveBeenCalledOnce()
    expect(mocks.release).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })

  it('acknowledges a billed chunk only after playback finishes', async () => {
    const promise = playTtsChunkQueue(
      ['one'],
      vi.fn().mockResolvedValue({ audioUrl: 'blob:one', operationId: 'tts-op-1' }),
      vi.fn(),
    )
    await vi.waitFor(() => expect(ControlledAudio.instances).toHaveLength(1))

    expect(mocks.acknowledge).not.toHaveBeenCalled()
    expect(mocks.release).not.toHaveBeenCalled()

    ControlledAudio.instances[0].onended?.()
    await expect(promise).resolves.toBe(true)
    expect(mocks.acknowledge).toHaveBeenCalledOnce()
    expect(mocks.acknowledge).toHaveBeenCalledWith('tts-op-1')
    expect(mocks.acknowledge.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.release.mock.invocationCallOrder[0],
    )
  })

  it('still releases the native owner when an ACK cannot be persisted', async () => {
    mocks.acknowledge.mockRejectedValue(new Error('disk busy'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const promise = playTtsChunkQueue(
      ['one'],
      vi.fn().mockResolvedValue({ audioUrl: 'blob:one', operationId: 'tts-op-1' }),
      vi.fn(),
    )
    await vi.waitFor(() => expect(ControlledAudio.instances).toHaveLength(1))

    ControlledAudio.instances[0].onended?.()
    await expect(promise).resolves.toBe(true)
    expect(mocks.acknowledge).toHaveBeenCalledWith('tts-op-1')
    expect(mocks.release).toHaveBeenCalledWith(17)
    expect(warn).toHaveBeenCalled()
  })

  it('does not acknowledge when playback fails', async () => {
    const promise = playTtsChunkQueue(
      ['one'],
      vi.fn().mockResolvedValue({ audioUrl: 'blob:one', operationId: 'tts-op-1' }),
      vi.fn(),
    )
    await vi.waitFor(() => expect(ControlledAudio.instances).toHaveLength(1))

    ControlledAudio.instances[0].onerror?.()
    await expect(promise).rejects.toThrow('朗读播放中断')
    expect(mocks.acknowledge).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledWith(17)
  })

  it('revokes the blob and releases the native owner when audio.play rejects', async () => {
    class RejectingAudio {
      onended: (() => void) | null = null
      onerror: (() => void) | null = null
      play = vi.fn().mockRejectedValue(new Error('autoplay denied'))
    }
    vi.stubGlobal('Audio', RejectingAudio)
    const onStarted = vi.fn()

    await expect(
      playTtsChunkQueue(
        ['one'],
        vi.fn().mockResolvedValue({ audioUrl: 'blob:one', operationId: 'tts-op-1' }),
        onStarted,
      ),
    ).rejects.toThrow('朗读播放被系统拦截')

    expect(onStarted).not.toHaveBeenCalled()
    expect(mocks.acknowledge).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:one')
    expect(mocks.release).toHaveBeenCalledWith(17)
  })
})

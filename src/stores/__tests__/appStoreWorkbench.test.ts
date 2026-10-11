import { describe, expect, it } from 'vitest'
import {
  completedVoiceTextTransition,
  createIdleAskTask,
  createIdleOcrTask,
  dismissOcrDialogTransition,
  failAskTaskTransition,
  failOcrTaskTransition,
  finalizeAskTaskAcknowledgementTransition,
  finalizeOcrTaskAcknowledgementTransition,
  finishAskTaskTransition,
  finishOcrTaskTransition,
  finishTtsPlaybackTransition,
  resetOcrTaskTransition,
  startAskTaskTransition,
  startOcrTaskTransition,
  startTtsPlaybackTransition,
  workbenchFeedbackTransition,
} from '../appStore.workbench'
import { getState, setupAppStoreTestLifecycle, useAppStore } from './appStoreTestHarness'

describe('appStore workbench transitions', () => {
  const feedback = {
    voice: { resourceId: 'voice:1', type: 'error' as const, message: 'voice failed' },
    workspace: { resourceId: 'ocr:1', type: 'success' as const, message: 'copied' },
  }

  it('updates completed voice and one feedback slot without disturbing the other slot', () => {
    expect(
      completedVoiceTextTransition(
        { completedVoiceText: 'old', completedVoiceTextVersion: 4, workbenchFeedback: feedback },
        'new',
      ),
    ).toEqual({
      completedVoiceText: 'new',
      completedVoiceTextVersion: 5,
      workbenchFeedback: { voice: null, workspace: feedback.workspace },
    })

    expect(workbenchFeedbackTransition(feedback, 'workspace', null)).toEqual({
      workbenchFeedback: { voice: feedback.voice, workspace: null },
    })
  })

  it('keeps the TTS busy target and lease in one patch', () => {
    expect(startTtsPlaybackTransition('answer', 7)).toEqual({
      ttsPlaybackBusy: 'answer',
      ttsPlaybackLeaseId: 7,
    })
    expect(finishTtsPlaybackTransition()).toEqual({
      ttsPlaybackBusy: null,
      ttsPlaybackLeaseId: null,
    })
  })

  it('builds OCR start, completion, acknowledgement, failure, dismiss, and reset patches', () => {
    const started = startOcrTaskTransition(
      feedback,
      'upload',
      'invoice.pdf',
      'OCR loading',
      11,
      '2026-08-29T00:00:00.000Z',
    )
    expect(started).toEqual({
      ocrTask: {
        status: 'running',
        leaseId: 11,
        runId: 11,
        ackPending: false,
        operationId: null,
        startedAt: '2026-08-29T00:00:00.000Z',
        kind: 'upload',
        sourceName: 'invoice.pdf',
        error: null,
        diagnostic: null,
        result: null,
        dialogState: { status: 'loading', message: 'OCR loading' },
        pdfExportFile: null,
      },
      workbenchFeedback: { voice: feedback.voice, workspace: null },
    })

    const result = {
      app_name: 'Chrome',
      window_title: 'Order',
      app_type: 'Browser',
      text: '# Order',
      elapsed_ms: 12,
      model: 'glm-ocr:latest',
      operation_id: '  operation-11  ',
    }
    const pdf = { fileName: 'invoice.pdf', mimeType: 'application/pdf', fileBase64: 'cGRm' }
    const completed = finishOcrTaskTransition(started.ocrTask, result, pdf)
    expect(completed.ocrTask).toMatchObject({
      status: 'success',
      leaseId: null,
      runId: 11,
      ackPending: true,
      operationId: 'operation-11',
      result,
      pdfExportFile: pdf,
    })
    expect(finalizeOcrTaskAcknowledgementTransition(completed.ocrTask).ocrTask).toMatchObject({
      ackPending: false,
      operationId: null,
      runId: 11,
    })

    const diagnostic = {
      service: 'ocr',
      status: 503,
      code: 'ocr_failed',
      requestId: 'request-11',
      stage: 'provider',
    }
    expect(failOcrTaskTransition(started.ocrTask, 'failed', diagnostic).ocrTask).toMatchObject({
      status: 'error',
      leaseId: null,
      error: 'failed',
      diagnostic,
      dialogState: { status: 'error', message: 'failed', diagnostic },
      pdfExportFile: null,
    })
    expect(dismissOcrDialogTransition(completed.ocrTask).ocrTask).toMatchObject({
      status: 'success',
      dialogState: null,
      pdfExportFile: null,
    })
    expect(resetOcrTaskTransition()).toEqual({ ocrTask: createIdleOcrTask() })
  })

  it('builds Ask start, completion, acknowledgement, and failure patches', () => {
    const started = startAskTaskTransition(
      feedback,
      'question',
      'context',
      13,
      '2026-08-29T00:00:00.000Z',
    )
    expect(started).toEqual({
      askTask: {
        status: 'running',
        leaseId: 13,
        runId: 13,
        ackPending: false,
        operationId: null,
        startedAt: '2026-08-29T00:00:00.000Z',
        question: 'question',
        context: 'context',
        answer: null,
        error: null,
      },
      workbenchFeedback: { voice: feedback.voice, workspace: null },
    })

    const completed = finishAskTaskTransition(started.askTask, 'answer', ' operation-13 ')
    expect(completed.askTask).toMatchObject({
      status: 'success',
      leaseId: null,
      runId: 13,
      ackPending: true,
      operationId: 'operation-13',
      answer: 'answer',
    })
    expect(finalizeAskTaskAcknowledgementTransition(completed.askTask).askTask).toMatchObject({
      ackPending: false,
      operationId: null,
      runId: 13,
    })
    expect(failAskTaskTransition(started.askTask, 'failed').askTask).toMatchObject({
      status: 'error',
      leaseId: null,
      runId: 13,
      answer: null,
      error: 'failed',
    })
    expect(createIdleAskTask()).toMatchObject({ status: 'idle', runId: null, leaseId: null })
  })
})

describe('appStore', () => {
  setupAppStoreTestLifecycle()

  describe('TTS playback mutex', () => {
    it('atomically rejects duplicate acquisition while the current lease is active', () => {
      const firstPlayback = getState().tryStartTtsPlayback('result')

      expect(firstPlayback).not.toBeNull()
      expect(getState().ttsPlaybackBusy).toBe('result')
      expect(getState().tryStartTtsPlayback('answer')).toBeNull()
      expect(getState().ttsPlaybackLeaseId).toBe(firstPlayback)
    })

    it('keeps stale owners from releasing or overwriting a newer lease', () => {
      const firstPlayback = getState().tryStartTtsPlayback('result')

      getState().finishTtsPlayback(firstPlayback ?? -1)
      expect(getState().ttsPlaybackBusy).toBeNull()

      const secondPlayback = getState().tryStartTtsPlayback('answer')
      expect(secondPlayback).not.toBe(firstPlayback)
      expect(getState().ttsPlaybackBusy).toBe('answer')

      getState().finishTtsPlayback(firstPlayback ?? -1)
      expect(getState().ttsPlaybackBusy).toBe('answer')
      expect(getState().ttsPlaybackLeaseId).toBe(secondPlayback)

      getState().finishTtsPlayback(secondPlayback ?? -1)
      expect(getState().ttsPlaybackBusy).toBeNull()
    })

    it('starts idle in a fresh store state instead of restoring an in-flight lease', () => {
      getState().tryStartTtsPlayback('answer')

      const freshState = useAppStore.getInitialState()

      expect(freshState.ttsPlaybackBusy).toBeNull()
      expect(freshState.ttsPlaybackLeaseId).toBeNull()
    })
  })

  describe('OCR task lifecycle', () => {
    const result = {
      app_name: 'Chrome',
      window_title: 'Order',
      app_type: 'Browser',
      text: '# Order',
      elapsed_ms: 12,
      model: 'glm-ocr:latest',
      route: 'pipeline' as const,
      processing_reason: 'dense-layout',
      warnings: ['完整文档管线未完成'],
      degraded: true,
    }

    it('atomically owns all OCR entry points and rejects stale completion', () => {
      getState().setWorkbenchFeedback('workspace', {
        resourceId: 'ocr:old',
        type: 'success',
        message: '旧结果已复制',
      })
      const first = getState().tryStartOcrTask('screen-selection', 'screen')

      expect(first).not.toBeNull()
      expect(getState().ocrTask.runId).toBe(first)
      expect(getState().workbenchFeedback.workspace).toBeNull()
      expect(getState().tryStartOcrTask('upload', 'invoice.pdf')).toBeNull()
      expect(getState().ocrTask.status).toBe('running')

      expect(getState().finishOcrTask(first ?? -1, result)).toBe(true)
      expect(getState().ocrTask.result).toMatchObject({
        route: 'pipeline',
        warnings: ['完整文档管线未完成'],
        degraded: true,
      })
      const second = getState().tryStartOcrTask('upload', 'invoice.pdf')
      expect(second).not.toBe(first)
      expect(getState().ocrTask.runId).toBe(second)

      expect(getState().finishOcrTask(first ?? -1, result)).toBe(false)
      getState().failOcrTask(first ?? -1, 'late failure')
      expect(getState().ocrTask.status).toBe('running')
      expect(getState().ocrTask.leaseId).toBe(second)
    })

    it('releases the PDF payload when the result dialog closes while preserving OCR text', () => {
      const pdf = {
        fileName: 'invoice.pdf',
        mimeType: 'application/pdf',
        fileBase64: 'cGRm',
      }
      const first = getState().tryStartOcrTask('upload', pdf.fileName)
      getState().finishOcrTask(first ?? -1, result, pdf)
      expect(getState().ocrTask.pdfExportFile).toEqual(pdf)

      getState().dismissOcrDialog()
      expect(getState().ocrTask).toMatchObject({
        status: 'success',
        result,
        dialogState: null,
        pdfExportFile: null,
      })

      const second = getState().tryStartOcrTask('screen-window', 'screen')
      expect(getState().ocrTask.pdfExportFile).toBeNull()
      getState().finishOcrTask(second ?? -1, result)
      getState().clearOcrTask()
      expect(getState().ocrTask).toMatchObject({
        status: 'idle',
        result: null,
        pdfExportFile: null,
        dialogState: null,
      })
    })

    it('does not let explicit clear release a running OCR lease', () => {
      const leaseId = getState().tryStartOcrTask('screen-selection', 'screen')

      getState().clearOcrTask()

      expect(getState().ocrTask.status).toBe('running')
      expect(getState().ocrTask.leaseId).toBe(leaseId)
      expect(getState().tryStartOcrTask('upload', 'invoice.pdf')).toBeNull()
    })

    it('silently cancels only the matching running screenshot lease', () => {
      const first = getState().tryStartOcrTask('screen-selection', 'screen') ?? -1

      getState().cancelOcrTask(first + 1)
      expect(getState().ocrTask).toMatchObject({ status: 'running', leaseId: first })

      getState().cancelOcrTask(first)
      expect(getState().ocrTask).toEqual({
        status: 'idle',
        leaseId: null,
        runId: null,
        ackPending: false,
        operationId: null,
        startedAt: null,
        kind: null,
        sourceName: null,
        error: null,
        diagnostic: null,
        result: null,
        dialogState: null,
        pdfExportFile: null,
      })
      expect(getState().tryStartOcrTask('upload', 'invoice.pdf')).not.toBeNull()
    })

    it('claims each screen OCR shortcut request once across consumers', () => {
      getState().triggerScreenOcrShortcut()

      expect(getState().claimScreenOcrShortcutRequest()).toBe(true)
      expect(getState().claimScreenOcrShortcutRequest()).toBe(false)

      getState().triggerScreenOcrShortcut()
      expect(getState().claimScreenOcrShortcutRequest()).toBe(true)
    })

    it('keeps OCR fenced until the matching operation acknowledgement is finalized', () => {
      const first = getState().tryStartOcrTask('screen-selection', 'screen') ?? -1
      expect(getState().finishOcrTask(first, { ...result, operation_id: 'ocr-operation-1' })).toBe(
        true,
      )

      expect(getState().ocrTask).toMatchObject({
        status: 'success',
        runId: first,
        ackPending: true,
        operationId: 'ocr-operation-1',
      })
      expect(getState().tryStartOcrTask('upload', 'next.png')).toBeNull()
      expect(getState().finalizeOcrTaskAcknowledgement(first + 1, 'ocr-operation-1')).toBe(false)
      expect(getState().finalizeOcrTaskAcknowledgement(first, 'wrong-operation')).toBe(false)
      expect(getState().ocrTask.ackPending).toBe(true)

      expect(getState().finalizeOcrTaskAcknowledgement(first, 'ocr-operation-1')).toBe(true)
      const second = getState().tryStartOcrTask('upload', 'next.png') ?? -1
      expect(second).not.toBe(first)
      expect(getState().finishOcrTask(second, { ...result, operation_id: 'ocr-operation-2' })).toBe(
        true,
      )

      expect(getState().finalizeOcrTaskAcknowledgement(first, 'ocr-operation-1')).toBe(false)
      expect(getState().ocrTask).toMatchObject({
        runId: second,
        ackPending: true,
        operationId: 'ocr-operation-2',
      })
    })
  })

  describe('Ask task lifecycle', () => {
    it('starts idle in a fresh process state', () => {
      expect(getState().askTask).toEqual({
        status: 'idle',
        leaseId: null,
        runId: null,
        ackPending: false,
        operationId: null,
        startedAt: null,
        question: null,
        context: null,
        answer: null,
        error: null,
      })
    })

    it('keeps a terminal run identity and clears the prior workspace feedback on restart', () => {
      const first = getState().tryStartAskTask('first question', null) ?? -1
      expect(getState().finishAskTask(first, 'first answer')).toBe(true)
      expect(getState().askTask).toMatchObject({ status: 'success', runId: first, leaseId: null })
      getState().setWorkbenchFeedback('workspace', {
        resourceId: `ask:${first}`,
        type: 'error',
        message: 'old playback failed',
      })

      const second = getState().tryStartAskTask('second question', null) ?? -1

      expect(second).not.toBe(first)
      expect(getState().askTask.runId).toBe(second)
      expect(getState().workbenchFeedback.workspace).toBeNull()
    })

    it('atomically freezes one request and rejects duplicate acquisition', () => {
      const first = getState().tryStartAskTask('first question', 'first context')

      expect(first).not.toBeNull()
      expect(getState().tryStartAskTask('second question', 'second context')).toBeNull()
      expect(getState().askTask).toMatchObject({
        status: 'running',
        leaseId: first,
        question: 'first question',
        context: 'first context',
      })
    })

    it('rejects late result and error writes from an old lease', () => {
      const first = getState().tryStartAskTask('first', 'context 1') ?? -1
      getState().finishAskTask(first, 'first answer')
      const second = getState().tryStartAskTask('second', 'context 2') ?? -1

      expect(getState().finishAskTask(first, 'late answer')).toBe(false)
      getState().failAskTask(first, 'late error')

      expect(getState().askTask).toMatchObject({
        status: 'running',
        leaseId: second,
        question: 'second',
        answer: null,
        error: null,
      })
    })

    it('keeps Ask fenced and ignores a stale acknowledgement finalizer', () => {
      const first = getState().tryStartAskTask('first', null) ?? -1
      expect(getState().finishAskTask(first, 'answer', 'ask-operation-1')).toBe(true)
      expect(getState().tryStartAskTask('blocked', null)).toBeNull()

      expect(getState().finalizeAskTaskAcknowledgement(first, 'ask-operation-1')).toBe(true)
      const second = getState().tryStartAskTask('second', null) ?? -1
      expect(getState().finishAskTask(second, 'answer 2', 'ask-operation-2')).toBe(true)

      expect(getState().finalizeAskTaskAcknowledgement(first, 'ask-operation-1')).toBe(false)
      expect(getState().askTask).toMatchObject({
        runId: second,
        ackPending: true,
        operationId: 'ask-operation-2',
      })
      expect(getState().finalizeAskTaskAcknowledgement(second, 'ask-operation-2')).toBe(true)
      expect(getState().tryStartAskTask('third', null)).not.toBeNull()
    })
  })
})

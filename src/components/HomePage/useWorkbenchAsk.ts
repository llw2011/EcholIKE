import { useEffect, useState } from 'react'
import {
  acknowledgeIdempotentOperation,
  askLlmOnce,
  askProxyLlmOnce,
  type DetectedAppContext,
  type OcrReadResult,
} from '../../lib/tauri'
import { mergeScenePresetContext, type ScenePreset } from '../../lib/scenePresets'
import { toast } from '../../lib/toast'
import { userFacingErrorMessage } from '../../lib/userErrors'
import { useAppStore } from '../../stores/appStore'
import { ocrSourceLabel } from './ocrDomain'

export type AskAnswer = {
  question: string
  answer: string
}

type UseWorkbenchAskOptions = {
  backendManaged: boolean
  desktopToken: string | null
  detectedContext: DetectedAppContext | null
  ocrResult: OcrReadResult | null
  selectedScenePreset: ScenePreset | null
  forceUpdateRequired: boolean
  onRequiredUpdate: () => void
}

function llmErrorMessage(error: unknown, fallback: string) {
  return userFacingErrorMessage(error, fallback, 'llm')
}

export function useWorkbenchAsk({
  backendManaged,
  desktopToken,
  detectedContext,
  ocrResult,
  selectedScenePreset,
  forceUpdateRequired,
  onRequiredUpdate,
}: UseWorkbenchAskOptions) {
  const config = useAppStore((state) => state.config)
  const desktopBootstrap = useAppStore((state) => state.desktopBootstrap)
  const askTask = useAppStore((state) => state.askTask)
  const tryStartAskTask = useAppStore((state) => state.tryStartAskTask)
  const finishAskTask = useAppStore((state) => state.finishAskTask)
  const finalizeAskTaskAcknowledgement = useAppStore(
    (state) => state.finalizeAskTaskAcknowledgement,
  )
  const failAskTask = useAppStore((state) => state.failAskTask)
  const [question, setQuestion] = useState('')
  const [visibleAnswer, setVisibleAnswer] = useState('')
  const [backendServiceError, setBackendServiceError] = useState<string | undefined>()

  const answer: AskAnswer | null =
    askTask.question && (askTask.answer !== null || askTask.error !== null)
      ? {
          question: askTask.question,
          answer: askTask.answer ?? askTask.error ?? '',
        }
      : null
  const pendingQuestion = askTask.status === 'running' ? askTask.question : null
  const askBusy = askTask.status === 'running' || askTask.ackPending
  const localLlmReady =
    config.llm_provider === 'ollama'
      ? Boolean(config.llm_base_url.trim() && config.llm_model.trim())
      : Boolean(config.llm_api_key.trim() && config.llm_base_url.trim() && config.llm_model.trim())
  const cloudLlm = desktopBootstrap?.services?.llm
  const cloudLlmAvailable = Boolean(
    backendManaged &&
    cloudLlm?.mode === 'proxy' &&
    cloudLlm.configured !== false &&
    desktopBootstrap?.apiBaseUrl &&
    desktopToken,
  )
  const llmReady = backendManaged ? cloudLlmAvailable : localLlmReady
  const llmStatusText = backendManaged
    ? backendServiceError
      ? '后台托管异常'
      : cloudLlmAvailable
        ? '后台托管可用'
        : '后台托管不可用'
    : localLlmReady
      ? '本机可用'
      : '缺配置'
  const llmUnavailableMessage = backendManaged
    ? '后台托管文本 AI 不可用，请先同步后台配置或切换到本机配置。'
    : '先在设置里配置可用的文本 AI 模型。'

  useEffect(() => {
    const fullAnswer = askTask.answer ?? askTask.error
    if (fullAnswer === null) {
      setVisibleAnswer('')
      return
    }

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    if (reduceMotion || fullAnswer.length <= 120 || askTask.error !== null) {
      setVisibleAnswer(fullAnswer)
      return
    }

    let index = 0
    const step = Math.max(8, Math.ceil(fullAnswer.length / 90))
    setVisibleAnswer('')
    const timer = window.setInterval(() => {
      index = Math.min(fullAnswer.length, index + step)
      setVisibleAnswer(fullAnswer.slice(0, index))
      if (index >= fullAnswer.length) window.clearInterval(timer)
    }, 18)

    return () => window.clearInterval(timer)
  }, [askTask.answer, askTask.error])

  async function askByConfigSource(
    prompt: string,
    context?: string,
    scenePreset = selectedScenePreset,
    contextAlreadyMerged = false,
  ) {
    const promptContext = contextAlreadyMerged
      ? context
      : mergeScenePresetContext(context, scenePreset)
    if (backendManaged) {
      if (!desktopBootstrap?.apiBaseUrl || !desktopToken || !cloudLlmAvailable) {
        throw new Error(llmUnavailableMessage)
      }
      try {
        const result = await askProxyLlmOnce(
          desktopBootstrap.apiBaseUrl,
          desktopToken,
          prompt,
          promptContext,
        )
        setBackendServiceError(undefined)
        return { text: result.text, operationId: result.operationId }
      } catch (error) {
        const message = llmErrorMessage(error, '问答未完成，请稍后重试。')
        setBackendServiceError(message)
        throw new Error(message)
      }
    }

    if (localLlmReady) {
      return {
        text: await askLlmOnce({
          question: prompt,
          provider: config.llm_provider,
          apiKey: config.llm_api_key,
          baseUrl: config.llm_base_url,
          model: config.llm_model,
          context: promptContext,
        }),
        operationId: null,
      }
    }

    throw new Error(llmUnavailableMessage)
  }

  function askFailureMessage(error: unknown) {
    const message = llmErrorMessage(error, '问答请求失败。')
    if (
      !backendManaged &&
      config.llm_provider === 'ollama' &&
      /(^|[^a-z])(404|not found|model)([^a-z]|$)|模型|没有找到/i.test(message)
    ) {
      const summary = message.replace(/[.!?。！？]+$/u, '')
      return `${summary}。当前本地模型服务（${config.llm_base_url}）需要安装聊天模型；glm-ocr 仅支持屏幕/附件 OCR。`
    }
    return message
  }

  async function submitQuestion() {
    if (forceUpdateRequired) {
      onRequiredUpdate()
      return
    }
    const prompt = question.trim()
    if (!prompt) {
      toast('先输入要问的问题。', 'info')
      return
    }
    if (!llmReady) {
      toast(llmUnavailableMessage, 'error')
      return
    }

    const baseContext =
      [
        detectedContext
          ? `当前窗口: ${detectedContext.app_name || '未知应用'} / ${
              detectedContext.window_title || '无标题'
            }`
          : '',
        ocrResult?.text ? `${ocrSourceLabel(ocrResult)}:\n${ocrResult.text}` : '',
      ]
        .filter(Boolean)
        .join('\n\n') || undefined
    const context = mergeScenePresetContext(baseContext, selectedScenePreset)
    const leaseId = tryStartAskTask(prompt, context ?? null)
    if (leaseId === null) return
    try {
      const result = await askByConfigSource(prompt, context, selectedScenePreset, true)
      const operationId = result.operationId?.trim() || null
      const accepted = finishAskTask(leaseId, result.text, operationId)
      if (accepted && operationId) {
        try {
          await acknowledgeIdempotentOperation(operationId)
        } catch (error) {
          console.warn('Ask operation ACK deferred:', error)
        } finally {
          finalizeAskTaskAcknowledgement(leaseId, operationId)
        }
      }
    } catch (error) {
      failAskTask(leaseId, askFailureMessage(error))
    }
  }

  return {
    answer,
    answerText: answer ? `Q：${answer.question}\n\nA：${answer.answer}` : '',
    askBusy,
    askTask,
    backendServiceError,
    cloudLlmAvailable,
    llmReady,
    llmStatusText,
    llmUnavailableMessage,
    localLlmReady,
    pendingQuestion,
    question,
    setQuestion,
    submitQuestion,
    visibleAnswer,
  }
}

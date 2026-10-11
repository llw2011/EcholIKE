import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Tooltip } from '../Tooltip'
import type { AskAnswer } from './useWorkbenchAsk'

export function ServiceSummary({
  text,
  detail,
  tone,
}: {
  text: string
  detail: string
  tone: 'ok' | 'warn'
}) {
  const Icon = tone === 'ok' ? CheckCircle2 : AlertTriangle
  return (
    <Tooltip content={detail}>
      <span
        className={`echo-ai-service-summary echo-ai-service-summary--${tone}`}
        aria-label={`AI 服务状态：${detail.replace(/\n/g, '；')}`}
      >
        <Icon size={13} />
        <b>{text}</b>
      </span>
    </Tooltip>
  )
}

export function OcrPreview({ value }: { value: string }) {
  return (
    <div className="echo-ocr-preview">
      <p>{value}</p>
    </div>
  )
}

export function AskPendingView({ question }: { question: string }) {
  return (
    <div className="echo-answer-thread echo-answer-thread--pending">
      <div className="echo-answer-turn">
        <strong>Q：</strong>
        <p>{question}</p>
      </div>
      <div className="echo-answer-turn">
        <strong>A：</strong>
        <p className="echo-answer-pending">
          <span>正在整理回答</span>
          <span className="echo-typing-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </p>
      </div>
    </div>
  )
}

export function AskAnswerView({
  value,
  streaming = false,
  error = false,
}: {
  value: AskAnswer
  streaming?: boolean
  error?: boolean
}) {
  return (
    <div className="echo-answer-thread">
      <div className="echo-answer-turn">
        <strong>Q：</strong>
        <p>{value.question}</p>
      </div>
      <div
        className={error ? 'echo-answer-turn echo-answer-turn--error' : 'echo-answer-turn'}
        role={error ? 'alert' : undefined}
      >
        <strong>A：</strong>
        <p>
          {value.answer}
          {streaming && <span className="echo-answer-cursor" aria-hidden="true" />}
        </p>
      </div>
    </div>
  )
}

export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="echo-panel echo-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

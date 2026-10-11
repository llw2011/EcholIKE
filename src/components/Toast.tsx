import { useState, useEffect, useCallback, useRef } from 'react'
import { CheckCircle2, XCircle, Info } from 'lucide-react'
import { subscribeToast, type ToastType, type ToastMessage } from '../lib/toast'

const icons: Record<ToastType, typeof Info> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
}

const MAX_VISIBLE_TOASTS = 4

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const timeoutByKey = useRef(new Map<string, number>())

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  useEffect(() => {
    const timeouts = timeoutByKey.current
    const unsubscribe = subscribeToast((message) => {
      const previousTimeout = timeouts.get(message.key)
      if (previousTimeout !== undefined) {
        window.clearTimeout(previousTimeout)
      }

      setToasts((previous) => {
        const withoutMatchingKey = previous.filter((toast) => toast.key !== message.key)
        return [...withoutMatchingKey, message].slice(-MAX_VISIBLE_TOASTS)
      })

      const timeout = window.setTimeout(() => {
        timeouts.delete(message.key)
        remove(message.id)
      }, message.duration)
      timeouts.set(message.key, timeout)
    })

    return () => {
      unsubscribe()
      timeouts.forEach((timeout) => window.clearTimeout(timeout))
      timeouts.clear()
    }
  }, [remove])

  return (
    <div className="echo-toast-viewport">
      {toasts.map((t) => {
        const Icon = icons[t.type]
        return (
          <div key={t.id} className="echo-toast" role="alert" data-toast-key={t.key}>
            <Icon size={14} className={`echo-toast-icon echo-toast-icon--${t.type}`} />
            <span>{t.text}</span>
          </div>
        )
      })}
    </div>
  )
}

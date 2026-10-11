export type ToastType = 'success' | 'error' | 'info'

export interface ToastOptions {
  /** Replaces the currently visible toast with the same key instead of stacking it. */
  key?: string
  duration?: number
}

export interface ToastMessage {
  id: number
  text: string
  type: ToastType
  key: string
  duration: number
}

type ToastListener = (message: ToastMessage) => void
type ToastFn = ((text: string, type?: ToastType, options?: ToastOptions) => void) & {
  success: (text: string, options?: ToastOptions) => void
  error: (text: string, options?: ToastOptions) => void
}

const listeners = new Set<ToastListener>()
let toastId = 0
const DEFAULT_TOAST_DURATION_MS = 3000

function nextToastId() {
  toastId = (toastId + 1) % 1000
  return Date.now() * 1000 + toastId
}

export const toast: ToastFn = Object.assign(
  (text: string, type: ToastType = 'info', options: ToastOptions = {}) => {
    const key = options.key?.trim() || `${type}:${text}`
    const message = {
      id: nextToastId(),
      text,
      type,
      key,
      duration: options.duration ?? DEFAULT_TOAST_DURATION_MS,
    }
    listeners.forEach((listener) => listener(message))
  },
  {
    success: (text: string, options?: ToastOptions) => toast(text, 'success', options),
    error: (text: string, options?: ToastOptions) => toast(text, 'error', options),
  },
)

export function subscribeToast(listener: ToastListener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

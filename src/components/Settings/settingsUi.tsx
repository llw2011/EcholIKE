import { Children, isValidElement, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import type { LucideIcon } from 'lucide-react'
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react'
import { maskSecret } from '../../lib/secrets'
import type { StatusTone } from './settingsCache'

export type PanelAlertState = {
  text: string
  tone: StatusTone
}

export function Panel({
  title,
  alert,
  actions,
  status,
  children,
  onboardingTarget,
}: {
  title: string
  alert?: PanelAlertState
  actions?: ReactNode
  status?: ReactNode
  children: ReactNode
  onboardingTarget?: string
}) {
  return (
    <section
      className={`echo-panel echo-settings-panel ${alert ? 'echo-settings-panel--has-alert' : ''}`}
      data-onboarding-target={onboardingTarget}
    >
      <div className="echo-settings-panel-header">
        <div className="echo-settings-panel-heading">
          <h3>{title}</h3>
          {status}
        </div>
        {alert && (
          <div className="echo-settings-panel-alert-slot">
            <PanelAlert notice={alert} />
          </div>
        )}
        {actions && <div className="echo-settings-panel-actions">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

export function ServiceStatus({ children }: { children?: ReactNode }) {
  if (!children) return null

  return <div className="echo-service-status">{children}</div>
}

export function SettingLine({
  icon: Icon,
  title,
  description,
  status,
  children,
  wide = false,
  compactControl = false,
}: {
  icon: LucideIcon
  title: string
  description: string
  status?: ReactNode
  children: ReactNode
  wide?: boolean
  compactControl?: boolean
}) {
  const controls = Children.toArray(children)
  const tailControl =
    controls.length === 1 &&
    isValidElement(controls[0]) &&
    (controls[0].type === Badge ||
      controls[0].type === Switch ||
      controls[0].type === ServiceStatus)

  return (
    <div
      className={`echo-setting-line ${wide ? 'echo-setting-line--wide' : ''} ${
        status ? 'echo-setting-line--with-status' : ''
      } ${tailControl ? 'echo-setting-line--tail-control' : ''} ${
        compactControl ? 'echo-setting-line--compact-control' : ''
      }`}
    >
      <span className="echo-line-icon">
        <Icon size={18} />
      </span>
      <div className="echo-line-copy">
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      {status ? <div className="echo-line-status">{status}</div> : null}
      <div className="echo-line-control">{children}</div>
    </div>
  )
}

export function DiagnosticResult({
  ok,
  items,
}: {
  ok: boolean
  items: Array<string | null | undefined>
}) {
  const visibleItems = items.filter((item): item is string => Boolean(item))
  return (
    <div className="echo-diagnostic-result">
      <Badge tone={ok ? 'ok' : 'warn'}>{ok ? '通过' : '失败'}</Badge>
      <span>{visibleItems.join(' · ')}</span>
    </div>
  )
}

export function Badge({ children, tone }: { children: ReactNode; tone: StatusTone }) {
  const Icon = tone === 'warn' ? AlertTriangle : CheckCircle2
  return (
    <b className={`echo-badge echo-badge--${tone}`}>
      <Icon size={13} />
      {children}
    </b>
  )
}

export function PanelAlert({ notice }: { notice: PanelAlertState }) {
  const Icon = notice.tone === 'warn' ? AlertTriangle : notice.tone === 'ok' ? CheckCircle2 : Info
  return (
    <div
      className={`echo-panel-alert echo-panel-alert--${notice.tone}`}
      role={notice.tone === 'warn' ? 'alert' : 'status'}
    >
      <Icon size={14} />
      <span>{notice.text}</span>
    </div>
  )
}

export function Select({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  ariaLabel?: string
}) {
  return (
    <select
      className="echo-field"
      value={value}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function Input({
  inputRef,
  value,
  onChange,
  placeholder,
  type = 'text',
  list,
  ariaLabel,
  disabled = false,
  readOnly = false,
}: {
  inputRef?: Ref<HTMLInputElement>
  value: string
  onChange: (value: string) => void
  placeholder: string
  type?: 'text' | 'password'
  list?: string
  ariaLabel?: string
  disabled?: boolean
  readOnly?: boolean
}) {
  return (
    <input
      ref={inputRef}
      className="echo-field"
      type={type}
      list={list}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
      readOnly={readOnly}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  )
}

export function SecretInput({
  value,
  preview,
  onChange,
  placeholder,
}: {
  value: string
  preview?: string | null
  onChange: (value: string) => void
  placeholder: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const displayValue = editing ? draft : preview || maskSecret(value)

  return (
    <input
      className="echo-field"
      type={editing ? 'password' : 'text'}
      value={displayValue}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      onFocus={() => {
        setEditing(true)
        setDraft('')
      }}
      onChange={(event) => {
        const next = event.currentTarget.value
        setDraft(next)
        onChange(next)
      }}
      onBlur={() => {
        setEditing(false)
        setDraft('')
      }}
    />
  )
}

export function Switch({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      className={`echo-switch-lite ${checked ? 'is-on' : ''}`}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

export function Segmented({
  value,
  options,
  disabled = false,
  onChange,
}: {
  value: string
  options: { value: string; label: string }[]
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <div className="echo-segmented-lite">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          className={value === option.value ? 'is-active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

const EXPORT_BASE_NAME_MAX_CHARS = 80

export function safeDownloadBaseName(value: string, fallback: string) {
  const source = value.trim().replace(/\.[^.\\/]+$/, '')
  let cleaned = ''
  let lastDash = false
  let lastSpace = false
  for (const ch of source.normalize('NFKC')) {
    if ('<>:"/\\|?*'.includes(ch) || ch.charCodeAt(0) <= 31) {
      if (!lastDash) cleaned += '-'
      lastDash = true
      lastSpace = false
      continue
    }

    if (/\s/u.test(ch)) {
      if (lastDash) continue
      if (!lastSpace) cleaned += ' '
      lastDash = false
      lastSpace = true
      continue
    }

    cleaned += ch
    lastDash = false
    lastSpace = false
  }

  cleaned = cleaned.replace(/^[ .-]+|[ .-]+$/g, '') || fallback
  if (isReservedWindowsFileBase(cleaned)) cleaned = `${cleaned}-file`

  return (
    Array.from(cleaned)
      .slice(0, EXPORT_BASE_NAME_MAX_CHARS)
      .join('')
      .replace(/[ .-]+$/g, '') || fallback
  )
}

export function safeDownloadFileName(fileName: string, fallback: string) {
  const rawName = (fileName || fallback).trim() || fallback
  const fallbackExtension = fallback.match(/\.[^.\\/]+$/)?.[0] ?? ''
  const extension = rawName.match(/\.(?:md|docx|zip|png|bin)$/i)?.[0] ?? fallbackExtension
  const baseSource = extension ? rawName.slice(0, -extension.length) : rawName
  const fallbackBase = fallbackExtension ? fallback.slice(0, -fallbackExtension.length) : fallback
  return `${safeDownloadBaseName(baseSource, fallbackBase)}${extension}`
}

function isReservedWindowsFileBase(value: string) {
  const upper = value.replace(/\.+$/g, '').toUpperCase()
  return ['CON', 'PRN', 'AUX', 'NUL', 'CLOCK$'].includes(upper) || /^(COM|LPT)[1-9]$/.test(upper)
}

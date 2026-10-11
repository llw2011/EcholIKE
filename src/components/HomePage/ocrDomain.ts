import { fileToBase64 } from '../../lib/filePayload'
import { safeDownloadBaseName } from '../../lib/fileNames'
import { userFacingWarningMessage, type BackendErrorDiagnostic } from '../../lib/userErrors'
import type { OcrReadResult, ScreenOcrSelectionOutcome, UploadedOcrFile } from '../../lib/tauri'

export type ScreenOcrMode = 'window' | 'selection'

export const OCR_UPLOAD_MAX_BYTES = 25 * 1024 * 1024
export const OCR_PROXY_PDF_MAX_PAGES = 20
export const OCR_UPLOAD_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp']
export const OCR_UPLOAD_MIME_TYPES = [...OCR_UPLOAD_IMAGE_MIME_TYPES, 'application/pdf']

export function selectionOcrResult(outcome: ScreenOcrSelectionOutcome): OcrReadResult | null {
  return outcome.status === 'success' ? outcome.result : null
}

export function backendOcrFailureImpairsService(diagnostic: BackendErrorDiagnostic | null) {
  if (!diagnostic) return false
  if (diagnostic.status !== null && diagnostic.status >= 500) return true
  return diagnostic.code?.toLowerCase().endsWith('_timeout') === true
}

export function inferOcrMimeType(file: File) {
  const explicit = file.type.trim()
  if (explicit) return explicit

  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf')) return 'application/pdf'
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg'
  if (name.endsWith('.webp')) return 'image/webp'
  if (name.endsWith('.bmp')) return 'image/bmp'
  return 'application/octet-stream'
}

export function canonicalOcrMimeType(file: File) {
  const mimeType = inferOcrMimeType(file).trim().toLowerCase()
  if (mimeType === 'image/jpg') return 'image/jpeg'
  if (mimeType === 'image/x-bmp' || mimeType === 'image/x-ms-bmp') return 'image/bmp'
  if (mimeType === 'application/x-pdf') return 'application/pdf'
  if (mimeType !== 'application/octet-stream') return mimeType

  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf')) return 'application/pdf'
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg'
  if (name.endsWith('.webp')) return 'image/webp'
  if (name.endsWith('.bmp')) return 'image/bmp'
  return mimeType
}

export function ocrUploadAccept(mimeTypes: string[]) {
  const values = new Set<string>()
  for (const mimeType of mimeTypes) {
    const normalized = mimeType.trim().toLowerCase()
    if (!normalized) continue
    values.add(normalized)
    if (normalized === 'image/png') values.add('.png')
    else if (normalized === 'image/jpeg') {
      values.add('.jpg')
      values.add('.jpeg')
    } else if (normalized === 'image/webp') values.add('.webp')
    else if (normalized === 'image/bmp') values.add('.bmp')
    else if (normalized === 'application/pdf') values.add('.pdf')
  }
  return Array.from(values).join(',')
}

export function isPdfOcrUpload(file: File, mimeType = inferOcrMimeType(file)) {
  const normalizedMime = mimeType.trim().toLowerCase()
  return (
    normalizedMime === 'application/pdf' ||
    normalizedMime === 'application/x-pdf' ||
    ((normalizedMime === '' || normalizedMime === 'application/octet-stream') &&
      file.name.toLowerCase().endsWith('.pdf'))
  )
}

export function isImageOcrUpload(file: File, mimeType = inferOcrMimeType(file)) {
  const normalizedMime = mimeType.trim().toLowerCase()
  const name = file.name.toLowerCase()
  if (normalizedMime && normalizedMime !== 'application/octet-stream') {
    return [
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp',
      'image/bmp',
      'image/x-bmp',
      'image/x-ms-bmp',
    ].includes(normalizedMime)
  }
  return (
    name.endsWith('.png') ||
    name.endsWith('.jpg') ||
    name.endsWith('.jpeg') ||
    name.endsWith('.webp') ||
    name.endsWith('.bmp')
  )
}

function fileToImageBase64(file: File) {
  return fileToBase64(file, {
    readErrorMessage: '读取上传图片失败。',
    emptyErrorMessage: '上传图片内容为空。',
  })
}

export async function buildUploadedOcrFile(
  file: File,
  maxInputBytes = OCR_UPLOAD_MAX_BYTES,
): Promise<UploadedOcrFile> {
  const effectiveMaxBytes = Math.min(OCR_UPLOAD_MAX_BYTES, Math.max(1, maxInputBytes))
  if (file.size > effectiveMaxBytes) {
    const maxMegabytes = effectiveMaxBytes / 1024 / 1024
    const readableLimit =
      effectiveMaxBytes < 1024
        ? `${effectiveMaxBytes} B`
        : effectiveMaxBytes < 1024 * 1024
          ? `${Math.floor(effectiveMaxBytes / 1024)} KB`
          : Number.isInteger(maxMegabytes)
            ? `${maxMegabytes} MB`
            : `${maxMegabytes.toFixed(1)} MB`
    throw new Error(`上传附件不能超过 ${readableLimit}。`)
  }

  const mimeType = inferOcrMimeType(file)
  if (isPdfOcrUpload(file, mimeType)) {
    return {
      fileName: file.name || 'document.pdf',
      mimeType,
      fileBase64: await fileToBase64(file, {
        readErrorMessage: '读取上传 PDF 失败。',
        emptyErrorMessage: '上传 PDF 内容为空。',
      }),
    }
  }

  if (isImageOcrUpload(file, mimeType)) {
    return {
      fileName: file.name || 'image.png',
      mimeType,
      imageBase64: await fileToImageBase64(file),
    }
  }

  throw new Error('暂只支持 PNG、JPG、WebP、BMP 和 PDF。')
}

export function ocrSourceLabel(result?: OcrReadResult | null) {
  return result?.source_kind === 'upload' ? '附件 OCR' : '屏幕 OCR'
}

export function ocrRouteLabel(result?: OcrReadResult | null) {
  if (result?.route === 'direct') return '直接识别'
  if (result?.route === 'tile') return '分块识别'
  if (result?.route === 'pipeline') return '文档识别'
  return null
}

export function ocrWarningMessage(result: OcrReadResult) {
  const warnings = Array.from(
    new Set(
      (result.warnings ?? [])
        .map((warning) => warning.trim())
        .filter(Boolean)
        .map((warning) => {
          const friendly = userFacingWarningMessage(
            warning,
            '部分内容采用兼容方式识别，结果可能不完整。',
          )
          return friendly
            .replace(/图片\s*Router/gi, '图片识别组件')
            .replace(/PDF\s*Pipeline/gi, 'PDF 文档组件')
            .replace(/文档管线/g, '文档识别')
            .replace(/处理链路/g, '处理流程')
        }),
    ),
  )
  if (warnings.length) return warnings.join('；')
  return result.degraded ? '完整文档处理未完成，当前展示可用的识别结果。' : null
}

export function markdownDownloadName(result: OcrReadResult) {
  const rawName = result.source_name || result.window_title || 'echolike-ocr'
  return `${safeDownloadBaseName(rawName, 'echolike-ocr')}.md`
}

export function cleanOcrText(text: string) {
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())

  while (true) {
    const before = lines.length
    while (
      lines.length &&
      (lines[lines.length - 1].trim() === '' || isPipeOnlyLine(lines[lines.length - 1]))
    ) {
      lines.pop()
    }

    if (removeTrailingEmptyCodeFence(lines)) continue
    if (lines.length === before) break
  }

  return lines.join('\n').trim()
}

export function cleanOcrResult(result: OcrReadResult): OcrReadResult {
  const text = cleanOcrText(result.text)
  return text === result.text ? result : { ...result, text }
}

function removeTrailingEmptyCodeFence(lines: string[]) {
  const lastMarker = codeFenceMarker(lines[lines.length - 1])
  if (!lastMarker) return false

  for (let index = lines.length - 2; index >= 0; index -= 1) {
    if (codeFenceMarker(lines[index]) !== lastMarker) continue

    const emptyBody = lines
      .slice(index + 1, -1)
      .every((line) => line.trim() === '' || isPipeOnlyLine(line))
    if (!emptyBody) return false

    lines.splice(index)
    return true
  }

  lines.pop()
  return true
}

function codeFenceMarker(line: string | undefined) {
  const trimmed = line?.trimStart() ?? ''
  if (trimmed.startsWith('```')) return '`'
  if (trimmed.startsWith('~~~')) return '~'
  return null
}

function isPipeOnlyLine(line: string | undefined) {
  const trimmed = line?.trim() ?? ''
  return Boolean(trimmed) && Array.from(trimmed).every((ch) => ch === '|' || /\s/u.test(ch))
}

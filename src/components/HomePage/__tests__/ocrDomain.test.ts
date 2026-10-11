import { describe, expect, it } from 'vitest'
import type { OcrReadResult } from '../../../lib/tauri'
import {
  OCR_PROXY_PDF_MAX_PAGES,
  OCR_UPLOAD_IMAGE_MIME_TYPES,
  OCR_UPLOAD_MAX_BYTES,
  OCR_UPLOAD_MIME_TYPES,
  backendOcrFailureImpairsService,
  buildUploadedOcrFile,
  canonicalOcrMimeType,
  cleanOcrResult,
  cleanOcrText,
  inferOcrMimeType,
  isImageOcrUpload,
  isPdfOcrUpload,
  markdownDownloadName,
  ocrRouteLabel,
  ocrSourceLabel,
  ocrUploadAccept,
  ocrWarningMessage,
  selectionOcrResult,
} from '../ocrDomain'

const baseResult: OcrReadResult = {
  app_name: 'Chrome',
  window_title: '订单页面',
  app_type: 'Browser',
  text: '# 订单',
  elapsed_ms: 321,
  model: 'glm-ocr:latest',
}

describe('Workbench OCR domain', () => {
  it('keeps the upload and PDF contract constants stable', () => {
    expect(OCR_UPLOAD_MAX_BYTES).toBe(25 * 1024 * 1024)
    expect(OCR_PROXY_PDF_MAX_PAGES).toBe(20)
    expect(OCR_UPLOAD_IMAGE_MIME_TYPES).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/bmp',
    ])
    expect(OCR_UPLOAD_MIME_TYPES).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/bmp',
      'application/pdf',
    ])
  })

  it('unwraps successful selection OCR and preserves cancellation', () => {
    expect(selectionOcrResult({ status: 'success', result: baseResult })).toBe(baseResult)
    expect(selectionOcrResult({ status: 'cancelled' })).toBeNull()
  })

  it('infers and canonicalizes supported OCR MIME aliases without trusting misleading suffixes', () => {
    const unnamedPdf = new File(['%PDF-1.7'], 'REPORT.PDF')
    const jpegAlias = new File(['jpeg'], 'photo.bin', { type: 'image/jpg' })
    const bmpAlias = new File(['bmp'], 'scan.bin', { type: 'image/x-ms-bmp' })
    const pdfAlias = new File(['%PDF'], 'scan.bin', { type: 'application/x-pdf' })
    const octetJpeg = new File(['jpeg'], 'PHOTO.JPEG', {
      type: 'application/octet-stream',
    })
    const misleadingPdf = new File(['plain'], 'report.pdf', { type: 'text/plain' })

    expect(inferOcrMimeType(unnamedPdf)).toBe('application/pdf')
    expect(canonicalOcrMimeType(jpegAlias)).toBe('image/jpeg')
    expect(canonicalOcrMimeType(bmpAlias)).toBe('image/bmp')
    expect(canonicalOcrMimeType(pdfAlias)).toBe('application/pdf')
    expect(canonicalOcrMimeType(octetJpeg)).toBe('image/jpeg')
    expect(isPdfOcrUpload(unnamedPdf)).toBe(true)
    expect(isPdfOcrUpload(misleadingPdf)).toBe(false)
    expect(isImageOcrUpload(jpegAlias)).toBe(true)
    expect(isImageOcrUpload(new File(['gif'], 'photo.gif', { type: 'image/gif' }))).toBe(false)
  })

  it('builds a stable file-picker accept list with extensions and de-duplication', () => {
    expect(ocrUploadAccept(OCR_UPLOAD_MIME_TYPES)).toBe(
      'image/png,.png,image/jpeg,.jpg,.jpeg,image/webp,.webp,image/bmp,.bmp,application/pdf,.pdf',
    )
    expect(ocrUploadAccept([' IMAGE/JPEG ', 'application/pdf', 'image/jpeg', ''])).toBe(
      'image/jpeg,.jpg,.jpeg,application/pdf,.pdf',
    )
  })

  it('builds image and PDF payloads with their original bridge field names', async () => {
    await expect(
      buildUploadedOcrFile(new File(['image'], 'scan.png', { type: 'image/png' })),
    ).resolves.toEqual({
      fileName: 'scan.png',
      mimeType: 'image/png',
      imageBase64: 'aW1hZ2U=',
    })
    await expect(buildUploadedOcrFile(new File(['%PDF'], 'scan.pdf'))).resolves.toEqual({
      fileName: 'scan.pdf',
      mimeType: 'application/pdf',
      fileBase64: 'JVBERg==',
    })
    await expect(
      buildUploadedOcrFile(new File(['jpeg'], 'scan.bin', { type: 'image/jpg' })),
    ).resolves.toEqual({
      fileName: 'scan.bin',
      mimeType: 'image/jpg',
      imageBase64: 'anBlZw==',
    })
  })

  it('enforces the negotiated upload limit and rejects empty or unsupported files readably', async () => {
    const exactlyAtLimit = new File(['1234'], 'scan.png', { type: 'image/png' })
    await expect(buildUploadedOcrFile(exactlyAtLimit, 4)).resolves.toMatchObject({
      fileName: 'scan.png',
      imageBase64: 'MTIzNA==',
    })
    await expect(
      buildUploadedOcrFile(new File(['12345'], 'scan.png', { type: 'image/png' }), 4),
    ).rejects.toThrow('上传附件不能超过 4 B。')
    await expect(
      buildUploadedOcrFile(
        { size: OCR_UPLOAD_MAX_BYTES + 1, name: 'huge.pdf', type: 'application/pdf' } as File,
        OCR_UPLOAD_MAX_BYTES * 2,
      ),
    ).rejects.toThrow('上传附件不能超过 25 MB。')
    await expect(
      buildUploadedOcrFile(new File([], 'scan.png', { type: 'image/png' })),
    ).rejects.toThrow('上传图片内容为空。')
    await expect(buildUploadedOcrFile(new File([], 'scan.pdf'))).rejects.toThrow(
      '上传 PDF 内容为空。',
    )
    await expect(
      buildUploadedOcrFile(new File(['gif'], 'scan.gif', { type: 'image/gif' })),
    ).rejects.toThrow('暂只支持 PNG、JPG、WebP、BMP 和 PDF。')
  })

  it('keeps backend service impairment limited to server and timeout diagnostics', () => {
    expect(backendOcrFailureImpairsService(null)).toBe(false)
    expect(
      backendOcrFailureImpairsService({
        service: 'ocr',
        status: 503,
        code: 'ocr_failed',
        requestId: 'req-1',
        stage: null,
      }),
    ).toBe(true)
    expect(
      backendOcrFailureImpairsService({
        service: 'ocr',
        status: 401,
        code: 'OCR_TIMEOUT',
        requestId: 'req-2',
        stage: null,
      }),
    ).toBe(true)
    expect(
      backendOcrFailureImpairsService({
        service: 'ocr',
        status: 429,
        code: 'quota_exhausted',
        requestId: 'req-3',
        stage: null,
      }),
    ).toBe(false)
  })

  it('maps source, route, warnings, and degraded results to the existing UI copy', () => {
    expect(ocrSourceLabel(baseResult)).toBe('屏幕 OCR')
    expect(ocrSourceLabel({ ...baseResult, source_kind: 'upload' })).toBe('附件 OCR')
    expect(ocrRouteLabel({ ...baseResult, route: 'direct' })).toBe('直接识别')
    expect(ocrRouteLabel({ ...baseResult, route: 'tile' })).toBe('分块识别')
    expect(ocrRouteLabel({ ...baseResult, route: 'pipeline' })).toBe('文档识别')
    expect(ocrRouteLabel(baseResult)).toBeNull()

    expect(
      ocrWarningMessage({
        ...baseResult,
        warnings: [
          '图片 Router 暂时不可用',
          ' 图片 Router 暂时不可用 ',
          'PDF Pipeline 处理链路已降级',
        ],
      }),
    ).toBe('图片识别组件 暂时不可用；PDF 文档组件 处理流程已降级')
    expect(
      ocrWarningMessage({
        ...baseResult,
        warnings: ['文档管线不可用', '文档识别不可用'],
      }),
    ).toBe('文档识别不可用')
    expect(
      ocrWarningMessage({
        ...baseResult,
        warnings: ['C:\\Temp\\ocr-job.ps1:12 RuntimeException'],
      }),
    ).toBe('部分内容采用兼容方式识别，结果可能不完整。')
    expect(ocrWarningMessage({ ...baseResult, degraded: true })).toBe(
      '完整文档处理未完成，当前展示可用的识别结果。',
    )
    expect(ocrWarningMessage(baseResult)).toBeNull()
  })

  it('sanitizes OCR Markdown download names with the existing Windows rules', () => {
    expect(markdownDownloadName({ ...baseResult, source_name: 'CON?.pdf' })).toBe('CON-file.md')
    expect(
      markdownDownloadName({ ...baseResult, source_name: null, window_title: 'report.pdf' }),
    ).toBe('report.md')
    expect(markdownDownloadName({ ...baseResult, source_name: '', window_title: '' })).toBe(
      'echolike-ocr.md',
    )
  })

  it('removes only trailing empty OCR artifacts while preserving readable fenced content', () => {
    expect(cleanOcrText(['Visible OCR text', '', '```', '```', '', '|', '|'].join('\r\n'))).toBe(
      'Visible OCR text',
    )
    expect(cleanOcrText(['Visible', '', '~~~', ' | ', '~~~'].join('\n'))).toBe('Visible')
    expect(
      cleanOcrText(['Visible  ', '', '```text', 'copy code  ', '```', '', '|'].join('\n')),
    ).toBe(['Visible', '', '```text', 'copy code', '```'].join('\n'))
    expect(cleanOcrText(['A', '|', 'B', '|'].join('\n'))).toBe(['A', '|', 'B'].join('\n'))
  })

  it('preserves object identity for clean results and clones only when text changes', () => {
    expect(cleanOcrResult(baseResult)).toBe(baseResult)

    const dirty = { ...baseResult, text: 'Visible\n\n```\n```\n|' }
    const cleaned = cleanOcrResult(dirty)
    expect(cleaned).not.toBe(dirty)
    expect(cleaned).toEqual({ ...dirty, text: 'Visible' })
  })
})

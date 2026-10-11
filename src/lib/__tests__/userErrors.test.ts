import { describe, expect, it } from 'vitest'
import {
  apiErrorFromResponse,
  apiErrorMessage,
  backendErrorDiagnostic,
  userFacingErrorMessage,
  userFacingWarningMessage,
} from '../userErrors'

describe('user-facing backend errors', () => {
  it.each([
    ['operation_in_progress', '服务仍在确认本次结果，请稍候再试。系统不会重复扣费。'],
    ['idempotency_conflict', '恢复信息与本次内容不一致，已停止请求。请重新发起；本次未重复扣费。'],
    [
      'operation_result_expired',
      '上次操作已按一次计费，系统没有再次扣费，但结果副本已过期。若重新发起，将作为一次新操作计费。',
    ],
  ])('explains billing-safe operation state %s', (code, expected) => {
    expect(apiErrorMessage({ code }, 'fallback')).toBe(expected)
  })

  it('translates quota errors without exposing backend wording', () => {
    const message = apiErrorMessage(
      { code: 'tts_quota_exceeded', message: 'TTS quota exceeded' },
      'TTS 朗读失败。',
      'tts',
    )

    expect(message).toBe('额度不足，请充值。')
    expect(message).not.toMatch(/quota exceeded/i)
  })

  it('turns provider failures into actionable service messages', () => {
    const message = apiErrorMessage(
      { error: 'Cloud LLM provider request failed' },
      '后台问答失败。',
      'llm',
      502,
    )

    expect(message).toBe('文本 AI 服务暂时不可用，请稍后重试；若持续出现，请联系管理员。')
    expect(message).not.toContain('Cloud LLM provider request failed')
  })

  it('translates raw TTS timeout errors without exposing provider wording', () => {
    const message = userFacingErrorMessage(new Error('Cloud TTS timed out'), '朗读失败。', 'tts')

    expect(message).toBe('朗读服务响应超时，请稍后重试。')
    expect(message).not.toMatch(/timed out|time out/i)
  })

  it('keeps auth failures readable from a response body', async () => {
    const error = await apiErrorFromResponse(
      new Response(JSON.stringify({ code: 'unauthorized', error: 'Authentication required' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
      '后台授权失败。',
      'auth',
    )

    expect(error.message).toBe('后台授权已失效，请重新登录。')
  })

  it('turns invalid backend credentials into one actionable message', () => {
    expect(userFacingErrorMessage(new Error('Invalid credentials'), '后台授权失败。', 'auth')).toBe(
      '后台账号或密码不正确，请检查后重试。',
    )
  })

  it('translates structured errors returned by desktop commands', () => {
    const error = new Error(
      JSON.stringify({
        service: 'tts',
        status: 401,
        code: 'unauthorized',
        message: 'Authentication required',
        requestId: 'req-1',
      }),
    )
    const message = userFacingErrorMessage(error, 'TTS 朗读失败。', 'tts')

    expect(message).toBe('后台授权已失效，请重新登录。')
    expect(message).not.toContain('Authentication required')
    expect(backendErrorDiagnostic(error)).toEqual({
      service: 'tts',
      status: 401,
      code: 'unauthorized',
      requestId: 'req-1',
      stage: null,
    })
  })

  it('trusts structured service codes before ambiguous provider wording', () => {
    const message = apiErrorMessage(
      { code: 'ocr_invalid_key', message: 'Provider credentials are invalid' },
      'OCR 识别失败。',
      'ocr',
      401,
    )

    expect(message).toBe('后台 OCR 服务配置无效，请联系管理员处理。')
    expect(message).not.toContain('账号或密码')
  })

  it('keeps validation failures about the submitted content', () => {
    expect(
      apiErrorMessage(
        { code: 'validation_failed', message: 'Validation failed' },
        '提交失败。',
        'ocr',
        422,
      ),
    ).toBe('提交内容不符合要求，请检查输入或文件后重试。')
  })

  it('uses a structured object status instead of exposing its raw message', () => {
    expect(
      userFacingErrorMessage(
        { service: 'tts', status: 502, code: 'upstream', message: 'TTS 上游失败。' },
        '朗读服务检查未通过。',
        'tts',
      ),
    ).toBe('后台朗读服务暂时不可用，请稍后重试。')
  })

  it('hides signed updater internals', () => {
    const message = userFacingErrorMessage(
      new Error('No signed updater package is available for this version.'),
      '更新下载失败。',
      'update',
    )

    expect(message).toBe(
      '当前版本暂时没有可安装的更新包，请稍后再试；若持续出现，请联系管理员检查更新服务。',
    )
  })

  it('explains local configuration errors instead of showing raw command text', () => {
    expect(
      userFacingErrorMessage(new Error('Base URL is empty'), '文本 AI 测试失败。', 'llm'),
    ).toBe('文本 AI 服务地址不正确，请在设置里检查服务地址。')
    expect(userFacingErrorMessage(new Error('HTTP 404'), 'OCR 测试失败。', 'ocr')).toBe(
      'OCR 服务地址或模型不可用，请检查配置后重试。',
    )
    expect(userFacingErrorMessage(new Error('HTTP 401'), '文本 AI 测试失败。', 'llm')).toBe(
      '文本 AI 服务配置无效，请在设置中检查服务密钥。',
    )
    expect(
      userFacingErrorMessage(new Error('OCR HTTP 403: forbidden'), 'OCR 测试失败。', 'ocr'),
    ).toBe('OCR 服务未获授权，请检查服务账号或密钥的权限。')
  })

  it('explains independent local OCR component and PDF limit failures', () => {
    expect(
      userFacingErrorMessage(new Error('Ollama model is unavailable'), 'OCR 失败。', 'ocr'),
    ).toBe('没有找到当前 OCR 模型，请在设置里换一个可用模型，或先在本机拉取该模型。')
    expect(
      userFacingErrorMessage(
        new Error('GLM-OCR Pipeline is not installed for the current Windows user'),
        'OCR 失败。',
        'ocr',
      ),
    ).toBe('本机 PDF 文档识别组件未安装；截图和图片识别可能仍可使用。')
    expect(
      userFacingErrorMessage(
        new Error('PDF exceeds the 20-page local OCR limit'),
        'OCR 失败。',
        'ocr',
      ),
    ).toBe('这份 PDF 超过当前一次最多 20 页的处理上限。请拆分后重试。')
    expect(
      userFacingErrorMessage(
        new Error('Uploaded file does not contain a valid PDF signature'),
        'OCR 失败。',
        'ocr',
      ),
    ).toBe('上传文件不是有效的 PDF，请重新选择原始文档。')
    expect(
      userFacingErrorMessage(
        new Error('Uploaded file is not a supported PNG, JPG, WebP, or BMP image'),
        'OCR 失败。',
        'ocr',
      ),
    ).toBe('上传文件不是有效的 PNG、JPG、WebP 或 BMP 图片。')
    expect(
      userFacingErrorMessage(
        new Error('Another local OCR request is already running'),
        'OCR 失败。',
        'ocr',
      ),
    ).toBe('本机 OCR 正在处理另一个任务，请等待当前任务完成。')
  })

  it('translates server PDF document and pipeline codes without exposing implementation terms', () => {
    expect(apiErrorMessage({ code: 'ocr_document_invalid' }, 'fallback', 'ocr', 422)).toBe(
      '无法读取这份 PDF，请确认文件未损坏、未加密，然后重试。',
    )
    expect(apiErrorMessage({ code: 'ocr_document_page_limit' }, 'fallback', 'ocr', 422)).toBe(
      '这份 PDF 超过当前一次最多 20 页的处理上限。请拆分后重试。',
    )
    expect(apiErrorMessage({ code: 'ocr_document_no_text' }, 'fallback', 'ocr', 422)).toBe(
      '这份 PDF 没有提取到可用文字，请确认文档内容后重试。',
    )
    expect(apiErrorMessage({ code: 'ocr_pipeline_unavailable' }, 'fallback', 'ocr', 503)).toBe(
      '后台 PDF 文档识别暂时不可用，请稍后重试。',
    )
  })

  it('turns a PowerShell PDF page-limit dump into one actionable sentence', () => {
    const raw = [
      '后台托管 OCR 请求失败：PDF has 68 pages; the current OCR upload limit is 20 pages.',
      'C:\\Users\\TestUser\\AppData\\Local\\Temp\\echolike-ocr-5556.ps1:51 字符: 3',
      '+ throw "PDF has $pageCount pages"',
      'CategoryInfo : OperationStopped: (PDF has 68 pages:String) [], RuntimeException',
      'FullyQualifiedErrorId : PDF has 68 pages',
    ].join('\n')

    const message = userFacingErrorMessage(new Error(raw), '暂时无法识别这个附件。', 'ocr')

    expect(message).toBe('这份 PDF 共 68 页，当前一次最多处理 20 页。请拆分后重试。')
    expect(message).not.toMatch(/PowerShell|CategoryInfo|RuntimeException|\.ps1|C:\\/i)
  })

  it('never treats mixed-language diagnostics or plain English as user-facing copy', () => {
    expect(
      userFacingErrorMessage(
        new Error('处理失败：C:\\Temp\\job.ps1:12 RuntimeException ����'),
        '暂时无法完成处理，请稍后重试。',
      ),
    ).toBe('暂时无法完成处理，请稍后重试。')
    expect(
      userFacingErrorMessage(
        new Error('Something went wrong while preparing the document'),
        '暂时无法完成处理，请稍后重试。',
      ),
    ).toBe('暂时无法完成处理，请稍后重试。')
    expect(
      userFacingErrorMessage(new Error('处理失败：HTTP 500'), '暂时无法完成处理，请稍后重试。'),
    ).toBe('服务暂时不可用，请稍后重试。')
    expect(
      userFacingErrorMessage(
        new Error('处理失败：{"code":"provider_failed","status":502}'),
        '暂时无法完成处理，请稍后重试。',
      ),
    ).toBe('暂时无法完成处理，请稍后重试。')
    expect(
      userFacingErrorMessage(
        new Error('保存文件失败：os error 5'),
        '文件保存失败，请检查保存位置后重试。',
      ),
    ).toBe('文件保存失败，请检查保存位置后重试。')
  })

  it('keeps a degraded warning from being promoted to a service failure', () => {
    const fallback = '部分内容采用兼容方式识别，结果可能不完整。'

    expect(userFacingWarningMessage('第 2 页未提取到文字', fallback)).toBe('第 2 页未提取到文字')
    expect(userFacingWarningMessage('Pipeline provider failed', fallback)).toBe(fallback)
    expect(userFacingWarningMessage('C:\\Temp\\ocr.ps1:12 RuntimeException', fallback)).toBe(
      fallback,
    )
  })
})

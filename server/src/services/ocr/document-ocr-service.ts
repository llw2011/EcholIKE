import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix, resolve } from 'node:path'
import { ApiError } from '../../errors.js'
import type { ServerEnv } from '../../env.js'
import { QuotaReplaySignal } from '../quota/quota-response.js'
import {
  type LocalOcrProbeResult,
  type LocalOcrRuntime,
  type LocalOcrTargetSnapshot,
} from './local-ocr-runtime.js'
import { startLocalOcrRelay } from './local-ocr-relay.js'
import {
  assertPipelinePrimaryRelayEvidence,
  finalizePipelinePdfArtifact,
  MAX_PIPELINE_TEXT_BYTES,
  parsePipelinePdfArtifacts,
  readPipelineArtifactFiles,
  readPipelineRecoveryImages,
} from './pipeline-artifact.js'

export {
  finalizePipelinePdfArtifact,
  MAX_PIPELINE_TEXT_BYTES,
  parsePipelinePdfArtifacts,
  readPipelineArtifactFiles,
  readPipelineRecoveryImages,
} from './pipeline-artifact.js'

const MAX_PDF_BYTES = 25 * 1024 * 1024
const MAX_PDF_PAGES = 20
const PDF_PAGE_SENTINEL = MAX_PDF_PAGES + 1
const PIPELINE_DEADLINE_MS = 900_000
const PROBE_DEADLINE_MS = 20_000
const TERMINATE_GRACE_MS = 3_000
const MAX_PROBE_STDOUT_BYTES = 64 * 1024
const MAX_INSPECT_STDOUT_BYTES = 4 * 1024
const JOB_OWNER_MARKER = '.echolike-server-ocr-job-v1'
const JOB_STALE_MS = 24 * 60 * 60 * 1000
const RUNTIME_PROBE_CACHE_MS = 30_000
const CAPABILITY_TARGET_ATTEMPTS = 3
const DOCUMENT_CONTRACT = 'ocr-document-v1'
const PIPELINE_IMAGE_FORMAT = 'JPEG'
const PIPELINE_MAX_PIXELS = 25_000_000
const PIPELINE_PDF_DPI = 200
const RUNTIME_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CACHE_HOME',
  'HF_HOME',
  'HUGGINGFACE_HUB_CACHE',
  'TRANSFORMERS_CACHE',
  'TORCH_HOME',
  'LD_LIBRARY_PATH',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
])
const PDF_INSPECT_SCRIPT = [
  'import fitz, json, sys',
  'document = fitz.open(sys.argv[1])',
  'try:',
  '    print(json.dumps({"pageCount": document.page_count, "needsPassword": bool(document.needs_pass)}))',
  'finally:',
  '    document.close()',
].join('\n')

export interface DocumentOcrCapability {
  available: boolean
  providerAvailable: boolean
  model: string | null
  documentContract?: typeof DOCUMENT_CONTRACT
}

export interface DocumentOcrResult {
  text: string
  model: string
  pageCount: number
  warnings: string[]
  degraded: boolean
}

export type DocumentOcrFailureStage =
  | 'runtime'
  | 'preflight'
  | 'gate'
  | 'reserve'
  | 'pipeline'
  | 'artifact'
  | 'deadline'
  | 'cancelled'

export interface DocumentOcrFailureDiagnostic {
  event: 'ocr_document_failure'
  requestId: string | null
  stage: DocumentOcrFailureStage
  elapsedMs: number
  code: string
  pageCount: number | null
  model: string | null
  endpointHost: string | null
}

export type DocumentOcrDiagnosticSink = (diagnostic: DocumentOcrFailureDiagnostic) => void

export interface DocumentOcrProcessInput {
  document: Blob
  requestId: string
  signal?: AbortSignal
  assertAvailable(pageCount: number): Promise<void>
  reserve(pageCount: number): Promise<void>
}

export interface DocumentOcrService {
  warmup(): Promise<void>
  capability(): Promise<DocumentOcrCapability>
  process(input: DocumentOcrProcessInput): Promise<DocumentOcrResult>
  shutdown(): Promise<void>
}

export interface LocalOcrExecutionGate {
  run<T>(
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>
  isAvailable(): boolean
  poison(): void
  close(): Promise<void>
}

interface RuntimeTarget {
  pipelineBin: string | null
  pythonBin: string | null
  snapshot: LocalOcrTargetSnapshot
}

interface DocumentOcrServiceOptions {
  diagnosticSink?: DocumentOcrDiagnosticSink
  jobParent?: string
  processRunner?: typeof runProcess
  removeJobDirectory?: typeof removeOwnedJobDirectory
  localOcrRuntime?: LocalOcrRuntime
}

interface ProcessOutput {
  stdout: Buffer
}

interface GateEntry<T = unknown> {
  signal?: AbortSignal
  operation(signal: AbortSignal): Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
  abortListener?: () => void
}

class ProcessAbortedError extends Error {}
class ProcessExecutionError extends Error {}
export class UnconfirmedProcessTreeError extends ProcessExecutionError {}

export function createLocalOcrExecutionGate(): LocalOcrExecutionGate {
  const queue: GateEntry[] = []
  const closeWaiters: Array<() => void> = []
  let active: { entry: GateEntry; controller: AbortController } | null = null
  let closed = false
  let poisoned = false

  const settleClose = () => {
    if (active || queue.length) return
    for (const resolveClose of closeWaiters.splice(0)) resolveClose()
  }

  const removeAbortListener = (entry: GateEntry) => {
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener('abort', entry.abortListener)
    }
  }

  const rejectQueued = () => {
    for (const entry of queue.splice(0)) {
      removeAbortListener(entry)
      entry.reject(pipelineUnavailableError())
    }
  }

  const poison = (abortActive: boolean) => {
    if (poisoned) return
    poisoned = true
    closed = true
    rejectQueued()
    if (abortActive) active?.controller.abort('process-tree-unconfirmed')
    if (!active) settleClose()
  }

  const pump = () => {
    if (active) return
    const entry = queue.shift()
    if (!entry) {
      settleClose()
      return
    }
    if (entry.signal?.aborted) {
      removeAbortListener(entry)
      entry.reject(cancelledError())
      pump()
      return
    }

    const controller = new AbortController()
    active = { entry, controller }
    removeAbortListener(entry)
    if (entry.signal) {
      entry.abortListener = () => controller.abort(entry.signal?.reason)
      entry.signal.addEventListener('abort', entry.abortListener, { once: true })
    }

    void entry.operation(controller.signal).then(
      (value) => {
        if (poisoned) entry.reject(pipelineUnavailableError())
        else entry.resolve(value)
        removeAbortListener(entry)
        active = null
        pump()
      },
      (error: unknown) => {
        if (error instanceof UnconfirmedProcessTreeError) poison(false)
        entry.reject(error)
        removeAbortListener(entry)
        active = null
        if (poisoned) settleClose()
        else pump()
      },
    )
  }

  return {
    run<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>) {
      if (closed) return Promise.reject(pipelineUnavailableError())
      if (signal?.aborted) return Promise.reject(cancelledError())

      return new Promise<T>((resolveEntry, rejectEntry) => {
        const entry: GateEntry<T> = {
          operation,
          resolve: resolveEntry,
          reject: rejectEntry,
          ...(signal ? { signal } : {}),
        }
        if (signal) {
          entry.abortListener = () => {
            const index = queue.indexOf(entry as GateEntry)
            if (index < 0) return
            queue.splice(index, 1)
            removeAbortListener(entry)
            rejectEntry(cancelledError())
            settleClose()
          }
          signal.addEventListener('abort', entry.abortListener, { once: true })
        }
        queue.push(entry as GateEntry)
        pump()
      })
    },

    isAvailable() {
      return !closed
    },

    poison() {
      poison(true)
    },

    async close() {
      if (!closed) {
        closed = true
        rejectQueued()
        active?.controller.abort('shutdown')
      }
      if (!active) return
      await new Promise<void>((resolveClose) => closeWaiters.push(resolveClose))
    },
  }
}

export function createDocumentOcrService(
  env: ServerEnv,
  executionGate: LocalOcrExecutionGate,
  options: DocumentOcrServiceOptions = {},
): DocumentOcrService {
  const pipelineBin = env.glmocrPipelineBin
  const jobParent = options.jobParent ?? join(tmpdir(), 'echolike-server-ocr')
  const processRunner = options.processRunner ?? runProcess
  const removeJobDirectory = options.removeJobDirectory ?? removeOwnedJobDirectory
  const diagnosticSink = options.diagnosticSink ?? (() => undefined)
  const localOcrRuntime = options.localOcrRuntime
  let staticProbeCache: { key: string; checkedAt: number } | null = null
  let capabilityCache: DocumentOcrCapability = {
    available: false,
    providerAvailable: false,
    model: null,
  }
  let capabilityRefresh: Promise<void> | null = null
  const shutdownController = new AbortController()
  const activeTasks = new Set<Promise<unknown>>()
  let shutdownPromise: Promise<void> | null = null

  function trackActive<T>(task: Promise<T>): Promise<T> {
    activeTasks.add(task)
    void task.then(
      () => activeTasks.delete(task),
      () => activeTasks.delete(task),
    )
    return task
  }

  async function runtimeTarget(signal?: AbortSignal): Promise<RuntimeTarget> {
    if (!localOcrRuntime) throw pipelineUnavailableError()
    const snapshot = await localOcrRuntime.resolveCurrent(signal)
    if (!pipelineBin || !isAbsolute(pipelineBin) || !isGlmOcrModel(snapshot.model)) {
      return { pipelineBin: null, pythonBin: null, snapshot }
    }
    const pythonBin = pipelinePythonBinary(pipelineBin, env.glmocrPipelinePython)
    return {
      pipelineBin,
      pythonBin,
      snapshot,
    }
  }

  async function probeRuntime(
    target: RuntimeTarget,
    force = false,
    callerSignal?: AbortSignal,
  ): Promise<{ provider: LocalOcrProbeResult; pipelineAvailable: boolean }> {
    const now = Date.now()
    const deadline = createDeadlineSignal(
      [callerSignal, shutdownController.signal],
      PROBE_DEADLINE_MS,
    )
    let provider: LocalOcrProbeResult = { available: false, reason: 'unreachable' }
    try {
      if (!localOcrRuntime) throw pipelineUnavailableError()
      provider = await localOcrRuntime.probe(target.snapshot, deadline.signal, { force })
      if (!provider.available) return { provider, pipelineAvailable: false }
      if (!target.pipelineBin || !target.pythonBin) {
        return { provider, pipelineAvailable: false }
      }
      const staticKey = `${target.pipelineBin}|${target.pythonBin}`
      if (
        staticProbeCache?.key === staticKey &&
        now - staticProbeCache.checkedAt < RUNTIME_PROBE_CACHE_MS
      ) {
        return { provider, pipelineAvailable: true }
      }
      await access(target.pipelineBin, fsConstants.X_OK)
      await access(target.pythonBin, fsConstants.X_OK)
      const pipeline = await processRunner({
        command: target.pythonBin,
        args: ['-m', 'glmocr', 'parse', '--help'],
        cwd: dirname(target.pipelineBin),
        env: isolatedRuntimeEnvironment(),
        signal: deadline.signal,
        captureStdout: true,
        maxStdoutBytes: MAX_PROBE_STDOUT_BYTES,
      })
      const help = pipeline.stdout.toString('utf8')
      if (!help.includes('--json-only') || !help.includes('--set'))
        throw new Error('incompatible CLI')
      await processRunner({
        command: target.pythonBin,
        args: ['-c', 'import fitz; print("pymupdf-ready")'],
        cwd: dirname(target.pipelineBin),
        env: isolatedRuntimeEnvironment(),
        signal: deadline.signal,
        captureStdout: true,
        maxStdoutBytes: MAX_PROBE_STDOUT_BYTES,
      })
      staticProbeCache = { key: staticKey, checkedAt: now }
      return { provider, pipelineAvailable: true }
    } catch (error) {
      if (error instanceof UnconfirmedProcessTreeError) {
        executionGate.poison()
        throw error
      }
      return {
        provider,
        pipelineAvailable: false,
      }
    } finally {
      deadline.dispose()
    }
  }

  function refreshCapability(): Promise<void> {
    if (shutdownController.signal.aborted) {
      capabilityCache = { available: false, providerAvailable: false, model: null }
      return Promise.resolve()
    }
    if (capabilityRefresh) return capabilityRefresh
    capabilityRefresh = trackActive(
      (async () => {
        try {
          if (!executionGate.isAvailable()) throw pipelineUnavailableError()
          for (let attempt = 0; attempt < CAPABILITY_TARGET_ATTEMPTS; attempt += 1) {
            const target = await runtimeTarget()
            const probe = await probeRuntime(target)
            const current = await runtimeTarget()
            if (current.snapshot.fingerprint !== target.snapshot.fingerprint) continue
            const providerAvailable = probe.provider.available && executionGate.isAvailable()
            capabilityCache = {
              available: providerAvailable && probe.pipelineAvailable,
              providerAvailable,
              model: target.snapshot.model,
              ...(providerAvailable && probe.pipelineAvailable
                ? { documentContract: DOCUMENT_CONTRACT }
                : {}),
            }
            return
          }
          throw pipelineUnavailableError()
        } catch {
          capabilityCache = { available: false, providerAvailable: false, model: null }
        } finally {
          capabilityRefresh = null
        }
      })(),
    )
    return capabilityRefresh
  }

  return {
    async warmup() {
      await refreshCapability()
    },

    async capability() {
      await refreshCapability()
      return capabilityCache
    },

    async process(input) {
      return trackActive(
        (async () => {
          if (shutdownController.signal.aborted) throw pipelineUnavailableError()
          const startedAt = Date.now()
          const deadline = createDeadlineSignal(
            [input.signal, shutdownController.signal],
            PIPELINE_DEADLINE_MS,
          )
          let jobDir: string | null = null
          let target: RuntimeTarget | null = null
          let pageCount: number | null = null
          let stage: DocumentOcrFailureStage = 'preflight'
          let result: DocumentOcrResult | null = null
          let failure: unknown
          let failed = false
          let preserveJob = false
          try {
            validatePdfBlob(input.document)
            stage = 'runtime'
            if (!executionGate.isAvailable()) throw pipelineUnavailableError()
            const activeTarget = await runtimeTarget(deadline.signal)
            target = activeTarget
            const initialProbe = await probeRuntime(activeTarget, true, deadline.signal)
            if (
              !initialProbe.provider.available ||
              !initialProbe.pipelineAvailable ||
              !activeTarget.pipelineBin ||
              !activeTarget.pythonBin ||
              !executionGate.isAvailable()
            ) {
              capabilityCache = {
                available: false,
                providerAvailable: initialProbe.provider.available && executionGate.isAvailable(),
                model: activeTarget.snapshot.model,
              }
              throw pipelineUnavailableError()
            }
            capabilityCache = {
              available: true,
              providerAvailable: true,
              model: activeTarget.snapshot.model,
              documentContract: DOCUMENT_CONTRACT,
            }
            stage = 'preflight'
            jobDir = await createJobDirectory(jobParent)
            const inputPath = join(jobDir, 'input.pdf')
            await writeBlob(input.document, inputPath, deadline.signal)
            const inspectedPageCount = await inspectPdfPageCount(
              { pythonBin: activeTarget.pythonBin },
              inputPath,
              jobDir,
              deadline.signal,
              processRunner,
            )
            pageCount = inspectedPageCount
            await input.assertAvailable(inspectedPageCount)

            stage = 'gate'
            result = await executionGate.run(deadline.signal, async (operationSignal) => {
              stage = 'runtime'
              if (!localOcrRuntime) throw pipelineUnavailableError()
              const currentTarget = await runtimeTarget(operationSignal)
              target = currentTarget
              if (!currentTarget.pipelineBin || !currentTarget.pythonBin) {
                throw pipelineUnavailableError()
              }
              const currentProbe = await localOcrRuntime.probe(
                currentTarget.snapshot,
                operationSignal,
                { force: true },
              )
              if (!currentProbe.available) {
                capabilityCache = {
                  available: false,
                  providerAvailable: false,
                  model: currentTarget.snapshot.model,
                }
                throw pipelineUnavailableError()
              }
              const relay = await startLocalOcrRelay(
                localOcrRuntime,
                currentTarget.snapshot,
                operationSignal,
              )
              try {
                stage = 'reserve'
                await input.reserve(inspectedPageCount)
                const outputDir = join(jobDir as string, 'output')
                await mkdir(outputDir, { mode: 0o700 })
                stage = 'pipeline'
                try {
                  await processRunner({
                    command: currentTarget.pythonBin,
                    args: pipelineArguments(
                      inputPath,
                      outputDir,
                      relay.endpoint,
                      currentTarget.snapshot.model,
                    ),
                    cwd: jobDir as string,
                    env: isolatedRuntimeEnvironment(),
                    signal: operationSignal,
                    captureStdout: false,
                    maxStdoutBytes: 0,
                  })
                  if (operationSignal.aborted) throw new ProcessAbortedError('process cancelled')
                  await relay.settle()
                } catch (error) {
                  if (
                    error instanceof ProcessAbortedError ||
                    error instanceof UnconfirmedProcessTreeError
                  ) {
                    throw error
                  }
                  throw new ApiError(502, 'ocr_failed', 'PDF 识别失败，请稍后重试。')
                }
                stage = 'artifact'
                try {
                  const artifactDirectory = join(outputDir, 'input')
                  const artifacts = await readPipelineArtifactFiles(artifactDirectory)
                  const plan = parsePipelinePdfArtifacts(
                    artifacts.finalArtifact,
                    artifacts.rawArtifact,
                    inspectedPageCount,
                  )
                  assertPipelinePrimaryRelayEvidence(plan, relay.snapshot())
                  const images = await readPipelineRecoveryImages(artifactDirectory, plan.recovery)
                  const recovered = new Map<string, string>()
                  let recoveredBytes = 0
                  for (const image of images) {
                    const text = await relay.recognizeImage(image.bytes)
                    recoveredBytes += Buffer.byteLength(text, 'utf8')
                    if (recoveredBytes > MAX_PIPELINE_TEXT_BYTES) {
                      throw new ApiError(502, 'ocr_failed', 'PDF 识别结果过大，请拆分文档后重试。')
                    }
                    recovered.set(image.candidate.id, text)
                  }
                  await relay.settle()
                  const parsed = finalizePipelinePdfArtifact(plan, recovered, relay.snapshot())
                  return { ...parsed, model: currentTarget.snapshot.model }
                } catch (error) {
                  if (
                    error instanceof ApiError ||
                    error instanceof ProcessAbortedError ||
                    error instanceof UnconfirmedProcessTreeError
                  ) {
                    throw error
                  }
                  throw new ApiError(502, 'ocr_failed', 'PDF 识别失败，请稍后重试。')
                }
              } finally {
                await relay.close()
              }
            })
          } catch (error) {
            if (error instanceof UnconfirmedProcessTreeError) {
              preserveJob = jobDir !== null
              executionGate.poison()
              capabilityCache = { available: false, providerAvailable: false, model: null }
            }
            failed = true
            if (deadline.timedOut()) {
              stage = 'deadline'
              failure = new ApiError(504, 'ocr_timeout', 'PDF 识别超时，请拆分文档后重试。')
            } else if (deadline.signal.aborted || error instanceof ProcessAbortedError) {
              stage = 'cancelled'
              failure = cancelledError()
            } else if (error instanceof UnconfirmedProcessTreeError) {
              failure = pipelineUnavailableError()
            } else {
              failure = error
            }
          } finally {
            deadline.dispose()
            if (jobDir && !preserveJob) {
              try {
                await removeJobDirectory(jobParent, jobDir)
              } catch {
                if (!failed) {
                  failed = true
                  failure = new ApiError(
                    500,
                    'internal_error',
                    'PDF 识别暂时无法完成，请稍后重试。',
                  )
                  stage = 'artifact'
                }
              }
            }
          }

          if (failed) {
            if (!(failure instanceof QuotaReplaySignal)) {
              emitDocumentOcrFailureDiagnostic(diagnosticSink, {
                event: 'ocr_document_failure',
                requestId: diagnosticLabel(input.requestId),
                stage,
                elapsedMs: Math.max(0, Date.now() - startedAt),
                code: failure instanceof ApiError ? failure.code : 'internal_error',
                pageCount,
                model: diagnosticLabel(target?.snapshot.model),
                endpointHost: diagnosticEndpointHost(target?.snapshot.logicalEndpoint),
              })
            }
            throw failure
          }
          if (!result) throw new Error('Document OCR completed without a result')
          return result
        })(),
      )
    },

    async shutdown() {
      if (!shutdownPromise) {
        shutdownController.abort('shutdown')
        capabilityCache = { available: false, providerAvailable: false, model: null }
        shutdownPromise = (async () => {
          await executionGate.close()
          while (activeTasks.size) {
            await Promise.allSettled([...activeTasks])
          }
        })()
      }
      await shutdownPromise
    },
  }
}

export const disabledDocumentOcrService: DocumentOcrService = {
  async warmup() {},
  async capability() {
    return { available: false, providerAvailable: false, model: null }
  },
  async process() {
    throw pipelineUnavailableError()
  },
  async shutdown() {},
}

export function writeDocumentOcrFailureDiagnostic(diagnostic: DocumentOcrFailureDiagnostic): void {
  console.warn(JSON.stringify(diagnostic))
}

function emitDocumentOcrFailureDiagnostic(
  diagnosticSink: DocumentOcrDiagnosticSink,
  diagnostic: DocumentOcrFailureDiagnostic,
): void {
  try {
    diagnosticSink(diagnostic)
  } catch {
    // Diagnostics must never change the request result.
  }
}

function diagnosticEndpointHost(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null
  try {
    return diagnosticLabel(new URL(endpoint).host)
  } catch {
    return null
  }
}

function diagnosticLabel(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/[\u0000-\u001f\u007f]/g, '')
  return normalized ? normalized.slice(0, 200) : null
}

export function pipelineArguments(
  inputPath: string,
  outputDir: string,
  endpoint: string,
  model: string,
): string[] {
  const relayEndpoint = validatedRelayEndpoint(endpoint)
  return [
    '-m',
    'glmocr',
    'parse',
    inputPath,
    '--output',
    outputDir,
    '--json-only',
    '--no-layout-vis',
    '--mode',
    'selfhosted',
    '--layout-device',
    'cpu',
    '--log-level',
    'ERROR',
    '--set',
    'pipeline.ocr_api.api_url',
    relayEndpoint,
    '--set',
    'pipeline.ocr_api.api_mode',
    'ollama_generate',
    '--set',
    'pipeline.ocr_api.model',
    model,
    '--set',
    'pipeline.ocr_api.connection_pool_size',
    '1',
    '--set',
    'pipeline.max_workers',
    '1',
    '--set',
    'pipeline.result_formatter.enable_merge_formula_numbers',
    'false',
    '--set',
    'pipeline.result_formatter.enable_merge_text_blocks',
    'false',
    '--set',
    'pipeline.page_loader.pdf_max_pages',
    String(PDF_PAGE_SENTINEL),
    '--set',
    'pipeline.page_loader.image_format',
    PIPELINE_IMAGE_FORMAT,
    '--set',
    'pipeline.page_loader.max_pixels',
    String(PIPELINE_MAX_PIXELS),
    '--set',
    'pipeline.page_loader.pdf_dpi',
    String(PIPELINE_PDF_DPI),
  ]
}

function validatedRelayEndpoint(endpoint: string): string {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw pipelineUnavailableError()
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !/^\/[a-f0-9]{48}\/api\/generate$/.test(url.pathname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw pipelineUnavailableError()
  }
  return url.toString()
}

function isGlmOcrModel(model: string): boolean {
  return model.trim().split('/').at(-1)?.split(':')[0]?.toLowerCase() === 'glm-ocr'
}

export function pipelinePythonBinary(pipelineBin: string, configured: string | null): string {
  const binary = configured?.trim() || posix.join(posix.dirname(pipelineBin), 'python')
  if (!isAbsolute(binary) && !posix.isAbsolute(binary)) throw pipelineUnavailableError()
  return binary
}

function validatePdfBlob(document: Blob): void {
  if (document.size <= 0) {
    throw new ApiError(422, 'ocr_document_invalid', '请选择有效的 PDF 文件。')
  }
  if (document.size > MAX_PDF_BYTES) {
    throw new ApiError(413, 'payload_too_large', 'PDF 文件不能超过 25 MB。')
  }
}

async function inspectPdfPageCount(
  target: { pythonBin: string },
  inputPath: string,
  cwd: string,
  signal: AbortSignal,
  processRunner: typeof runProcess = runProcess,
): Promise<number> {
  let output: ProcessOutput
  try {
    output = await processRunner({
      command: target.pythonBin,
      args: ['-c', PDF_INSPECT_SCRIPT, inputPath],
      cwd,
      env: isolatedRuntimeEnvironment(),
      signal,
      captureStdout: true,
      maxStdoutBytes: MAX_INSPECT_STDOUT_BYTES,
    })
  } catch (error) {
    if (error instanceof ProcessAbortedError || error instanceof UnconfirmedProcessTreeError) {
      throw error
    }
    throw new ApiError(422, 'ocr_document_invalid', '无法读取这份 PDF，请确认文件未损坏。')
  }

  const pageCount = parsePdfInspection(output.stdout.toString('utf8'))
  if (pageCount > MAX_PDF_PAGES) {
    throw new ApiError(
      422,
      'ocr_document_page_limit',
      `这份 PDF 共 ${pageCount} 页，当前一次最多处理 20 页。请拆分后重试。`,
    )
  }
  return pageCount
}

export function parsePdfInspection(output: string): number {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new ApiError(422, 'ocr_document_invalid', '无法读取这份 PDF，请确认文件未损坏。')
  }
  const record =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  if (record?.needsPassword === true) {
    throw new ApiError(422, 'ocr_document_invalid', '这份 PDF 受密码保护，请解锁后再上传。')
  }
  const pageCount = record?.pageCount
  if (!Number.isInteger(pageCount) || (pageCount as number) < 1) {
    throw new ApiError(422, 'ocr_document_invalid', '这份 PDF 没有可处理的页面。')
  }
  return pageCount as number
}

async function createJobDirectory(parent: string): Promise<string> {
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await cleanupStaleJobs(parent)
  const job = await mkdtemp(join(parent, 'job-'))
  await chmod(job, 0o700)
  await writeFile(join(job, JOB_OWNER_MARKER), `${randomUUID()}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  return job
}

async function cleanupStaleJobs(parent: string): Promise<void> {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => [])
  const cutoff = Date.now() - JOB_STALE_MS
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith('job-')) return
      const job = join(parent, entry.name)
      const marker = join(job, JOB_OWNER_MARKER)
      const markerStat = await lstat(marker).catch(() => null)
      if (!markerStat?.isFile() || markerStat.isSymbolicLink() || markerStat.mtimeMs > cutoff)
        return
      await removeOwnedJobDirectory(parent, job)
    }),
  )
}

async function removeOwnedJobDirectory(parent: string, job: string): Promise<void> {
  const resolvedParent = resolve(parent)
  const resolvedJob = resolve(job)
  if (dirname(resolvedJob) !== resolvedParent) return
  const jobStat = await lstat(resolvedJob).catch(() => null)
  const markerStat = await lstat(join(resolvedJob, JOB_OWNER_MARKER)).catch(() => null)
  if (!jobStat?.isDirectory() || jobStat.isSymbolicLink()) return
  if (!markerStat?.isFile() || markerStat.isSymbolicLink()) return
  await rm(resolvedJob, { recursive: true, force: true })
}

async function writeBlob(document: Blob, destination: string, signal: AbortSignal): Promise<void> {
  const handle = await open(destination, 'wx', 0o600)
  const reader = document.stream().getReader()
  let total = 0
  try {
    while (true) {
      if (signal.aborted) throw new ProcessAbortedError('PDF upload cancelled')
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_PDF_BYTES)
        throw new ApiError(413, 'payload_too_large', 'PDF 文件不能超过 25 MB。')
      let offset = 0
      while (offset < value.byteLength) {
        const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset)
        if (bytesWritten <= 0) throw new Error('PDF upload write made no progress')
        offset += bytesWritten
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    await handle.close()
  }
}

export function isolatedRuntimeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase()
    if (value !== undefined && (RUNTIME_ENV_ALLOWLIST.has(upper) || /^LC_[A-Z0-9_]+$/.test(upper)))
      env[key] = value
  }
  env.NO_PROXY = '*'
  env.no_proxy = '*'
  return env
}

export async function runProcess(options: {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  captureStdout: boolean
  maxStdoutBytes: number
}): Promise<ProcessOutput> {
  if (options.signal.aborted) throw new ProcessAbortedError('process cancelled')
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== 'win32',
    shell: false,
    stdio: ['ignore', options.captureStdout ? 'pipe' : 'ignore', 'pipe'],
  })
  const stdout = new BoundedHead(options.maxStdoutBytes)
  let resolveStdoutOverflow: () => void = () => undefined
  const stdoutOverflow = new Promise<void>((resolveOverflow) => {
    resolveStdoutOverflow = resolveOverflow
  })
  child.stdout?.on('data', (chunk: Buffer | string) => {
    if (stdout.push(Buffer.from(chunk))) resolveStdoutOverflow()
  })
  child.stderr?.resume()

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveClose, rejectClose) => {
      child.once('error', rejectClose)
      child.once('close', (code, signal) => resolveClose({ code, signal }))
    },
  )
  let resolveAbort: () => void = () => undefined
  const aborted = new Promise<void>((resolveSignal) => {
    resolveAbort = resolveSignal
  })
  const abortListener = () => resolveAbort()
  options.signal.addEventListener('abort', abortListener, { once: true })

  try {
    const outcome = await Promise.race([
      closed.then((result) => ({ kind: 'closed' as const, result })),
      aborted.then(() => ({ kind: 'aborted' as const })),
      stdoutOverflow.then(() => ({ kind: 'stdout-overflow' as const })),
    ])
    if (outcome.kind === 'aborted' || outcome.kind === 'stdout-overflow') {
      await terminateProcessTree(child, closed)
      if (outcome.kind === 'stdout-overflow') {
        throw new ProcessExecutionError('process stdout exceeded limit')
      }
      throw new ProcessAbortedError('process cancelled')
    }
    await ensureProcessGroupGone(child, closed)
    if (options.signal.aborted) throw new ProcessAbortedError('process cancelled')
    if (outcome.result.code !== 0) {
      throw new ProcessExecutionError(
        `process exited ${outcome.result.code ?? outcome.result.signal ?? 'unknown'}`,
      )
    }
    if (stdout.truncated) throw new ProcessExecutionError('process stdout exceeded limit')
    return { stdout: stdout.buffer() }
  } finally {
    options.signal.removeEventListener('abort', abortListener)
  }
}

async function terminateProcessTree(
  child: ChildProcess,
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<void> {
  signalProcessTree(child, 'SIGTERM')
  if (
    (await settlesWithin(closed, TERMINATE_GRACE_MS)) &&
    (await waitForProcessGroupGone(child.pid, TERMINATE_GRACE_MS))
  ) {
    return
  }
  signalProcessTree(child, 'SIGKILL')
  const leaderClosed = await settlesWithin(closed, TERMINATE_GRACE_MS)
  const groupGone = await waitForProcessGroupGone(child.pid, TERMINATE_GRACE_MS)
  if (!leaderClosed || !groupGone) {
    throw new UnconfirmedProcessTreeError('process tree did not terminate')
  }
}

async function ensureProcessGroupGone(
  child: ChildProcess,
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<void> {
  if (await waitForProcessGroupGone(child.pid, 100)) return
  await terminateProcessTree(child, closed)
}

async function waitForProcessGroupGone(pid: number | undefined, milliseconds: number) {
  if (process.platform === 'win32' || !pid) return true
  const deadline = Date.now() + milliseconds
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  return true
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : null
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw new UnconfirmedProcessTreeError('process group state could not be confirmed')
  }
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : null
    if (code !== 'ESRCH') {
      throw new UnconfirmedProcessTreeError('process tree could not be signalled')
    }
  }
}

async function settlesWithin<T>(promise: Promise<T>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

class BoundedHead {
  private chunks: Buffer[] = []
  private size = 0
  truncated = false

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): boolean {
    const remaining = Math.max(0, this.limit - this.size)
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining)
      this.chunks.push(retained)
      this.size += retained.length
    }
    if (chunk.length > remaining) this.truncated = true
    return this.truncated
  }

  buffer() {
    return Buffer.concat(this.chunks, this.size)
  }
}

function createDeadlineSignal(parents: Array<AbortSignal | undefined>, milliseconds: number) {
  const controller = new AbortController()
  let expired = false
  const activeParents = parents.filter((parent): parent is AbortSignal => Boolean(parent))
  const parentListeners = new Map<AbortSignal, () => void>()
  const alreadyAborted = activeParents.find((parent) => parent.aborted)
  if (alreadyAborted) {
    controller.abort(alreadyAborted.reason)
  } else {
    for (const parent of activeParents) {
      const listener = () => controller.abort(parent.reason)
      parentListeners.set(parent, listener)
      parent.addEventListener('abort', listener, { once: true })
    }
  }
  const timer = setTimeout(() => {
    expired = true
    controller.abort('deadline')
  }, milliseconds)
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose() {
      clearTimeout(timer)
      for (const [parent, listener] of parentListeners) {
        parent.removeEventListener('abort', listener)
      }
    },
  }
}

function pipelineUnavailableError() {
  return new ApiError(503, 'ocr_pipeline_unavailable', 'PDF 识别组件暂时不可用，请稍后重试。')
}

function cancelledError() {
  return new ApiError(499, 'ocr_cancelled', 'PDF 识别已取消。')
}

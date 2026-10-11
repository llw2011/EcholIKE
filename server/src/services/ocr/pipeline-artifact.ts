import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { ApiError } from '../../errors.js'
import type { DocumentOcrResult } from './document-ocr-service.js'
import type { LocalOcrRelaySnapshot } from './local-ocr-relay.js'

const MAX_PDF_PAGES = 20
const PDF_PAGE_SENTINEL = MAX_PDF_PAGES + 1
const MAX_ARTIFACT_REGIONS = 4_096
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
export const MAX_PIPELINE_TEXT_BYTES = 16 * 1024 * 1024
const MAX_RECOVERY_IMAGES = 40
const MAX_RECOVERY_IMAGES_PER_PAGE = 4
const MAX_RECOVERY_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_RECOVERY_TOTAL_BYTES = 25 * 1024 * 1024
const NESTED_REGION_OVERLAP = 0.9
const SAFE_IMAGE_PATH = /^imgs\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:jpe?g|png|webp)$/i
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

const TEXT_LABELS = new Set([
  'abstract',
  'algorithm',
  'content',
  'doc_title',
  'figure_title',
  'paragraph_title',
  'reference_content',
  'text',
  'vertical_text',
  'vision_footnote',
  'seal',
  'formula_number',
])
const TABLE_LABELS = new Set(['table'])
const FORMULA_LABELS = new Set(['display_formula', 'inline_formula'])
const SKIP_LABELS = new Set(['chart', 'image'])

type BoundingBox = readonly [number, number, number, number]

interface ProjectedRegion {
  orderIndex: number
  bbox: BoundingBox
  label: 'text' | 'table' | 'formula'
  content: string
}

interface PipelinePagePlan {
  projected: ProjectedRegion[]
  selected: PipelineRecoveryCandidate[]
  rawEmpty: boolean
}

export interface PipelineRecoveryCandidate {
  id: string
  pageIndex: number
  regionIndex: number
  orderIndex: number
  imagePath: string
  bbox: BoundingBox
}

export interface PipelineArtifactPlan {
  pageCount: number
  primaryFormalRequests: number
  recovery: PipelineRecoveryCandidate[]
  pages: PipelinePagePlan[]
}

export interface PipelineRecoveryImage {
  candidate: PipelineRecoveryCandidate
  bytes: Buffer
}

export interface PipelineArtifactFiles {
  finalArtifact: string
  rawArtifact: string
}

interface RawRegion {
  index: number
  label: string
  content: string | null
  bbox: BoundingBox
}

interface FinalRegion {
  index: number
  label: 'text' | 'table' | 'formula' | 'image'
  nativeLabel: string
  content: string | null
  bbox: BoundingBox
  imagePath: string | null
}

export function parsePipelinePdfArtifacts(
  finalArtifact: string,
  rawArtifact: string,
  expectedPageCount: number,
): PipelineArtifactPlan {
  const finalPages = parseArtifactPages(finalArtifact, expectedPageCount)
  const rawPages = parseArtifactPages(rawArtifact, expectedPageCount)
  const pages: PipelinePagePlan[] = []
  const recovery: PipelineRecoveryCandidate[] = []
  const seenImagePaths = new Set<string>()
  let primaryFormalRequests = 0
  let totalRegions = 0

  for (let pageIndex = 0; pageIndex < expectedPageCount; pageIndex += 1) {
    const rawPageValue = rawPages[pageIndex]
    const finalPageValue = finalPages[pageIndex]
    if (!Array.isArray(rawPageValue) || !Array.isArray(finalPageValue)) throw invalidArtifact()
    totalRegions += rawPageValue.length + finalPageValue.length
    if (totalRegions > MAX_ARTIFACT_REGIONS) throw invalidArtifact()

    const rawPage = rawPageValue.map((value, index) => parseRawRegion(value, index))
    const finalPage = finalPageValue.map((value, index) => parseFinalRegion(value, index))

    const rawSkipped = new Map<string, RawRegion>()
    const rawEligible = new Map<string, RawRegion>()
    for (const region of rawPage) {
      if (SKIP_LABELS.has(region.label)) {
        if (region.content !== null && region.content !== '') throw invalidArtifact()
        const key = recoveryKey(region.label, region.bbox)
        if (rawSkipped.has(key)) throw invalidArtifact()
        rawSkipped.set(key, region)
        continue
      }
      if (!isOcrEligibleLabel(region.label)) throw invalidArtifact()
      if (typeof region.content !== 'string' || !region.content.trim()) throw invalidArtifact()
      const key = recoveryKey(region.label, region.bbox)
      if (rawEligible.has(key)) throw invalidArtifact()
      rawEligible.set(key, region)
      primaryFormalRequests += 1
    }

    const candidates: PipelineRecoveryCandidate[] = []
    const projected: ProjectedRegion[] = []
    const matchedSkipped = new Set<string>()
    const finalEligible = new Map<string, FinalRegion>()
    let lastRawIndex = -1
    for (const region of finalPage) {
      if (region.label === 'image') {
        if (!SKIP_LABELS.has(region.nativeLabel) || region.content !== null || !region.imagePath) {
          throw invalidArtifact()
        }
        const key = recoveryKey(region.nativeLabel, region.bbox)
        const raw = rawSkipped.get(key)
        if (!raw || matchedSkipped.has(key) || seenImagePaths.has(region.imagePath)) {
          throw invalidArtifact()
        }
        if (raw.index <= lastRawIndex) throw invalidArtifact()
        lastRawIndex = raw.index
        matchedSkipped.add(key)
        seenImagePaths.add(region.imagePath)
        candidates.push({
          id: `page-${pageIndex}-region-${raw.index}`,
          pageIndex,
          regionIndex: raw.index,
          orderIndex: region.index,
          imagePath: region.imagePath,
          bbox: region.bbox,
        })
        continue
      }

      if (!isOcrEligibleLabel(region.nativeLabel)) throw invalidArtifact()
      const key = recoveryKey(region.nativeLabel, region.bbox)
      const raw = rawEligible.get(key)
      if (!raw || finalEligible.has(key) || raw.index <= lastRawIndex) throw invalidArtifact()
      lastRawIndex = raw.index
      const expectedLabel = mappedLabel(region.nativeLabel)
      if (region.label !== expectedLabel || typeof region.content !== 'string') {
        throw invalidArtifact()
      }
      const content = region.content.trim()
      if (!content || UNSAFE_TEXT_CONTROLS.test(content)) throw invalidArtifact()
      finalEligible.set(key, region)
      projected.push({ orderIndex: region.index, bbox: region.bbox, label: region.label, content })
    }
    if (matchedSkipped.size !== rawSkipped.size || finalEligible.size !== rawEligible.size) {
      throw invalidArtifact()
    }

    const selected = selectRecoveryCandidates(candidates)
    if (selected.length > MAX_RECOVERY_IMAGES_PER_PAGE) throw invalidArtifact()
    recovery.push(...selected)
    if (recovery.length > MAX_RECOVERY_IMAGES) throw invalidArtifact()
    pages.push({
      projected,
      selected,
      rawEmpty: rawPage.length === 0,
    })
  }

  return { pageCount: expectedPageCount, primaryFormalRequests, recovery, pages }
}

export function finalizePipelinePdfArtifact(
  plan: PipelineArtifactPlan,
  recoveredText: ReadonlyMap<string, string>,
  evidence: LocalOcrRelaySnapshot,
): Omit<DocumentOcrResult, 'model'> {
  assertRelayEvidence(plan, recoveredText, evidence)
  let textBytes = 0
  for (const page of plan.pages) {
    for (const region of page.projected) {
      textBytes += Buffer.byteLength(region.content, 'utf8')
      if (textBytes > MAX_PIPELINE_TEXT_BYTES) throw invalidArtifact()
    }
  }
  for (const text of recoveredText.values()) {
    if (UNSAFE_TEXT_CONTROLS.test(text)) throw invalidArtifact()
    textBytes += Buffer.byteLength(text, 'utf8')
    if (textBytes > MAX_PIPELINE_TEXT_BYTES) throw invalidArtifact()
  }

  const pages: string[] = []
  const warnings: string[] = []
  for (const [pageIndex, page] of plan.pages.entries()) {
    const entries: Array<{ orderIndex: number; priority: number; content: string }> = []
    const pageRecovery = page.selected.map((candidate) => ({
      candidate,
      content: recoveredText.get(candidate.id)?.trim() ?? '',
    }))
    for (const region of page.projected) {
      const covered =
        region.label === 'text' &&
        pageRecovery.some(
          ({ candidate, content }) =>
            intersectionArea(region.bbox, candidate.bbox) / bboxArea(region.bbox) >=
              NESTED_REGION_OVERLAP && recoveryContainsText(content, region.content),
        )
      if (!covered)
        entries.push({ orderIndex: region.orderIndex, priority: 0, content: region.content })
    }
    for (const { candidate, content } of pageRecovery) {
      entries.push({ orderIndex: candidate.orderIndex, priority: 1, content })
    }
    entries.sort(
      (left, right) => left.orderIndex - right.orderIndex || left.priority - right.priority,
    )
    const body = entries
      .map((entry) => entry.content)
      .filter(Boolean)
      .join('\n\n')
      .trim()

    if (page.selected.length > 0) {
      warnings.push(
        `第 ${pageIndex + 1} 页包含版面模型跳过的图像区域，已进行恢复识别，请核对复杂排版。`,
      )
    }
    if (!body) {
      warnings.push(
        page.rawEmpty
          ? `第 ${pageIndex + 1} 页未检测到可识别内容，可能是空白页。`
          : `第 ${pageIndex + 1} 页未恢复到可用文字，请核对该页内容。`,
      )
      continue
    }
    pages.push(plan.pageCount > 1 ? `## 第 ${pageIndex + 1} 页\n\n${body}` : body)
  }

  const text = pages.join('\n\n').trim()
  if (Buffer.byteLength(text, 'utf8') > MAX_PIPELINE_TEXT_BYTES) throw invalidArtifact()
  if (!text) {
    throw new ApiError(
      422,
      'ocr_document_no_text',
      '这份 PDF 没有识别到可用文字，请确认页面不是空白内容。',
    )
  }
  return {
    text,
    pageCount: plan.pageCount,
    warnings,
    degraded: warnings.length > 0,
  }
}

export function assertPipelinePrimaryRelayEvidence(
  plan: PipelineArtifactPlan,
  evidence: LocalOcrRelaySnapshot,
): void {
  const counters = [
    evidence.warmupAccepted,
    evidence.formalAccepted,
    evidence.formalTerminal,
    evidence.formalNonEmpty,
    evidence.formalEmpty,
    evidence.active,
  ]
  if (
    counters.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    evidence.fatal ||
    evidence.active !== 0 ||
    evidence.formalAccepted !== plan.primaryFormalRequests ||
    evidence.formalTerminal !== plan.primaryFormalRequests ||
    evidence.formalNonEmpty !== plan.primaryFormalRequests ||
    evidence.formalEmpty !== 0
  ) {
    throw invalidArtifact()
  }
}

export async function readPipelineRecoveryImages(
  artifactDirectory: string,
  candidates: readonly PipelineRecoveryCandidate[],
): Promise<PipelineRecoveryImage[]> {
  if (candidates.length > MAX_RECOVERY_IMAGES) throw invalidArtifact()
  const root = resolve(artifactDirectory)
  const imgs = resolve(root, 'imgs')
  await assertRealDirectory(root)
  if (candidates.length > 0) await assertRealDirectory(imgs)

  const images: PipelineRecoveryImage[] = []
  const seenInodes = new Set<string>()
  let total = 0
  for (const candidate of candidates) {
    if (!SAFE_IMAGE_PATH.test(candidate.imagePath)) throw invalidArtifact()
    const path = resolve(root, ...candidate.imagePath.split('/'))
    if (dirname(path) !== imgs) throw invalidArtifact()
    const before = await lstat(path).catch(() => null)
    if (
      !before?.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size <= 0 ||
      before.size > MAX_RECOVERY_IMAGE_BYTES
    ) {
      throw invalidArtifact()
    }
    const handle = await open(
      path,
      fsConstants.O_RDONLY |
        (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0),
    ).catch(() => null)
    if (!handle) throw invalidArtifact()
    try {
      const bound = await handle.stat()
      if (
        !bound.isFile() ||
        bound.nlink !== 1 ||
        bound.size !== before.size ||
        bound.mtimeMs !== before.mtimeMs ||
        bound.ctimeMs !== before.ctimeMs ||
        (before.dev !== 0 && bound.dev !== before.dev) ||
        (before.ino !== 0 && bound.ino !== before.ino)
      ) {
        throw invalidArtifact()
      }
      const inodeKey = `${String(bound.dev)}:${String(bound.ino)}`
      if (bound.ino !== 0 && seenInodes.has(inodeKey)) throw invalidArtifact()
      seenInodes.add(inodeKey)
      const bytes = await handle.readFile()
      const after = await handle.stat()
      if (
        after.size !== bound.size ||
        after.mtimeMs !== bound.mtimeMs ||
        after.ctimeMs !== bound.ctimeMs ||
        bytes.byteLength !== bound.size
      ) {
        throw invalidArtifact()
      }
      if (!matchesImageMagic(bytes, extname(path).toLowerCase())) throw invalidArtifact()
      total += bytes.byteLength
      if (total > MAX_RECOVERY_TOTAL_BYTES) throw invalidArtifact()
      images.push({ candidate, bytes })
    } finally {
      await handle.close()
    }
  }
  return images
}

export async function readPipelineArtifactFiles(
  artifactDirectory: string,
): Promise<PipelineArtifactFiles> {
  const root = resolve(artifactDirectory)
  await assertRealDirectory(root)
  const finalBytes = await readBoundedRegularFile(resolve(root, 'input.json'), MAX_ARTIFACT_BYTES)
  const rawBytes = await readBoundedRegularFile(
    resolve(root, 'input_model.json'),
    MAX_ARTIFACT_BYTES,
  )
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    return {
      finalArtifact: decoder.decode(finalBytes),
      rawArtifact: decoder.decode(rawBytes),
    }
  } catch {
    throw invalidArtifact()
  }
}

function parseArtifactPages(source: string, expectedPageCount: number): unknown[] {
  let value: unknown
  try {
    value = JSON.parse(source) as unknown
  } catch {
    throw invalidArtifact()
  }
  if (
    !Array.isArray(value) ||
    !Number.isInteger(expectedPageCount) ||
    expectedPageCount < 1 ||
    expectedPageCount > MAX_PDF_PAGES ||
    value.length !== expectedPageCount ||
    value.length >= PDF_PAGE_SENTINEL
  ) {
    throw invalidArtifact()
  }
  return value
}

function parseRawRegion(value: unknown, expectedIndex: number): RawRegion {
  const record = recordValue(value)
  const index = integerValue(record.index)
  const label = stringValue(record.label)
  const bbox = bboxValue(record.bbox_2d)
  const content = nullableStringValue(record.content)
  if (index !== expectedIndex || !label) throw invalidArtifact()
  validatePolygon(record.polygon)
  return { index, label, content, bbox }
}

function parseFinalRegion(value: unknown, expectedIndex: number): FinalRegion {
  const record = recordValue(value)
  const index = integerValue(record.index)
  const label = stringValue(record.label)
  const nativeLabel = stringValue(record.native_label)
  const bbox = bboxValue(record.bbox_2d)
  const content = nullableStringValue(record.content)
  validatePolygon(record.polygon)
  if (
    !['text', 'table', 'formula', 'image'].includes(label) ||
    !nativeLabel ||
    index !== expectedIndex
  ) {
    throw invalidArtifact()
  }
  const imagePath = record.image_path === undefined ? null : stringValue(record.image_path)
  if (label === 'image') {
    if (!imagePath || !SAFE_IMAGE_PATH.test(imagePath)) throw invalidArtifact()
  } else if (imagePath !== null) {
    throw invalidArtifact()
  }
  return { index, label: label as FinalRegion['label'], nativeLabel, content, bbox, imagePath }
}

function selectRecoveryCandidates(
  candidates: readonly PipelineRecoveryCandidate[],
): PipelineRecoveryCandidate[] {
  const selected: PipelineRecoveryCandidate[] = []
  for (const candidate of [...candidates].sort(
    (left, right) =>
      bboxArea(right.bbox) - bboxArea(left.bbox) || left.regionIndex - right.regionIndex,
  )) {
    if (
      selected.some(
        (existing) =>
          intersectionArea(candidate.bbox, existing.bbox) /
            Math.min(bboxArea(candidate.bbox), bboxArea(existing.bbox)) >=
          NESTED_REGION_OVERLAP,
      )
    ) {
      continue
    }
    selected.push(candidate)
  }
  return selected.sort((left, right) => left.regionIndex - right.regionIndex)
}

function assertRelayEvidence(
  plan: PipelineArtifactPlan,
  recoveredText: ReadonlyMap<string, string>,
  evidence: LocalOcrRelaySnapshot,
): void {
  const recoveryIds = new Set(plan.recovery.map((candidate) => candidate.id))
  if (
    recoveredText.size !== recoveryIds.size ||
    [...recoveredText].some(([id, text]) => !recoveryIds.has(id) || !text.trim()) ||
    [...recoveryIds].some((id) => !recoveredText.has(id))
  ) {
    throw invalidArtifact()
  }
  const expectedFormal = plan.primaryFormalRequests + plan.recovery.length
  const counters = [
    evidence.warmupAccepted,
    evidence.formalAccepted,
    evidence.formalTerminal,
    evidence.formalNonEmpty,
    evidence.formalEmpty,
    evidence.active,
  ]
  if (
    counters.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    evidence.fatal ||
    evidence.active !== 0 ||
    evidence.formalAccepted !== expectedFormal ||
    evidence.formalTerminal !== expectedFormal ||
    evidence.formalNonEmpty !== expectedFormal ||
    evidence.formalEmpty !== 0
  ) {
    throw invalidArtifact()
  }
}

function isOcrEligibleLabel(label: string): boolean {
  return TEXT_LABELS.has(label) || TABLE_LABELS.has(label) || FORMULA_LABELS.has(label)
}

function mappedLabel(label: string): 'text' | 'table' | 'formula' {
  if (TEXT_LABELS.has(label)) return 'text'
  if (TABLE_LABELS.has(label)) return 'table'
  if (FORMULA_LABELS.has(label)) return 'formula'
  throw invalidArtifact()
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidArtifact()
  return value as Record<string, unknown>
}

function integerValue(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw invalidArtifact()
  return value as number
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw invalidArtifact()
  return value.trim()
}

function nullableStringValue(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw invalidArtifact()
  return value
}

function bboxValue(value: unknown): BoundingBox {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))
  ) {
    throw invalidArtifact()
  }
  const [x1, y1, x2, y2] = value as [number, number, number, number]
  if (x1 < 0 || y1 < 0 || x2 > 1000 || y2 > 1000 || x2 <= x1 || y2 <= y1) {
    throw invalidArtifact()
  }
  return [x1, y1, x2, y2]
}

function validatePolygon(value: unknown): void {
  if (value === undefined || value === null) return
  if (
    !Array.isArray(value) ||
    !value.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 2 &&
        point.every(
          (coordinate) =>
            typeof coordinate === 'number' &&
            Number.isFinite(coordinate) &&
            coordinate >= 0 &&
            coordinate <= 1000,
        ),
    )
  ) {
    throw invalidArtifact()
  }
}

function recoveryKey(label: string, bbox: BoundingBox): string {
  return `${label}:${bbox.join(',')}`
}

function bboxArea([x1, y1, x2, y2]: BoundingBox): number {
  return (x2 - x1) * (y2 - y1)
}

function intersectionArea(left: BoundingBox, right: BoundingBox): number {
  const width = Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0]))
  const height = Math.max(0, Math.min(left[3], right[3]) - Math.max(left[1], right[1]))
  return width * height
}

function recoveryContainsText(recovered: string, projected: string): boolean {
  const needle = normalizedTextKey(projected)
  return needle.length >= 4 && normalizedTextKey(recovered).includes(needle)
}

function normalizedTextKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

async function assertRealDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null)
  if (!info?.isDirectory() || info.isSymbolicLink()) throw invalidArtifact()
  const canonical = await realpath(path).catch(() => null)
  if (!canonical || resolve(canonical) !== resolve(path)) throw invalidArtifact()
}

async function readBoundedRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const before = await lstat(path).catch(() => null)
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size <= 0 ||
    before.size > maxBytes
  ) {
    throw invalidArtifact()
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY |
      (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0),
  ).catch(() => null)
  if (!handle) throw invalidArtifact()
  try {
    const bound = await handle.stat()
    if (
      !bound.isFile() ||
      bound.nlink !== 1 ||
      bound.size !== before.size ||
      bound.mtimeMs !== before.mtimeMs ||
      bound.ctimeMs !== before.ctimeMs ||
      (before.dev !== 0 && bound.dev !== before.dev) ||
      (before.ino !== 0 && bound.ino !== before.ino)
    ) {
      throw invalidArtifact()
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (
      after.size !== bound.size ||
      after.mtimeMs !== bound.mtimeMs ||
      after.ctimeMs !== bound.ctimeMs ||
      bytes.byteLength !== bound.size
    ) {
      throw invalidArtifact()
    }
    return bytes
  } finally {
    await handle.close()
  }
}

function matchesImageMagic(bytes: Buffer, extension: string): boolean {
  if (extension === '.jpg' || extension === '.jpeg') {
    return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (extension === '.png') {
    return (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    )
  }
  if (extension === '.webp') {
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    )
  }
  return false
}

function invalidArtifact(): ApiError {
  return new ApiError(502, 'ocr_failed', 'PDF 识别结果格式异常，请稍后重试。')
}

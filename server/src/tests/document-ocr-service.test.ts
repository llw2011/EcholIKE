import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../errors.js'
import { createOcrProxyService } from '../services/proxy/ocr-proxy.js'
import {
  createDesktopConfigService,
  createMemoryDesktopConfigStore,
} from '../services/desktop/desktop-config-service.js'
import { testEnv } from './helpers.js'
import {
  createDocumentOcrService,
  createLocalOcrExecutionGate,
  finalizePipelinePdfArtifact,
  isolatedRuntimeEnvironment,
  MAX_PIPELINE_TEXT_BYTES,
  parsePdfInspection,
  parsePipelinePdfArtifacts,
  pipelineArguments,
  pipelinePythonBinary,
  readPipelineArtifactFiles,
  readPipelineRecoveryImages,
  runProcess,
  type DocumentOcrFailureDiagnostic,
  UnconfirmedProcessTreeError,
} from '../services/ocr/document-ocr-service.js'
import type { LocalOcrRuntime, LocalOcrTargetSnapshot } from '../services/ocr/local-ocr-runtime.js'
import type { DesktopConfigService } from '../services/desktop/desktop-config-service.js'
import { providerAddressScope } from '../services/security/provider-egress-policy.js'

function fakeLocalOcrRuntime(
  desktopConfig: DesktopConfigService,
  overrides: Partial<LocalOcrRuntime> = {},
): LocalOcrRuntime {
  const snapshot = async (): Promise<LocalOcrTargetSnapshot> => {
    const provider = await desktopConfig.resolveProvider('ocr')
    if (!provider?.endpoint || !provider.defaultModel) throw new Error('missing test OCR provider')
    const url = new URL(provider.endpoint)
    const scope = providerAddressScope(url.hostname)
    return {
      logicalEndpoint: url.toString(),
      model: provider.defaultModel,
      source: 'configured',
      fingerprint: `${url.toString()}|${provider.defaultModel}`,
      validated: {
        url,
        origin: url.origin,
        hostname: url.hostname,
        addresses: [{ address: url.hostname, family: 4, scope }],
        network: 'explicit_local',
      },
    }
  }
  const runtime: LocalOcrRuntime = {
    resolveCurrent: snapshot,
    async resolveConfig() {
      return await snapshot()
    },
    async request() {
      return Response.json({ response: 'ok', done: true, done_reason: 'stop' })
    },
    async probe() {
      return { available: true, reason: 'ok' }
    },
  }
  return { ...runtime, ...overrides }
}

describe('server PDF Pipeline artifact contract', () => {
  it('reconstructs ordered pages and marks only raw-empty pages as degraded', () => {
    const rawArtifact = JSON.stringify([
      [{ index: 0, label: 'text', content: '第一页', bbox_2d: [10, 10, 300, 100] }],
      [],
      [{ index: 0, label: 'text', content: '第三页', bbox_2d: [10, 10, 300, 100] }],
    ])
    const artifact = JSON.stringify([
      [
        {
          index: 0,
          label: 'text',
          native_label: 'text',
          content: '第一页',
          bbox_2d: [10, 10, 300, 100],
        },
      ],
      [],
      [
        {
          index: 0,
          label: 'text',
          native_label: 'text',
          content: '第三页',
          bbox_2d: [10, 10, 300, 100],
        },
      ],
    ])
    const plan = parsePipelinePdfArtifacts(artifact, rawArtifact, 3)

    expect(plan.primaryFormalRequests).toBe(2)
    expect(plan.recovery).toEqual([])
    expect(finalizePipelinePdfArtifact(plan, new Map(), relayEvidence(2))).toEqual({
      text: '## 第 1 页\n\n第一页\n\n## 第 3 页\n\n第三页',
      pageCount: 3,
      warnings: ['第 2 页未检测到可识别内容，可能是空白页。'],
      degraded: true,
    })
  })

  it('recovers one largest visual region for an all-skip stamped page', () => {
    const raw = JSON.stringify([
      [
        {
          index: 0,
          label: 'chart',
          content: null,
          bbox_2d: [5, 0, 995, 988],
          polygon: [
            [5, 0],
            [995, 0],
            [995, 988],
            [5, 988],
          ],
        },
        { index: 1, label: 'chart', content: null, bbox_2d: [223, 6, 990, 601] },
        { index: 2, label: 'image', content: null, bbox_2d: [687, 604, 873, 832] },
      ],
    ])
    const final = JSON.stringify([
      [
        pipelineImage(0, 'chart', [5, 0, 995, 988], 'imgs/cropped_page0_idx0.jpg'),
        pipelineImage(1, 'chart', [223, 6, 990, 601], 'imgs/cropped_page0_idx1.jpg'),
        pipelineImage(2, 'image', [687, 604, 873, 832], 'imgs/cropped_page0_idx2.jpg'),
      ],
    ])

    const plan = parsePipelinePdfArtifacts(final, raw, 1)

    expect(plan.primaryFormalRequests).toBe(0)
    expect(plan.recovery).toEqual([
      expect.objectContaining({
        pageIndex: 0,
        regionIndex: 0,
        imagePath: 'imgs/cropped_page0_idx0.jpg',
      }),
    ])
    expect(
      finalizePipelinePdfArtifact(
        plan,
        recoveryText(plan, ['设置正文\nECHO VERIFIED']),
        relayEvidence(0, 1),
      ),
    ).toMatchObject({
      text: '设置正文\nECHO VERIFIED',
      degraded: true,
      warnings: [expect.stringContaining('第 1 页')],
    })
  })

  it('recovers a dominant chart without duplicating a small title outside it', () => {
    const raw = JSON.stringify([
      [
        {
          index: 0,
          label: 'paragraph_title',
          content: 'OpenTypeless',
          bbox_2d: [18, 26, 130, 55],
        },
        { index: 1, label: 'chart', content: null, bbox_2d: [225, 8, 977, 601] },
      ],
    ])
    const final = JSON.stringify([
      [
        {
          index: 0,
          label: 'text',
          native_label: 'paragraph_title',
          content: '## OpenTypeless',
          bbox_2d: [18, 26, 130, 55],
        },
        pipelineImage(1, 'chart', [225, 8, 977, 601], 'imgs/cropped_page0_idx0.jpg'),
      ],
    ])

    const plan = parsePipelinePdfArtifacts(final, raw, 1)
    expect(plan.primaryFormalRequests).toBe(1)
    expect(plan.recovery).toHaveLength(1)
    expect(
      finalizePipelinePdfArtifact(plan, recoveryText(plan, ['复杂设置正文']), relayEvidence(1, 1))
        .text,
    ).toBe('## OpenTypeless\n\n复杂设置正文')
  })

  it('keeps adjacent visual regions but collapses 90-percent overlaps in stable order', () => {
    const raw = JSON.stringify([
      [
        { index: 0, label: 'chart', content: null, bbox_2d: [0, 0, 500, 500] },
        { index: 1, label: 'image', content: null, bbox_2d: [50, 0, 550, 500] },
        { index: 2, label: 'image', content: null, bbox_2d: [500, 0, 1000, 500] },
      ],
    ])
    const final = JSON.stringify([
      [
        pipelineImage(0, 'chart', [0, 0, 500, 500], 'imgs/a.jpg'),
        pipelineImage(1, 'image', [50, 0, 550, 500], 'imgs/b.jpg'),
        pipelineImage(2, 'image', [500, 0, 1000, 500], 'imgs/c.jpg'),
      ],
    ])

    expect(parsePipelinePdfArtifacts(final, raw, 1).recovery).toEqual([
      expect.objectContaining({ regionIndex: 0, imagePath: 'imgs/a.jpg' }),
      expect.objectContaining({ regionIndex: 2, imagePath: 'imgs/c.jpg' }),
    ])
  })

  it('keeps visual regions below the 90-percent overlap boundary', () => {
    const raw = JSON.stringify([
      [
        { index: 0, label: 'chart', content: null, bbox_2d: [0, 0, 500, 500] },
        { index: 1, label: 'image', content: null, bbox_2d: [55, 0, 555, 500] },
      ],
    ])
    const final = JSON.stringify([
      [
        pipelineImage(0, 'chart', [0, 0, 500, 500], 'imgs/a.jpg'),
        pipelineImage(1, 'image', [55, 0, 555, 500], 'imgs/b.jpg'),
      ],
    ])

    expect(parsePipelinePdfArtifacts(final, raw, 1).recovery).toHaveLength(2)
  })

  it('suppresses text covered by recovery at 90 percent but preserves 89 percent', () => {
    const planAt = recoveryCoveragePlan(90)
    expect(
      finalizePipelinePdfArtifact(
        planAt,
        recoveryText(planAt, ['recovered retained text']),
        relayEvidence(1, 1),
      ).text,
    ).toBe('recovered retained text')

    expect(
      finalizePipelinePdfArtifact(
        planAt,
        recoveryText(planAt, ['different recovered text']),
        relayEvidence(1, 1),
      ).text,
    ).toBe('different recovered text\n\nretained text')

    const planBelow = recoveryCoveragePlan(89)
    expect(
      finalizePipelinePdfArtifact(
        planBelow,
        recoveryText(planBelow, ['recovered retained text']),
        relayEvidence(1, 1),
      ).text,
    ).toBe('recovered retained text\n\nretained text')
  })

  it('never replaces covered table or formula output with generic recovery text', () => {
    const cases = [
      { nativeLabel: 'table', label: 'table', content: '<table><tr><td>A</td></tr></table>' },
      { nativeLabel: 'display_formula', label: 'formula', content: '$$\nx=1\n$$' },
    ] as const

    for (const item of cases) {
      const plan = parsePipelinePdfArtifacts(
        JSON.stringify([
          [
            pipelineImage(0, 'chart', [0, 0, 1000, 1000], 'imgs/page.jpg'),
            {
              index: 1,
              label: item.label,
              native_label: item.nativeLabel,
              content: item.content,
              bbox_2d: [100, 100, 900, 900],
              polygon: null,
            },
          ],
        ]),
        JSON.stringify([
          [
            { index: 0, label: 'chart', content: null, bbox_2d: [0, 0, 1000, 1000] },
            {
              index: 1,
              label: item.nativeLabel,
              content: item.content,
              bbox_2d: [100, 100, 900, 900],
            },
          ],
        ]),
        1,
      )
      expect(
        finalizePipelinePdfArtifact(plan, recoveryText(plan, ['recovered']), relayEvidence(1, 1))
          .text,
      ).toContain(item.content)
    }
  })

  it('recovers a small mixed-page image without suppressing surrounding text', () => {
    const raw = JSON.stringify([
      [
        { index: 0, label: 'text', content: '足量正文', bbox_2d: [0, 0, 900, 500] },
        { index: 1, label: 'image', content: null, bbox_2d: [700, 700, 900, 900] },
      ],
    ])
    const final = JSON.stringify([
      [
        {
          index: 0,
          label: 'text',
          native_label: 'text',
          content: '足量正文',
          bbox_2d: [0, 0, 900, 500],
        },
        pipelineImage(1, 'image', [700, 700, 900, 900], 'imgs/photo.jpg'),
      ],
    ])

    const plan = parsePipelinePdfArtifacts(final, raw, 1)
    expect(plan.recovery).toHaveLength(1)
    expect(
      finalizePipelinePdfArtifact(plan, recoveryText(plan, ['图中标注']), relayEvidence(1, 1)),
    ).toMatchObject({
      text: '足量正文\n\n图中标注',
      degraded: true,
    })
  })

  it('fails closed for malformed pairs, missing formal evidence, failed regions, or all-blank output', () => {
    expect(() => parsePipelinePdfArtifacts('{}', '[[]]', 1)).toThrowError(ApiError)
    const blankPlan = parsePipelinePdfArtifacts('[[]]', '[[]]', 1)
    expect(() => finalizePipelinePdfArtifact(blankPlan, new Map(), relayEvidence(0))).toThrowError(
      expect.objectContaining({ code: 'ocr_document_no_text', status: 422 }),
    )
    expect(() =>
      parsePipelinePdfArtifacts(
        JSON.stringify(Array.from({ length: 21 }, () => [])),
        JSON.stringify(Array.from({ length: 21 }, () => [])),
        21,
      ),
    ).toThrowError(ApiError)
    expect(() =>
      parsePipelinePdfArtifacts(
        '[[{"index":0,"label":"text","native_label":"text","content":"ok","bbox_2d":[0,0,10,10]}]]',
        '[[{"index":0,"label":"text","content":"ok","bbox_2d":[0,0,10,10]}]]',
        2,
      ),
    ).toThrowError(ApiError)
    expect(() =>
      parsePipelinePdfArtifacts(
        '[[]]',
        '[[{"index":0,"label":"text","content":null,"bbox_2d":[0,0,10,10]}]]',
        1,
      ),
    ).toThrowError(expect.objectContaining({ status: 502, code: 'ocr_failed' }))
    expect(() =>
      parsePipelinePdfArtifacts(
        '[[{"index":0,"label":"text","native_label":"text","content":"injected","bbox_2d":[0,0,10,10]}]]',
        '[[]]',
        1,
      ),
    ).toThrowError(expect.objectContaining({ status: 502, code: 'ocr_failed' }))
    expect(() =>
      parsePipelinePdfArtifacts(
        '[[{"index":0,"label":"text","native_label":"text","content":"A","bbox_2d":[0,0,10,10]}]]',
        '[[{"index":0,"label":"text","content":"A","bbox_2d":[0,0,10,10]},{"index":1,"label":"text","content":"B","bbox_2d":[20,0,30,10]}]]',
        1,
      ),
    ).toThrowError(expect.objectContaining({ status: 502, code: 'ocr_failed' }))
    expect(() =>
      parsePipelinePdfArtifacts(
        '[[{"index":0,"label":"text","native_label":"text","content":"B","bbox_2d":[20,0,30,10]},{"index":1,"label":"text","native_label":"text","content":"A","bbox_2d":[0,0,10,10]}]]',
        '[[{"index":0,"label":"text","content":"A","bbox_2d":[0,0,10,10]},{"index":1,"label":"text","content":"B","bbox_2d":[20,0,30,10]}]]',
        1,
      ),
    ).toThrowError(expect.objectContaining({ status: 502, code: 'ocr_failed' }))
    expect(() =>
      parsePipelinePdfArtifacts(
        '[[{"index":0,"label":"text","native_label":"text","content":"A","bbox_2d":[0,0,10,10]},{"index":1,"label":"text","native_label":"text","content":"A again","bbox_2d":[0,0,10,10]}]]',
        '[[{"index":0,"label":"text","content":"A","bbox_2d":[0,0,10,10]}]]',
        1,
      ),
    ).toThrowError(expect.objectContaining({ status: 502, code: 'ocr_failed' }))

    const textPlan = parsePipelinePdfArtifacts(
      '[[{"index":0,"label":"text","native_label":"text","content":"ok","bbox_2d":[0,0,10,10]}]]',
      '[[{"index":0,"label":"text","content":"ok","bbox_2d":[0,0,10,10]}]]',
      1,
    )
    expect(() => finalizePipelinePdfArtifact(textPlan, new Map(), relayEvidence(0))).toThrowError(
      expect.objectContaining({ status: 502, code: 'ocr_failed' }),
    )
  })

  it('fails closed before a recovered document can exceed the aggregate text budget', () => {
    const plan = parsePipelinePdfArtifacts(
      JSON.stringify([[pipelineImage(0, 'image', [0, 0, 1000, 1000], 'imgs/page.jpg')]]),
      '[[{"index":0,"label":"image","content":null,"bbox_2d":[0,0,1000,1000]}]]',
      1,
    )
    const oversized = new Map([
      [plan.recovery[0]?.id ?? '', 'x'.repeat(MAX_PIPELINE_TEXT_BYTES + 1)],
    ])

    expect(() => finalizePipelinePdfArtifact(plan, oversized, relayEvidence(0, 1))).toThrowError(
      expect.objectContaining({ status: 502, code: 'ocr_failed' }),
    )
    expect(() =>
      finalizePipelinePdfArtifact(
        plan,
        new Map([[plan.recovery[0]?.id ?? '', 'unsafe\u0000text']]),
        relayEvidence(0, 1),
      ),
    ).toThrowError(expect.objectContaining({ status: 502, code: 'ocr_failed' }))
  })

  it('reads only bounded, single-link image artifacts with matching magic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'echolike-server-ocr-artifact-test-'))
    const imgs = join(root, 'imgs')
    await mkdir(imgs)
    const plan = parsePipelinePdfArtifacts(
      JSON.stringify([[pipelineImage(0, 'chart', [0, 0, 1000, 1000], 'imgs/page.jpg')]]),
      '[[{"index":0,"label":"chart","content":null,"bbox_2d":[0,0,1000,1000]}]]',
      1,
    )

    try {
      await writeFile(join(imgs, 'page.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]))
      await expect(readPipelineRecoveryImages(root, plan.recovery)).resolves.toEqual([
        {
          candidate: plan.recovery[0],
          bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]),
        },
      ])

      await writeFile(join(imgs, 'page.jpg'), Buffer.from('not-an-image'))
      await expect(readPipelineRecoveryImages(root, plan.recovery)).rejects.toMatchObject({
        status: 502,
        code: 'ocr_failed',
      })

      await rm(join(imgs, 'page.jpg'))
      const external = join(root, 'external.jpg')
      await writeFile(external, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]))
      await link(external, join(imgs, 'page.jpg'))
      await expect(readPipelineRecoveryImages(root, plan.recovery)).rejects.toMatchObject({
        status: 502,
        code: 'ocr_failed',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds both JSON artifacts with no-follow reads and rejects traversal or non-contiguous output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'echolike-server-ocr-json-artifact-test-'))
    const final = JSON.stringify([
      [
        {
          index: 0,
          label: 'text',
          native_label: 'text',
          content: 'ok',
          bbox_2d: [0, 0, 10, 10],
          polygon: null,
        },
      ],
    ])
    const raw = '[[{"index":0,"label":"text","content":"ok","bbox_2d":[0,0,10,10],"polygon":null}]]'

    try {
      await writeFile(join(root, 'input.json'), final)
      await writeFile(join(root, 'input_model.json'), raw)
      await expect(readPipelineArtifactFiles(root)).resolves.toEqual({
        finalArtifact: final,
        rawArtifact: raw,
      })

      await rm(join(root, 'input_model.json'))
      const external = join(root, 'external.json')
      await writeFile(external, raw)
      await link(external, join(root, 'input_model.json'))
      await expect(readPipelineArtifactFiles(root)).rejects.toMatchObject({
        status: 502,
        code: 'ocr_failed',
      })

      expect(() =>
        parsePipelinePdfArtifacts(
          JSON.stringify([[pipelineImage(0, 'image', [0, 0, 10, 10], 'imgs/../outside.jpg')]]),
          '[[{"index":0,"label":"image","content":null,"bbox_2d":[0,0,10,10]}]]',
          1,
        ),
      ).toThrowError(expect.objectContaining({ status: 502, code: 'ocr_failed' }))
      expect(() =>
        parsePipelinePdfArtifacts(final.replace('"index":0', '"index":1'), raw, 1),
      ).toThrowError(expect.objectContaining({ status: 502, code: 'ocr_failed' }))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a symlinked JSON artifact before reading it',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'echolike-server-ocr-json-symlink-test-'))
      const external = join(root, 'external.json')
      try {
        await writeFile(join(root, 'input.json'), '[[]]')
        await writeFile(external, '[[]]')
        await symlink(external, join(root, 'input_model.json'), 'file')
        await expect(readPipelineArtifactFiles(root)).rejects.toMatchObject({
          status: 502,
          code: 'ocr_failed',
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform === 'win32')(
    'rejects symlinked recovery image files and image directories',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'echolike-server-ocr-image-symlink-test-'))
      const realImages = join(root, 'real-images')
      const plan = parsePipelinePdfArtifacts(
        JSON.stringify([[pipelineImage(0, 'image', [0, 0, 10, 10], 'imgs/crop.jpg')]]),
        '[[{"index":0,"label":"image","content":null,"bbox_2d":[0,0,10,10]}]]',
        1,
      )
      try {
        await mkdir(realImages)
        const target = join(realImages, 'crop.jpg')
        await writeFile(target, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]))
        await symlink(realImages, join(root, 'imgs'), 'dir')
        await expect(readPipelineRecoveryImages(root, plan.recovery)).rejects.toMatchObject({
          status: 502,
          code: 'ocr_failed',
        })

        await rm(join(root, 'imgs'))
        await mkdir(join(root, 'imgs'))
        await symlink(target, join(root, 'imgs', 'crop.jpg'), 'file')
        await expect(readPipelineRecoveryImages(root, plan.recovery)).rejects.toMatchObject({
          status: 502,
          code: 'ocr_failed',
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('fails closed instead of truncating an excessive visual recovery plan', () => {
    const rawRegions = Array.from({ length: 5 }, (_, index) => ({
      index,
      label: 'image',
      content: null,
      bbox_2d: [index * 200, 0, (index + 1) * 200, 200],
    }))
    const finalRegions = rawRegions.map((region) =>
      pipelineImage(
        region.index,
        'image',
        region.bbox_2d as [number, number, number, number],
        `imgs/${region.index}.jpg`,
      ),
    )

    expect(() =>
      parsePipelinePdfArtifacts(JSON.stringify([finalRegions]), JSON.stringify([rawRegions]), 1),
    ).toThrowError(expect.objectContaining({ status: 502, code: 'ocr_failed' }))
  })

  it('rejects password-protected PDFs during preflight before quota or GPU work', () => {
    expect(() => parsePdfInspection('{"pageCount":3,"needsPassword":true}')).toThrowError(
      expect.objectContaining({ code: 'ocr_document_invalid', status: 422 }),
    )
    expect(parsePdfInspection('{"pageCount":3,"needsPassword":false}')).toBe(3)
  })

  it('pins the loopback relay, model, JSON-only output, and the 21-page sentinel through official --set flags', () => {
    const relayEndpoint = `http://127.0.0.1:43123/${'a'.repeat(48)}/api/generate`
    const args = pipelineArguments(
      '/tmp/job/input.pdf',
      '/tmp/job/output',
      relayEndpoint,
      'glm-ocr:latest',
    )

    expect(args).toEqual(
      expect.arrayContaining([
        'parse',
        '--json-only',
        '--no-layout-vis',
        '--mode',
        'selfhosted',
        '--layout-device',
        'cpu',
        '--set',
        'pipeline.ocr_api.api_url',
        relayEndpoint,
        '--set',
        'pipeline.ocr_api.api_mode',
        'ollama_generate',
        '--set',
        'pipeline.ocr_api.model',
        'glm-ocr:latest',
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
        '21',
        '--set',
        'pipeline.page_loader.image_format',
        'JPEG',
        '--set',
        'pipeline.page_loader.max_pixels',
        '25000000',
        '--set',
        'pipeline.page_loader.pdf_dpi',
        '200',
      ]),
    )
    expect(args.slice(0, 4)).toEqual(['-m', 'glmocr', 'parse', '/tmp/job/input.pdf'])
    expect(() =>
      pipelineArguments(
        '/tmp/job/input.pdf',
        '/tmp/job/output',
        'http://10.0.0.8:11434/api/generate',
        'glm-ocr:latest',
      ),
    ).toThrowError(expect.objectContaining({ code: 'ocr_pipeline_unavailable' }))
  })

  it('passes only the runtime allowlist and never inherited server credentials', () => {
    const isolated = isolatedRuntimeEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/testuser',
      LANG: 'C.UTF-8',
      LC_CTYPE: 'C.UTF-8',
      XDG_CACHE_HOME: '/var/cache/echo',
      LD_LIBRARY_PATH: '/opt/runtime/lib',
      SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
      HTTP_PROXY: 'http://proxy',
      https_proxy: 'http://proxy',
      ALL_PROXY: 'socks://proxy',
      NO_PROXY: 'old',
      WSLENV: 'secret/u',
      ZHIPU_API_KEY: 'secret',
      PASEO_TOKEN: 'secret',
      VISION_ROUTER_FORCE_PIPELINE: '1',
      GLMOCR_OCR_MODEL: 'wrong',
      OLLAMA_HOST: 'wrong',
      DATABASE_URL: 'postgres://database-secret',
      BETTER_AUTH_SECRET: 'auth-secret',
      STRIPE_SECRET_KEY: 'stripe-secret',
      OPENAI_API_KEY: 'openai-secret',
      ARBITRARY_PROVIDER_API_KEY: 'provider-secret',
    })

    expect(isolated).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/testuser',
      LANG: 'C.UTF-8',
      LC_CTYPE: 'C.UTF-8',
      XDG_CACHE_HOME: '/var/cache/echo',
      LD_LIBRARY_PATH: '/opt/runtime/lib',
      SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
      NO_PROXY: '*',
      no_proxy: '*',
    })
    expect(Object.keys(isolated).sort()).toEqual(
      [
        'HOME',
        'LANG',
        'LC_CTYPE',
        'LD_LIBRARY_PATH',
        'NO_PROXY',
        'PATH',
        'SSL_CERT_FILE',
        'XDG_CACHE_HOME',
        'no_proxy',
      ].sort(),
    )
    expect(JSON.stringify(isolated)).not.toContain('secret')
    expect(isolated.HTTP_PROXY).toBeUndefined()
    expect(isolated.https_proxy).toBeUndefined()
    expect(isolated.OLLAMA_HOST).toBeUndefined()
  })

  it('derives PyMuPDF from the official CLI venv unless explicitly configured', () => {
    expect(pipelinePythonBinary('/opt/app/glmocr/bin/glmocr', null)).toBe(
      '/opt/app/glmocr/bin/python',
    )
    expect(pipelinePythonBinary('/opt/app/glmocr/bin/glmocr', '/srv/app/python3')).toBe(
      '/srv/app/python3',
    )
    expect(() => pipelinePythonBinary('/opt/app/glmocr/bin/glmocr', 'python3')).toThrowError(
      expect.objectContaining({ code: 'ocr_pipeline_unavailable' }),
    )
  })

  it('executes help, inspection, and formal parsing through the configured Python module', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'echolike-server-ocr-python-pin-test-'))
    const jobParent = join(runtimeRoot, 'jobs')
    const pipelineBin = join(runtimeRoot, 'glmocr-entrypoint')
    const pythonBin = join(runtimeRoot, 'python-runtime')
    await writeFile(pipelineBin, 'entrypoint-must-not-run', { mode: 0o700 })
    await writeFile(pythonBin, 'test-runtime-marker', { mode: 0o700 })
    await chmod(pipelineBin, 0o700)
    await chmod(pythonBin, 0o700)

    const env = testEnv({
      GLMOCR_PIPELINE_BIN: pipelineBin,
      GLMOCR_PIPELINE_PYTHON: pythonBin,
    })
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'ocr',
      providerId: 'ollama-ocr-local',
      displayName: 'Local GLM OCR',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:11434/api/generate',
      apiKey: null,
      defaultModel: 'glm-ocr:latest',
      priority: 10,
    })
    const runtime = fakeLocalOcrRuntime(desktopConfig, {
      async request() {
        return Response.json({ response: 'pinned text', done: true, done_reason: 'stop' })
      },
    })
    const processCalls: Array<{ command: string; args: string[] }> = []
    const processRunner = vi.fn(
      async (options: { command: string; args: string[]; signal: AbortSignal }) => {
        processCalls.push({ command: options.command, args: options.args })
        if (isGlmOcrHelp(options.args)) {
          return { stdout: Buffer.from('--json-only\n--set\n') }
        }
        if (options.args[0] === '-c' && options.args.length === 2) {
          return { stdout: Buffer.from('pymupdf-ready\n') }
        }
        if (options.args[0] === '-c' && options.args.length === 3) {
          return { stdout: Buffer.from('{"pageCount":1,"needsPassword":false}') }
        }
        expect(isGlmOcrCommand(options.args)).toBe(true)
        const endpoint = options.args[options.args.indexOf('pipeline.ocr_api.api_url') + 1] ?? ''
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'glm-ocr:latest',
            prompt: 'Text Recognition:',
            images: ['aW1hZ2U='],
            stream: false,
            options: { num_predict: 8192 },
          }),
          signal: options.signal,
        })
        expect(response.status).toBe(200)
        const artifactDirectory = join(
          options.args[options.args.indexOf('--output') + 1] ?? '',
          'input',
        )
        await mkdir(artifactDirectory, { recursive: true })
        await writeFile(
          join(artifactDirectory, 'input_model.json'),
          '[[{"index":0,"label":"text","content":"pinned text","bbox_2d":[0,0,1000,1000],"polygon":null}]]',
        )
        await writeFile(
          join(artifactDirectory, 'input.json'),
          '[[{"index":0,"label":"text","native_label":"text","content":"pinned text","bbox_2d":[0,0,1000,1000],"polygon":null}]]',
        )
        return { stdout: Buffer.alloc(0) }
      },
    )
    const gate = createLocalOcrExecutionGate()
    const service = createDocumentOcrService(env, gate, {
      jobParent,
      processRunner,
      localOcrRuntime: runtime,
    })

    try {
      await expect(
        service.process({
          document: new Blob(['%PDF-1.7\npython-pin']),
          requestId: 'req-python-pin',
          assertAvailable: async () => undefined,
          reserve: async () => undefined,
        }),
      ).resolves.toMatchObject({ text: 'pinned text', pageCount: 1 })
      expect(processCalls).not.toHaveLength(0)
      expect(processCalls.every((call) => call.command === pythonBin)).toBe(true)
      expect(processCalls.some((call) => call.command === pipelineBin)).toBe(false)
      expect(processCalls.some((call) => isGlmOcrHelp(call.args))).toBe(true)
      expect(
        processCalls.some((call) => isGlmOcrCommand(call.args) && !isGlmOcrHelp(call.args)),
      ).toBe(true)
    } finally {
      await service.shutdown()
      await rm(runtimeRoot, { recursive: true, force: true })
    }
  })

  it('reports the current provider model while reusing the short-lived runtime probe', async () => {
    const env = testEnv({
      GLMOCR_PIPELINE_BIN: process.execPath,
      GLMOCR_PIPELINE_PYTHON: process.execPath,
    })
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    const provider = await desktopConfig.upsertProvider({
      kind: 'ocr',
      providerId: 'ollama-ocr-local',
      displayName: 'Local GLM OCR',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://10.0.0.8:11434/api/generate',
      apiKey: null,
      defaultModel: 'glm-ocr:latest',
      priority: 10,
    })
    const processRunner = vi.fn(async (options: { args: string[] }) => ({
      stdout: Buffer.from(
        isGlmOcrCommand(options.args) ? '--json-only\n--set\n' : 'pymupdf-ready\n',
      ),
    }))
    const gate = createLocalOcrExecutionGate()
    const service = createDocumentOcrService(env, gate, {
      processRunner,
      localOcrRuntime: fakeLocalOcrRuntime(desktopConfig),
    })

    try {
      await expect(service.capability()).resolves.toEqual({
        available: true,
        providerAvailable: true,
        model: 'glm-ocr:latest',
        documentContract: 'ocr-document-v1',
      })
      const updated = await desktopConfig.upsertProvider({
        id: provider.id,
        expectedRevision: provider.revision,
        kind: 'ocr',
        providerId: 'ollama-ocr-local',
        displayName: 'Local GLM OCR',
        enabled: true,
        mode: 'proxy',
        endpoint: 'http://10.0.0.8:11434/api/generate',
        apiKey: undefined,
        defaultModel: 'glm-ocr:v2',
        priority: 10,
      })
      await expect(service.capability()).resolves.toEqual({
        available: true,
        providerAvailable: true,
        model: 'glm-ocr:v2',
        documentContract: 'ocr-document-v1',
      })
      await desktopConfig.upsertProvider({
        id: updated.id,
        expectedRevision: updated.revision,
        kind: 'ocr',
        providerId: 'ollama-ocr-local',
        displayName: 'Generic Ollama Vision',
        enabled: true,
        mode: 'proxy',
        endpoint: 'http://10.0.0.8:11434/api/generate',
        apiKey: undefined,
        defaultModel: 'qwen-vl:latest',
        priority: 10,
      })
      await expect(service.capability()).resolves.toEqual({
        available: false,
        providerAvailable: true,
        model: 'qwen-vl:latest',
      })
      expect(processRunner).toHaveBeenCalledTimes(2)
    } finally {
      await gate.close()
    }
  })

  it('converges a late capability probe to the current endpoint and model fingerprint', async () => {
    const env = testEnv({
      GLMOCR_PIPELINE_BIN: process.execPath,
      GLMOCR_PIPELINE_PYTHON: process.execPath,
    })
    const endpointA = new URL('http://172.26.128.1:11434/api/generate')
    const endpointB = new URL('http://172.28.0.1:11434/api/generate')
    const targetA: LocalOcrTargetSnapshot = {
      logicalEndpoint: endpointA.toString(),
      model: 'glm-ocr:a',
      source: 'configured',
      fingerprint: `${endpointA.toString()}|glm-ocr:a|172.26.128.1`,
      validated: {
        url: endpointA,
        origin: endpointA.origin,
        hostname: endpointA.hostname,
        addresses: [{ address: endpointA.hostname, family: 4, scope: 'private' }],
        network: 'explicit_local',
      },
    }
    const targetB: LocalOcrTargetSnapshot = {
      logicalEndpoint: endpointB.toString(),
      model: 'glm-ocr:b',
      source: 'configured',
      fingerprint: `${endpointB.toString()}|glm-ocr:b|172.28.0.1`,
      validated: {
        url: endpointB,
        origin: endpointB.origin,
        hostname: endpointB.hostname,
        addresses: [{ address: endpointB.hostname, family: 4, scope: 'private' }],
        network: 'explicit_local',
      },
    }
    let current = targetA
    let markAProbeStarted: () => void = () => undefined
    let finishAProbe: () => void = () => undefined
    const aProbeStarted = new Promise<void>((resolve) => {
      markAProbeStarted = resolve
    })
    const aProbeHeld = new Promise<void>((resolve) => {
      finishAProbe = resolve
    })
    const probeFingerprints: string[] = []
    const runtime: LocalOcrRuntime = {
      async resolveCurrent() {
        return current
      },
      async resolveConfig() {
        return current
      },
      async request() {
        throw new Error('capability probing must not start inference')
      },
      async probe(target) {
        probeFingerprints.push(target.fingerprint)
        if (target.fingerprint === targetA.fingerprint) {
          markAProbeStarted()
          await aProbeHeld
        }
        return { available: true, reason: 'ok' }
      },
    }
    const processRunner = vi.fn(async (options: { args: string[] }) => ({
      stdout: Buffer.from(
        isGlmOcrCommand(options.args) ? '--json-only\n--set\n' : 'pymupdf-ready\n',
      ),
    }))
    const gate = createLocalOcrExecutionGate()
    const service = createDocumentOcrService(env, gate, {
      processRunner,
      localOcrRuntime: runtime,
    })

    try {
      const first = service.capability()
      const joined = service.capability()
      await aProbeStarted
      current = targetB
      finishAProbe()

      const expected = {
        available: true,
        providerAvailable: true,
        model: 'glm-ocr:b',
        documentContract: 'ocr-document-v1',
      }
      await expect(first).resolves.toEqual(expected)
      await expect(joined).resolves.toEqual(expected)
      expect(probeFingerprints).toEqual([targetA.fingerprint, targetB.fingerprint])
      expect(processRunner).toHaveBeenCalledTimes(2)
    } finally {
      finishAProbe()
      await service.shutdown()
    }
  })

  it('terminates a chatty child as soon as bounded stdout is exceeded', async () => {
    const startedAt = Date.now()

    await expect(
      runProcess({
        command: process.execPath,
        args: ['-e', 'process.stdout.write(Buffer.alloc(8192, 120)); setInterval(() => {}, 60000)'],
        cwd: tmpdir(),
        env: isolatedRuntimeEnvironment(),
        signal: new AbortController().signal,
        captureStdout: true,
        maxStdoutBytes: 1024,
      }),
    ).rejects.toThrow('process stdout exceeded limit')
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('cancels and awaits an in-flight capability probe during shutdown', async () => {
    const env = testEnv({
      GLMOCR_PIPELINE_BIN: process.execPath,
      GLMOCR_PIPELINE_PYTHON: process.execPath,
    })
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'ocr',
      providerId: 'ollama-ocr-local',
      displayName: 'Local GLM OCR',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:11434/api/generate',
      apiKey: null,
      defaultModel: 'glm-ocr:latest',
      priority: 10,
    })
    let markProbeStarted: () => void = () => undefined
    let markProbeCleanupStarted: () => void = () => undefined
    let finishProbeCleanup: () => void = () => undefined
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve
    })
    const probeCleanupStarted = new Promise<void>((resolve) => {
      markProbeCleanupStarted = resolve
    })
    const probeCleanup = new Promise<void>((resolve) => {
      finishProbeCleanup = resolve
    })
    const processRunner = vi.fn(async (options: { signal: AbortSignal }) => {
      markProbeStarted()
      await new Promise<void>((resolveAbort) => {
        if (options.signal.aborted) resolveAbort()
        else options.signal.addEventListener('abort', () => resolveAbort(), { once: true })
      })
      markProbeCleanupStarted()
      await probeCleanup
      throw new Error('probe cancelled')
    })
    const gate = createLocalOcrExecutionGate()
    const service = createDocumentOcrService(env, gate, {
      processRunner,
      localOcrRuntime: fakeLocalOcrRuntime(desktopConfig),
    })
    const warmup = service.warmup()
    await probeStarted

    let shutdownSettled = false
    const shutdown = service.shutdown().then(() => {
      shutdownSettled = true
    })
    await probeCleanupStarted
    expect(shutdownSettled).toBe(false)
    finishProbeCleanup()

    await warmup
    await shutdown
    expect(shutdownSettled).toBe(true)
    await expect(service.capability()).resolves.toEqual({
      available: false,
      providerAvailable: false,
      model: null,
    })
  })

  it('waits for preflight cancellation and job cleanup before shutdown completes', async () => {
    const jobParent = await mkdtemp(join(tmpdir(), 'echolike-server-ocr-shutdown-test-'))
    const env = testEnv({
      GLMOCR_PIPELINE_BIN: process.execPath,
      GLMOCR_PIPELINE_PYTHON: process.execPath,
    })
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'ocr',
      providerId: 'ollama-ocr-local',
      displayName: 'Local GLM OCR',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:11434/api/generate',
      apiKey: null,
      defaultModel: 'glm-ocr:latest',
      priority: 10,
    })
    let markInspectStarted: () => void = () => undefined
    let markRemovalStarted: () => void = () => undefined
    let finishRemoval: () => void = () => undefined
    const inspectStarted = new Promise<void>((resolve) => {
      markInspectStarted = resolve
    })
    const removalStarted = new Promise<void>((resolve) => {
      markRemovalStarted = resolve
    })
    const removal = new Promise<void>((resolve) => {
      finishRemoval = resolve
    })
    const processRunner = vi.fn(async (options: { args: string[]; signal: AbortSignal }) => {
      if (isGlmOcrCommand(options.args)) {
        return {
          stdout: Buffer.from('--json-only\n--set\n'),
        }
      }
      if (options.args.length === 2) {
        return {
          stdout: Buffer.from('pymupdf-ready\n'),
        }
      }
      markInspectStarted()
      await new Promise<void>((resolveAbort) => {
        if (options.signal.aborted) resolveAbort()
        else options.signal.addEventListener('abort', () => resolveAbort(), { once: true })
      })
      throw new Error('inspection cancelled')
    })
    const removeJobDirectory = vi.fn(async () => {
      markRemovalStarted()
      await removal
    })
    const gate = createLocalOcrExecutionGate()
    const service = createDocumentOcrService(env, gate, {
      jobParent,
      processRunner,
      removeJobDirectory,
      localOcrRuntime: fakeLocalOcrRuntime(desktopConfig),
    })
    const reserve = vi.fn(async () => undefined)

    try {
      const request = service.process({
        document: new Blob(['%PDF-1.7\nshutdown-preflight']),
        requestId: 'req-pdf-shutdown-preflight',
        assertAvailable: async () => undefined,
        reserve,
      })
      const requestFailure = expect(request).rejects.toMatchObject({
        code: 'ocr_cancelled',
        status: 499,
      })
      await inspectStarted

      let shutdownSettled = false
      const shutdown = service.shutdown().then(() => {
        shutdownSettled = true
      })
      await removalStarted
      expect(shutdownSettled).toBe(false)
      expect(reserve).not.toHaveBeenCalled()
      finishRemoval()

      await requestFailure
      await shutdown
      expect(shutdownSettled).toBe(true)
      expect(removeJobDirectory).toHaveBeenCalledTimes(1)
    } finally {
      finishRemoval()
      await service.shutdown()
      await rm(jobParent, { recursive: true, force: true })
    }
  })
})

describe('local OCR execution gate', () => {
  it('serializes image-direct and PDF Pipeline operations in one process', async () => {
    const gate = createLocalOcrExecutionGate()
    const order: string[] = []
    let releaseFirst: () => void = () => undefined
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = gate.run(undefined, async () => {
      order.push('first:start')
      await firstHeld
      order.push('first:end')
      return 1
    })
    const second = gate.run(undefined, async () => {
      order.push('second:start')
      order.push('second:end')
      return 2
    })

    await Promise.resolve()
    expect(order).toEqual(['first:start'])
    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
    await gate.close()
  })

  it('refreshes the pinned target inside the gate and exposes only a loopback relay to Pipeline', async () => {
    const jobParent = await mkdtemp(join(tmpdir(), 'echolike-server-ocr-gateway-test-'))
    const env = testEnv({
      GLMOCR_PIPELINE_BIN: process.execPath,
      GLMOCR_PIPELINE_PYTHON: process.execPath,
    })
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'ocr',
      providerId: 'ollama-ocr-local',
      displayName: 'Windows GLM OCR',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://wsl-host.echolike.invalid:11434/api/generate',
      apiKey: null,
      defaultModel: 'glm-ocr:latest',
      priority: 10,
    })
    let address = '172.26.128.1'
    const snapshots: string[] = []
    const upstreamTargets: string[] = []
    const makeSnapshot = (): LocalOcrTargetSnapshot => {
      const url = new URL('http://wsl-host.echolike.invalid:11434/api/generate')
      snapshots.push(address)
      return {
        logicalEndpoint: url.toString(),
        model: 'glm-ocr:latest',
        source: 'wsl-windows-host',
        fingerprint: `${url.toString()}|${address}`,
        validated: {
          url,
          origin: url.origin,
          hostname: url.hostname,
          addresses: [{ address, family: 4, scope: 'private' }],
          network: 'explicit_local',
        },
      }
    }
    const runtime: LocalOcrRuntime = {
      async resolveCurrent() {
        return makeSnapshot()
      },
      async resolveConfig() {
        return makeSnapshot()
      },
      async probe() {
        return { available: true, reason: 'ok' }
      },
      async request(target) {
        upstreamTargets.push(target.validated.addresses[0]?.address ?? 'missing')
        return Response.json({ response: 'relay text', done: true, done_reason: 'stop' })
      },
    }
    let pipelineRelayEndpoint = ''
    const processRunner = vi.fn(
      async (options: { args: string[]; cwd: string; signal: AbortSignal }) => {
        if (isGlmOcrHelp(options.args)) {
          return { stdout: Buffer.from('--json-only\n--set\n') }
        }
        if (options.args[0] === '-c' && options.args.length === 2) {
          return { stdout: Buffer.from('pymupdf-ready\n') }
        }
        if (options.args[0] === '-c' && options.args.length === 3) {
          return { stdout: Buffer.from('{"pageCount":1,"needsPassword":false}') }
        }
        const apiSetting = options.args.indexOf('pipeline.ocr_api.api_url')
        const modelSetting = options.args.indexOf('pipeline.ocr_api.model')
        pipelineRelayEndpoint = options.args[apiSetting + 1] ?? ''
        const response = await fetch(pipelineRelayEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: options.args[modelSetting + 1],
            prompt: 'Text Recognition:',
            images: ['aW1hZ2U='],
            stream: false,
            options: { num_predict: 8192 },
          }),
          signal: options.signal,
        })
        expect(response.status).toBe(200)
        const outputIndex = options.args.indexOf('--output')
        const artifactDirectory = join(options.args[outputIndex + 1] ?? '', 'input')
        await mkdir(artifactDirectory, { recursive: true })
        await writeFile(
          join(artifactDirectory, 'input.json'),
          JSON.stringify([
            [
              {
                index: 0,
                label: 'text',
                native_label: 'text',
                content: 'relay text',
                bbox_2d: [0, 0, 1000, 1000],
                polygon: null,
              },
            ],
          ]),
        )
        await writeFile(
          join(artifactDirectory, 'input_model.json'),
          JSON.stringify([
            [
              {
                index: 0,
                label: 'text',
                content: 'relay text',
                bbox_2d: [0, 0, 1000, 1000],
                polygon: null,
              },
            ],
          ]),
        )
        return { stdout: Buffer.alloc(0) }
      },
    )
    const gate = createLocalOcrExecutionGate()
    let releaseBlocker: () => void = () => undefined
    let markBlocked: () => void = () => undefined
    const blocked = new Promise<void>((resolve) => {
      releaseBlocker = resolve
    })
    const blockerStarted = new Promise<void>((resolve) => {
      markBlocked = resolve
    })
    const blocker = gate.run(undefined, async () => {
      markBlocked()
      await blocked
    })
    await blockerStarted
    const service = createDocumentOcrService(env, gate, {
      jobParent,
      processRunner,
      localOcrRuntime: runtime,
    })
    let markInspected: () => void = () => undefined
    const inspected = new Promise<void>((resolve) => {
      markInspected = resolve
    })
    const reserve = vi.fn(async () => undefined)

    try {
      const result = service.process({
        document: new Blob(['%PDF-1.7\ngateway-change']),
        requestId: 'req-gateway-change',
        assertAvailable: async () => markInspected(),
        reserve,
      })
      await inspected
      address = '172.28.0.1'
      releaseBlocker()
      await blocker

      await expect(result).resolves.toMatchObject({ text: 'relay text', pageCount: 1 })
      expect(snapshots).toEqual(['172.26.128.1', '172.28.0.1'])
      expect(upstreamTargets).toEqual(['172.28.0.1'])
      expect(new URL(pipelineRelayEndpoint)).toMatchObject({
        hostname: '127.0.0.1',
        pathname: expect.stringMatching(/^\/[a-f0-9]{48}\/api\/generate$/),
      })
      expect(pipelineRelayEndpoint).not.toContain('172.28.0.1')
      expect(reserve).toHaveBeenCalledWith(1)
    } finally {
      releaseBlocker()
      await service.shutdown()
      await rm(jobParent, { recursive: true, force: true })
    }
  })

  it('recovers an all-skip stamped artifact once through the same relay and reservation', async () => {
    const jobParent = await mkdtemp(join(tmpdir(), 'echolike-server-ocr-recovery-test-'))
    const env = testEnv({
      GLMOCR_PIPELINE_BIN: process.execPath,
      GLMOCR_PIPELINE_PYTHON: process.execPath,
    })
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'ocr',
      providerId: 'ollama-ocr-local',
      displayName: 'Local GLM OCR',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:11434/api/generate',
      apiKey: null,
      defaultModel: 'glm-ocr:latest',
      priority: 10,
    })
    const upstreamBodies: Array<Record<string, unknown>> = []
    const runtime = fakeLocalOcrRuntime(desktopConfig, {
      async request(_target, init) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        upstreamBodies.push(body)
        return Array.isArray(body.images)
          ? Response.json({
              response: '复杂设置正文\nECHO VERIFIED',
              done: true,
              done_reason: 'stop',
            })
          : Response.json({ response: 'warmup', done: true, done_reason: 'length' })
      },
    })
    const processRunner = vi.fn(
      async (options: { command: string; args: string[]; signal: AbortSignal }) => {
        expect(options.command).toBe(process.execPath)
        if (isGlmOcrHelp(options.args)) {
          return { stdout: Buffer.from('--json-only\n--set\n') }
        }
        if (options.args[0] === '-c' && options.args.length === 2) {
          return { stdout: Buffer.from('pymupdf-ready\n') }
        }
        if (options.args[0] === '-c' && options.args.length === 3) {
          return { stdout: Buffer.from('{"pageCount":1,"needsPassword":false}') }
        }

        const apiSetting = options.args.indexOf('pipeline.ocr_api.api_url')
        const modelSetting = options.args.indexOf('pipeline.ocr_api.model')
        const warmup = await fetch(options.args[apiSetting + 1] ?? '', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: options.args[modelSetting + 1],
            prompt: 'hello',
            stream: false,
            options: { num_predict: 10 },
          }),
          signal: options.signal,
        })
        expect(warmup.status).toBe(200)

        const outputIndex = options.args.indexOf('--output')
        const artifactDirectory = join(options.args[outputIndex + 1] ?? '', 'input')
        const imageDirectory = join(artifactDirectory, 'imgs')
        await mkdir(imageDirectory, { recursive: true })
        const raw = [
          [
            { index: 0, label: 'chart', content: null, bbox_2d: [5, 0, 995, 988] },
            { index: 1, label: 'chart', content: null, bbox_2d: [223, 6, 990, 601] },
            { index: 2, label: 'image', content: null, bbox_2d: [687, 604, 873, 832] },
          ],
        ]
        const final = [
          [
            pipelineImage(0, 'chart', [5, 0, 995, 988], 'imgs/full.jpg'),
            pipelineImage(1, 'chart', [223, 6, 990, 601], 'imgs/body.jpg'),
            pipelineImage(2, 'image', [687, 604, 873, 832], 'imgs/stamp.jpg'),
          ],
        ]
        await writeFile(join(artifactDirectory, 'input_model.json'), JSON.stringify(raw))
        await writeFile(join(artifactDirectory, 'input.json'), JSON.stringify(final))
        await writeFile(
          join(imageDirectory, 'full.jpg'),
          Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]),
        )
        return { stdout: Buffer.alloc(0) }
      },
    )
    const gate = createLocalOcrExecutionGate()
    const service = createDocumentOcrService(env, gate, {
      jobParent,
      processRunner,
      localOcrRuntime: runtime,
    })
    const reserve = vi.fn(async () => undefined)

    try {
      await expect(
        service.process({
          document: new Blob(['%PDF-1.7\nstamped-recovery']),
          requestId: 'req-stamped-recovery',
          assertAvailable: async () => undefined,
          reserve,
        }),
      ).resolves.toMatchObject({
        text: '复杂设置正文\nECHO VERIFIED',
        pageCount: 1,
        degraded: true,
        warnings: [expect.stringContaining('恢复识别')],
      })
      expect(reserve).toHaveBeenCalledTimes(1)
      expect(reserve).toHaveBeenCalledWith(1)
      expect(upstreamBodies).toHaveLength(2)
      expect(upstreamBodies.filter((body) => Array.isArray(body.images))).toHaveLength(1)
      expect(upstreamBodies[1]?.options).toMatchObject({ num_ctx: 16_384 })
    } finally {
      await service.shutdown()
      await rm(jobParent, { recursive: true, force: true })
    }
  })

  it.each(['empty', 'length'] as const)(
    'fails the whole all-skip document when recovery returns %s completion',
    async (completion) => {
      const outcome = await runAllSkipRecoveryCompletionCase(completion)
      expect(outcome.error).toMatchObject({ status: 502, code: 'ocr_failed' })
      expect(outcome.reserveCalls).toBe(1)
      expect(outcome.remainingJobs).toEqual([])
    },
  )

  it('propagates cancellation from all-skip recovery and confirms relay cleanup', async () => {
    const outcome = await runAllSkipRecoveryCompletionCase('abort')
    expect(outcome.error).toMatchObject({ status: 499, code: 'ocr_cancelled' })
    expect(outcome.reserveCalls).toBe(1)
    expect(outcome.upstreamAborted).toBe(true)
    expect(outcome.remainingJobs).toEqual([])
  })

  it('fails the whole document when Pipeline hides an incomplete region behind a valid partial artifact', async () => {
    const jobParent = await mkdtemp(join(tmpdir(), 'echolike-server-ocr-relay-fatal-test-'))
    const env = testEnv({
      GLMOCR_PIPELINE_BIN: process.execPath,
      GLMOCR_PIPELINE_PYTHON: process.execPath,
    })
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'ocr',
      providerId: 'ollama-ocr-local',
      displayName: 'Local GLM OCR',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://127.0.0.1:11434/api/generate',
      apiKey: null,
      defaultModel: 'glm-ocr:latest',
      priority: 10,
    })
    const runtime = fakeLocalOcrRuntime(desktopConfig, {
      async request() {
        return Response.json({
          response: 'truncated region',
          done: true,
          done_reason: 'length',
        })
      },
    })
    const processRunner = vi.fn(async (options: { args: string[]; signal: AbortSignal }) => {
      if (isGlmOcrHelp(options.args)) {
        return { stdout: Buffer.from('--json-only\n--set\n') }
      }
      if (options.args[0] === '-c' && options.args.length === 2) {
        return { stdout: Buffer.from('pymupdf-ready\n') }
      }
      if (options.args[0] === '-c' && options.args.length === 3) {
        return { stdout: Buffer.from('{"pageCount":1,"needsPassword":false}') }
      }

      const apiSetting = options.args.indexOf('pipeline.ocr_api.api_url')
      const modelSetting = options.args.indexOf('pipeline.ocr_api.model')
      const response = await fetch(options.args[apiSetting + 1] ?? '', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: options.args[modelSetting + 1],
          prompt: 'Text Recognition:',
          images: ['aW1hZ2U='],
          stream: false,
          options: { num_predict: 8192 },
        }),
        signal: options.signal,
      })
      expect(response.status).toBe(422)

      // The real Pipeline drops the failed region and may still exit 0 with other text.
      const outputIndex = options.args.indexOf('--output')
      const artifactDirectory = join(options.args[outputIndex + 1] ?? '', 'input')
      await mkdir(artifactDirectory, { recursive: true })
      await writeFile(
        join(artifactDirectory, 'input.json'),
        JSON.stringify([
          [
            {
              index: 0,
              label: 'text',
              native_label: 'text',
              content: 'other apparently valid region',
              bbox_2d: [0, 0, 1000, 1000],
              polygon: null,
            },
          ],
        ]),
      )
      await writeFile(
        join(artifactDirectory, 'input_model.json'),
        JSON.stringify([
          [
            {
              index: 0,
              label: 'text',
              content: 'other apparently valid region',
              bbox_2d: [0, 0, 1000, 1000],
              polygon: null,
            },
          ],
        ]),
      )
      return { stdout: Buffer.alloc(0) }
    })
    const gate = createLocalOcrExecutionGate()
    const service = createDocumentOcrService(env, gate, {
      jobParent,
      processRunner,
      localOcrRuntime: runtime,
    })
    const reserve = vi.fn(async () => undefined)

    try {
      await expect(
        service.process({
          document: new Blob(['%PDF-1.7\npartial-artifact']),
          requestId: 'req-relay-fatal',
          assertAvailable: async () => undefined,
          reserve,
        }),
      ).rejects.toMatchObject({ status: 502, code: 'ocr_failed' })
      expect(reserve).toHaveBeenCalledWith(1)
    } finally {
      await service.shutdown()
      await rm(jobParent, { recursive: true, force: true })
    }
  })

  it('rejects queued work on cancellation without unlocking the active operation', async () => {
    const gate = createLocalOcrExecutionGate()
    let releaseFirst: () => void = () => undefined
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = gate.run(undefined, async () => firstHeld)
    const controller = new AbortController()
    const queued = gate.run(controller.signal, async () => 'should not run')

    controller.abort()
    await expect(queued).rejects.toMatchObject({ code: 'ocr_cancelled' })
    releaseFirst()
    await first
    await gate.close()
  })

  it('keeps the gate occupied until active cancellation cleanup acknowledges completion', async () => {
    const gate = createLocalOcrExecutionGate()
    const controller = new AbortController()
    const order: string[] = []
    let acknowledgeCleanup: () => void = () => undefined
    const cleanup = new Promise<void>((resolve) => {
      acknowledgeCleanup = resolve
    })
    const active = gate.run(controller.signal, async (signal) => {
      order.push('active:start')
      await new Promise<void>((resolveAbort) =>
        signal.addEventListener('abort', () => resolveAbort(), { once: true }),
      )
      order.push('active:aborting')
      await cleanup
      order.push('active:clean')
      throw new ApiError(499, 'ocr_cancelled', 'cancelled')
    })
    const next = gate.run(undefined, async () => {
      order.push('next:start')
      return 'next'
    })

    await Promise.resolve()
    controller.abort()
    await Promise.resolve()
    expect(order).toEqual(['active:start', 'active:aborting'])
    acknowledgeCleanup()
    await expect(active).rejects.toMatchObject({ code: 'ocr_cancelled' })
    await expect(next).resolves.toBe('next')
    expect(order).toEqual(['active:start', 'active:aborting', 'active:clean', 'next:start'])
    await gate.close()
  })

  it('poisons the shared gate and preserves the job when process-tree exit is unconfirmed', async () => {
    const jobParent = await mkdtemp(join(tmpdir(), 'echolike-server-ocr-test-'))
    const env = testEnv({
      GLMOCR_PIPELINE_BIN: process.execPath,
      GLMOCR_PIPELINE_PYTHON: process.execPath,
    })
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'ocr',
      providerId: 'ollama-ocr-local',
      displayName: 'Local GLM OCR',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://10.0.0.8:11434/api/generate',
      apiKey: null,
      defaultModel: 'glm-ocr:latest',
      priority: 10,
    })

    const gate = createLocalOcrExecutionGate()
    const diagnostics: DocumentOcrFailureDiagnostic[] = []
    let releasePipeline: () => void = () => undefined
    let markPipelineStarted: () => void = () => undefined
    const pipelineHeld = new Promise<void>((resolve) => {
      releasePipeline = resolve
    })
    const pipelineStarted = new Promise<void>((resolve) => {
      markPipelineStarted = resolve
    })
    const processRunner = vi.fn(async (options: { args: string[] }) => {
      if (isGlmOcrHelp(options.args)) {
        return {
          stdout: Buffer.from('--json-only\n--set\n'),
        }
      }
      if (options.args[0] === '-c' && options.args.length === 2) {
        return {
          stdout: Buffer.from('pymupdf-ready\n'),
        }
      }
      if (options.args[0] === '-c' && options.args.length === 3) {
        return {
          stdout: Buffer.from('{"pageCount":1,"needsPassword":false}'),
        }
      }
      markPipelineStarted()
      await pipelineHeld
      throw new UnconfirmedProcessTreeError('injected unconfirmed process group')
    })
    const service = createDocumentOcrService(env, gate, {
      jobParent,
      processRunner,
      diagnosticSink: (diagnostic) => diagnostics.push(diagnostic),
      localOcrRuntime: fakeLocalOcrRuntime(desktopConfig),
    })
    const assertAvailable = vi.fn(async () => undefined)
    const reserve = vi.fn(async () => undefined)

    try {
      const request = service.process({
        document: new Blob(['%PDF-1.7\nprivate-pdf-body']),
        requestId: 'req-pdf-tree-fatal',
        assertAvailable,
        reserve,
      })
      await pipelineStarted

      let queuedStarted = false
      const queued = gate.run(undefined, async () => {
        queuedStarted = true
        return 'must-not-run'
      })
      const queuedRejection = expect(queued).rejects.toMatchObject({
        code: 'ocr_pipeline_unavailable',
      })
      releasePipeline()

      await expect(request).rejects.toMatchObject({
        code: 'ocr_pipeline_unavailable',
        status: 503,
      })
      await queuedRejection
      await expect(gate.run(undefined, async () => 'must-not-run')).rejects.toMatchObject({
        code: 'ocr_pipeline_unavailable',
      })
      expect(queuedStarted).toBe(false)
      expect(assertAvailable).toHaveBeenCalledWith(1)
      expect(reserve).toHaveBeenCalledWith(1)

      const processCallsAfterPoison = processRunner.mock.calls.length
      const dateNow = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
      try {
        await expect(service.capability()).resolves.toEqual({
          available: false,
          providerAvailable: false,
          model: null,
        })
        await service.warmup()
        await expect(service.capability()).resolves.toEqual({
          available: false,
          providerAvailable: false,
          model: null,
        })
      } finally {
        dateNow.mockRestore()
      }
      expect(processRunner).toHaveBeenCalledTimes(processCallsAfterPoison)

      const retainedJobs = (await readdir(jobParent)).filter((entry) => entry.startsWith('job-'))
      expect(retainedJobs).toHaveLength(1)
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toEqual({
        event: 'ocr_document_failure',
        requestId: 'req-pdf-tree-fatal',
        stage: 'pipeline',
        elapsedMs: expect.any(Number),
        code: 'ocr_pipeline_unavailable',
        pageCount: 1,
        model: 'glm-ocr:latest',
        endpointHost: '10.0.0.8:11434',
      })
      expect(Object.keys(diagnostics[0] ?? {}).sort()).toEqual(
        [
          'event',
          'requestId',
          'stage',
          'elapsedMs',
          'code',
          'pageCount',
          'model',
          'endpointHost',
        ].sort(),
      )
      const serializedDiagnostic = JSON.stringify(diagnostics)
      expect(serializedDiagnostic).not.toContain('private-pdf-body')
      expect(serializedDiagnostic).not.toContain(jobParent)
      expect(serializedDiagnostic).not.toContain('/api/generate')
    } finally {
      await gate.close()
      await rm(jobParent, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'waits for the real POSIX process group to exit before releasing the gate',
    async () => {
      const runtimeRoot = await mkdtemp(join(tmpdir(), 'echolike-server-ocr-posix-test-'))
      const jobParent = join(runtimeRoot, 'jobs')
      const pipelineBin = join(runtimeRoot, 'glmocr-mock')
      const pythonBin = join(runtimeRoot, 'python-mock')
      await writeFile(
        pipelineBin,
        `#!/bin/sh
exit 97
`,
        { mode: 0o700 },
      )
      await writeFile(
        pythonBin,
        `#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "glmocr" ] && [ "$3" = "parse" ] && [ "$4" = "--help" ]; then
  printf '%s\\n' '--json-only --set'
  exit 0
fi
if [ "$#" -eq 2 ]; then
  printf '%s\\n' 'pymupdf-ready'
  exit 0
fi
if [ "$#" -eq 3 ]; then
  printf '%s\\n' '{"pageCount":1,"needsPassword":false}'
  exit 0
fi
printf '%s\\n' "$$" > "$PWD/pipeline.pid"
trap '' TERM
while :; do sleep 300 || true; done
`,
        { mode: 0o700 },
      )
      await chmod(pipelineBin, 0o700)
      await chmod(pythonBin, 0o700)

      const env = testEnv({
        GLMOCR_PIPELINE_BIN: pipelineBin,
        GLMOCR_PIPELINE_PYTHON: pythonBin,
      })
      const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
      await desktopConfig.upsertProvider({
        kind: 'ocr',
        providerId: 'ollama-ocr-local',
        displayName: 'Local GLM OCR',
        enabled: true,
        mode: 'proxy',
        endpoint: 'http://127.0.0.1:11434/api/generate',
        apiKey: null,
        defaultModel: 'glm-ocr:latest',
        priority: 10,
      })
      const gate = createLocalOcrExecutionGate()
      const service = createDocumentOcrService(env, gate, {
        jobParent,
        localOcrRuntime: fakeLocalOcrRuntime(desktopConfig),
      })
      const controller = new AbortController()
      let processGroupId: number | null = null

      try {
        const request = service.process({
          document: new Blob(['%PDF-1.7\nposix-cancel-test']),
          requestId: 'req-pdf-posix-cancel',
          signal: controller.signal,
          assertAvailable: async () => undefined,
          reserve: async () => undefined,
        })
        processGroupId = await waitForPipelineProcessGroup(jobParent)

        let queuedStarted = false
        const queued = gate.run(undefined, async () => {
          queuedStarted = true
          return 'next'
        })
        controller.abort()
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
        expect(queuedStarted).toBe(false)

        await expect(request).rejects.toMatchObject({ code: 'ocr_cancelled', status: 499 })
        await expect(queued).resolves.toBe('next')
        expect(queuedStarted).toBe(true)
        expect(processGroupExistsForTest(processGroupId)).toBe(false)
        expect((await readdir(jobParent)).filter((entry) => entry.startsWith('job-'))).toEqual([])
      } finally {
        if (processGroupId !== null && processGroupExistsForTest(processGroupId)) {
          try {
            process.kill(-processGroupId, 'SIGKILL')
          } catch {
            // The test-owned process group may have exited between the probe and cleanup signal.
          }
        }
        await gate.close()
        await rm(runtimeRoot, { recursive: true, force: true })
      }
    },
    20_000,
  )

  it('places local Ollama image-direct work behind the same gate used by PDF Pipeline', async () => {
    const env = testEnv()
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertProvider({
      kind: 'ocr',
      providerId: 'ollama-ocr-local',
      displayName: 'Local GLM OCR',
      enabled: true,
      mode: 'proxy',
      endpoint: 'http://10.0.0.8:11434/api/generate',
      apiKey: null,
      defaultModel: 'glm-ocr:latest',
      priority: 10,
    })
    const gate = createLocalOcrExecutionGate()
    let releasePipeline: () => void = () => undefined
    let markPipelineStarted: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      releasePipeline = resolve
    })
    const started = new Promise<void>((resolve) => {
      markPipelineStarted = resolve
    })
    const pipeline = gate.run(undefined, async () => {
      markPipelineStarted()
      await held
      return 'pipeline'
    })
    await started
    let fetchCalls = 0
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1
      return Response.json({ response: 'image text', done: true, done_reason: 'stop' })
    }
    const imageOcr = createOcrProxyService(env, fetchImpl, desktopConfig, () => undefined, gate)
    const image = imageOcr.read({ imageBase64: 'aW1hZ2U=', imageMimeType: 'image/png' })

    await Promise.resolve()
    expect(fetchCalls).toBe(0)
    releasePipeline()
    await expect(pipeline).resolves.toBe('pipeline')
    await expect(image).resolves.toMatchObject({ text: 'image text', route: 'direct' })
    expect(fetchCalls).toBe(1)
    await gate.close()
  })
})

async function runAllSkipRecoveryCompletionCase(completion: 'empty' | 'length' | 'abort'): Promise<{
  error: unknown
  reserveCalls: number
  upstreamAborted: boolean
  remainingJobs: string[]
}> {
  const jobParent = await mkdtemp(join(tmpdir(), 'echolike-server-ocr-recovery-failure-test-'))
  const env = testEnv({
    GLMOCR_PIPELINE_BIN: process.execPath,
    GLMOCR_PIPELINE_PYTHON: process.execPath,
  })
  const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
  await desktopConfig.upsertProvider({
    kind: 'ocr',
    providerId: 'ollama-ocr-local',
    displayName: 'Local GLM OCR',
    enabled: true,
    mode: 'proxy',
    endpoint: 'http://127.0.0.1:11434/api/generate',
    apiKey: null,
    defaultModel: 'glm-ocr:latest',
    priority: 10,
  })
  const controller = new AbortController()
  const upstreamSignals: AbortSignal[] = []
  const runtime = fakeLocalOcrRuntime(desktopConfig, {
    async request(_target, init) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      if (!Array.isArray(body.images)) {
        return Response.json({ response: 'warmup', done: true, done_reason: 'length' })
      }
      if (completion === 'empty') {
        return Response.json({ response: ' ', done: true, done_reason: 'stop' })
      }
      if (completion === 'length') {
        return Response.json({ response: 'truncated', done: true, done_reason: 'length' })
      }
      upstreamSignals.push(init.signal as AbortSignal)
      queueMicrotask(() => controller.abort('cancel-recovery'))
      await new Promise<never>((_resolve, reject) => {
        const signal = init.signal as AbortSignal
        const rejectAbort = () => reject(new Error('recovery aborted'))
        if (signal.aborted) rejectAbort()
        else signal.addEventListener('abort', rejectAbort, { once: true })
      })
      throw new Error('unreachable recovery completion')
    },
  })
  const processRunner = vi.fn(async (options: { args: string[]; signal: AbortSignal }) => {
    if (isGlmOcrHelp(options.args)) return { stdout: Buffer.from('--json-only\n--set\n') }
    if (options.args[0] === '-c' && options.args.length === 2) {
      return { stdout: Buffer.from('pymupdf-ready\n') }
    }
    if (options.args[0] === '-c' && options.args.length === 3) {
      return { stdout: Buffer.from('{"pageCount":1,"needsPassword":false}') }
    }
    const endpoint = options.args[options.args.indexOf('pipeline.ocr_api.api_url') + 1] ?? ''
    const warmup = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'glm-ocr:latest',
        prompt: 'hello',
        stream: false,
        options: { num_predict: 10 },
      }),
      signal: options.signal,
    })
    expect(warmup.status).toBe(200)
    const artifactDirectory = join(
      options.args[options.args.indexOf('--output') + 1] ?? '',
      'input',
    )
    const imageDirectory = join(artifactDirectory, 'imgs')
    await mkdir(imageDirectory, { recursive: true })
    await writeFile(
      join(artifactDirectory, 'input_model.json'),
      '[[{"index":0,"label":"chart","content":null,"bbox_2d":[0,0,1000,1000],"polygon":null}]]',
    )
    await writeFile(
      join(artifactDirectory, 'input.json'),
      JSON.stringify([[pipelineImage(0, 'chart', [0, 0, 1000, 1000], 'imgs/page.jpg')]]),
    )
    await writeFile(
      join(imageDirectory, 'page.jpg'),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]),
    )
    return { stdout: Buffer.alloc(0) }
  })
  const gate = createLocalOcrExecutionGate()
  const service = createDocumentOcrService(env, gate, {
    jobParent,
    processRunner,
    localOcrRuntime: runtime,
  })
  const reserve = vi.fn(async () => undefined)
  let error: unknown
  try {
    await service.process({
      document: new Blob(['%PDF-1.7\nrecovery-failure']),
      requestId: `req-recovery-${completion}`,
      signal: controller.signal,
      assertAvailable: async () => undefined,
      reserve,
    })
  } catch (caught) {
    error = caught
  } finally {
    await service.shutdown()
  }
  const remainingJobs = (await readdir(jobParent)).filter((entry) => entry.startsWith('job-'))
  const upstreamAborted = upstreamSignals.some((signal) => signal.aborted)
  await rm(jobParent, { recursive: true, force: true })
  return { error, reserveCalls: reserve.mock.calls.length, upstreamAborted, remainingJobs }
}

async function waitForPipelineProcessGroup(jobParent: string): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const jobs = await readdir(jobParent).catch(() => [])
    for (const job of jobs) {
      const value = await readFile(join(jobParent, job, 'pipeline.pid'), 'utf8').catch(() => '')
      const pid = Number(value.trim())
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  throw new Error('Timed out waiting for the POSIX Pipeline mock to start')
}

function processGroupExistsForTest(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function pipelineImage(
  index: number,
  nativeLabel: 'chart' | 'image',
  bbox: [number, number, number, number],
  imagePath: string,
) {
  return {
    index,
    label: 'image',
    native_label: nativeLabel,
    content: null,
    bbox_2d: bbox,
    polygon: [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[1]],
      [bbox[2], bbox[3]],
      [bbox[0], bbox[3]],
    ],
    image_path: imagePath,
  }
}

function recoveryText(plan: ReturnType<typeof parsePipelinePdfArtifacts>, text: readonly string[]) {
  return new Map(plan.recovery.map((candidate, index) => [candidate.id, text[index] ?? '']))
}

function relayEvidence(primary: number, recoveredNonEmpty = 0) {
  const total = primary + recoveredNonEmpty
  return {
    warmupAccepted: 1,
    formalAccepted: total,
    formalTerminal: total,
    formalNonEmpty: total,
    formalEmpty: 0,
    fatal: false,
    active: 0,
  }
}

function recoveryCoveragePlan(coveredWidth: 89 | 90) {
  return parsePipelinePdfArtifacts(
    JSON.stringify([
      [
        pipelineImage(0, 'chart', [0, 0, coveredWidth, 100], 'imgs/recovery.jpg'),
        {
          index: 1,
          label: 'text',
          native_label: 'text',
          content: 'retained text',
          bbox_2d: [0, 0, 100, 100],
          polygon: null,
        },
      ],
    ]),
    JSON.stringify([
      [
        { index: 0, label: 'chart', content: null, bbox_2d: [0, 0, coveredWidth, 100] },
        {
          index: 1,
          label: 'text',
          content: 'retained text',
          bbox_2d: [0, 0, 100, 100],
        },
      ],
    ]),
    1,
  )
}

function isGlmOcrCommand(args: readonly string[]): boolean {
  return args[0] === '-m' && args[1] === 'glmocr' && args[2] === 'parse'
}

function isGlmOcrHelp(args: readonly string[]): boolean {
  return isGlmOcrCommand(args) && args[3] === '--help'
}

import { ApiError, json } from '../../errors.js'
import type { Handler } from '../../http.js'
import type {
  AdminSceneDictionaryTerm,
  AdminScenePackInput,
} from '../../services/admin/admin-service.js'
import { requireControlRole, throwAdminMutationError } from './control.js'
import { booleanField, optionalStringField, readJsonObject, stringField } from './http-fields.js'

export const adminScenePacks: Handler = async (ctx) =>
  json({
    generatedAt: new Date().toISOString(),
    scenes: await ctx.services.admin.listScenePacks(),
  })

export const adminUpsertScenePack: Handler = async (ctx) => {
  const actor = requireControlRole(ctx, ['owner', 'admin', 'operator'])
  const body = await readJsonObject(ctx.request)
  const input = scenePackInput(body)
  let scene
  try {
    scene = await ctx.services.admin.upsertScenePack({
      ...input,
      control: { actorUserId: actor.userId, requestId: ctx.requestId },
    })
  } catch (error) {
    throwAdminMutationError(error)
  }

  return json({ ok: true, scene })
}

function scenePackInput(body: Record<string, unknown>): AdminScenePackInput {
  const id = optionalStringField(body, 'id', 64) ?? undefined
  const slug = stringField(body, 'slug', 80)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new ApiError(422, 'validation_failed', 'slug must be lowercase kebab-case')
  }

  return {
    ...(id ? { id } : {}),
    slug,
    name: stringField(body, 'name', 120),
    description: stringField(body, 'description', 600),
    category: stringField(body, 'category', 80),
    promptTemplate: stringField(body, 'promptTemplate', 4000),
    dictionaryTerms: dictionaryTermsField(body),
    isPro: booleanField(body, 'isPro'),
    enabled: booleanField(body, 'enabled'),
  }
}

function dictionaryTermsField(body: Record<string, unknown>): AdminSceneDictionaryTerm[] {
  const value = body.dictionaryTerms
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100) {
    throw new ApiError(
      422,
      'validation_failed',
      'dictionaryTerms must be an array of at most 100 items',
    )
  }

  return value.map((term, index) => {
    if (!term || typeof term !== 'object' || Array.isArray(term)) {
      throw new ApiError(422, 'validation_failed', `dictionaryTerms[${index}] is invalid`)
    }
    const row = term as Record<string, unknown>
    const word = stringField(row, 'word', 120)
    const pronunciation = optionalStringField(row, 'pronunciation', 120)
    return {
      word,
      ...(pronunciation ? { pronunciation } : {}),
    }
  })
}

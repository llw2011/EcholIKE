import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import type { ScenePack, SceneStore } from '../../services/scenes/scene-service.js'
import { defaultScenePackInputs } from '../../services/scenes/default-scenes.js'
import * as schema from '../schema.js'

export function createPostgresSceneStore(client: postgres.Sql): SceneStore {
  const db = drizzle(client, { schema })
  const ensureDefaultScenes = createDefaultSceneSeeder(client)

  return {
    async listEnabled() {
      await ensureDefaultScenes()
      const [packs, terms] = await Promise.all([
        db
          .select({
            id: schema.scenePacks.id,
            slug: schema.scenePacks.slug,
            name: schema.scenePacks.name,
            description: schema.scenePacks.description,
            category: schema.scenePacks.category,
            promptTemplate: schema.scenePacks.promptTemplate,
            isPro: schema.scenePacks.isPro,
          })
          .from(schema.scenePacks)
          .where(eq(schema.scenePacks.enabled, true))
          .orderBy(schema.scenePacks.category, schema.scenePacks.name),
        db
          .select({
            scenePackId: schema.sceneDictionaryTerms.scenePackId,
            word: schema.sceneDictionaryTerms.word,
            pronunciation: schema.sceneDictionaryTerms.pronunciation,
          })
          .from(schema.sceneDictionaryTerms),
      ])

      const termsByPack = new Map<string, ScenePack['dictionaryTerms']>()
      for (const term of terms) {
        const values = termsByPack.get(term.scenePackId) ?? []
        values.push({
          word: term.word,
          ...(term.pronunciation ? { pronunciation: term.pronunciation } : {}),
        })
        termsByPack.set(term.scenePackId, values)
      }

      return packs.map((pack) => ({
        id: pack.id,
        slug: pack.slug,
        name: pack.name,
        description: pack.description,
        category: pack.category,
        promptTemplate: pack.promptTemplate,
        dictionaryTerms: termsByPack.get(pack.id) ?? [],
        isPro: pack.isPro,
      }))
    },
  }
}

export function createDefaultSceneSeeder(client: postgres.Sql): () => Promise<void> {
  let seeded = false
  return async () => {
    if (seeded) return
    await seedDefaultScenePacks(client)
    seeded = true
  }
}

async function seedDefaultScenePacks(client: postgres.Sql): Promise<void> {
  await client.begin(async (transaction) => {
    for (const scene of defaultScenePackInputs) {
      const rows = await transaction<{ id: string }[]>`
        insert into scene_pack (
          slug,
          name,
          description,
          category,
          prompt_template,
          is_pro,
          enabled
        )
        values (
          ${scene.slug},
          ${scene.name},
          ${scene.description},
          ${scene.category},
          ${scene.promptTemplate},
          ${scene.isPro},
          ${scene.enabled}
        )
        on conflict (slug) do nothing
        returning id
      `
      const sceneId = rows[0]?.id
      if (!sceneId) continue

      for (const term of scene.dictionaryTerms) {
        await transaction`
          insert into scene_dictionary_term (scene_pack_id, word, pronunciation)
          values (${sceneId}, ${term.word}, ${term.pronunciation ?? null})
          on conflict (scene_pack_id, word) do nothing
        `
      }
    }
  })
}

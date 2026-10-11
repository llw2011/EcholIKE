import type { Plan } from '../../types.js'
import { defaultScenePackInputs } from './default-scenes.js'

export interface ScenePack {
  id: string
  slug: string
  name: string
  description: string
  category: string
  promptTemplate: string
  dictionaryTerms: Array<{ word: string; pronunciation?: string }>
  isPro: boolean
}

export function visibleScenesForPlan(scenes: ScenePack[], plan: Plan): ScenePack[] {
  return scenes.filter((scene) => plan === 'pro' || !scene.isPro)
}

export interface SceneStore {
  listEnabled(): Promise<ScenePack[]>
}

export interface SceneService {
  listForPlan(plan: Plan): Promise<ScenePack[]>
}

export function createSceneService(store: SceneStore): SceneService {
  return {
    async listForPlan(plan) {
      return visibleScenesForPlan(await store.listEnabled(), plan)
    },
  }
}

export const defaultScenePacks: ScenePack[] = defaultScenePackInputs.map((scene) => ({
  id: `builtin:${scene.slug}`,
  slug: scene.slug,
  name: scene.name,
  description: scene.description,
  category: scene.category,
  promptTemplate: scene.promptTemplate,
  dictionaryTerms: scene.dictionaryTerms,
  isPro: scene.isPro,
}))

export function createStaticSceneStore(scenes: ScenePack[]): SceneStore {
  return {
    async listEnabled() {
      return scenes
    },
  }
}

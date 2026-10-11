export type Plan = 'free' | 'pro'
export type UserQuotaLevel = 1 | 2 | 3 | 4 | 5

export interface AuthenticatedUser {
  id: string
  email: string
  name: string | null
  plan: Plan
  subscriptionEnd: string | null
}

export interface SubscriptionStatus {
  plan: Plan
  subscriptionEnd: string | null
  quotaLevel: UserQuotaLevel
  quotaMultiplier: number
  sttSecondsUsed: number
  sttSecondsLimit: number
  llmTokensUsed: number
  llmTokensLimit: number
  ocrImagesUsed: number
  ocrImagesLimit: number
  ttsCharsUsed: number
  ttsCharsLimit: number
}

export interface PlanLimits {
  sttSecondsLimit: number
  llmTokensLimit: number
  ocrImagesLimit: number
  ttsCharsLimit: number
}

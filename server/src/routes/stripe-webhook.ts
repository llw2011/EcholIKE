import { json } from '../errors.js'
import type { Handler } from '../http.js'

export const stripeWebhook: Handler = async (ctx) => {
  const rawBody = await ctx.request.text()
  const result = await ctx.services.billing.handleWebhook(
    rawBody,
    ctx.request.headers.get('stripe-signature'),
  )

  return json(result)
}

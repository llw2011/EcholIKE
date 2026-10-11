import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadEnv } from './env.js'
import { createDefaultServices } from './services/app-services.js'
import { createGracefulShutdown } from './lifecycle.js'

const env = loadEnv()
const services = createDefaultServices(env)
const app = createApp({ env, services })

const server = serve(
  {
    fetch: app.fetch.bind(app),
    port: env.port,
  },
  () => {
    console.log(`EcholIKE API listening on :${env.port}`)
  },
)

const shutdown = createGracefulShutdown(server, services)
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdown().catch((error) => {
      console.error('EcholIKE API shutdown failed', error)
      process.exitCode = 1
    })
  })
}

void services.warmup().catch((error) => {
  console.warn('EcholIKE PDF OCR warmup did not complete', error)
})

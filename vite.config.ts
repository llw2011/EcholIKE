import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// @ts-expect-error process is a nodejs global
const { TAURI_DEV_HOST: host, PASEO_PORT: paseoPortValue } = process.env
const paseoPort = Number.parseInt(paseoPortValue ?? '', 10)
const devPort = paseoPort >= 1 && paseoPort <= 65_535 ? paseoPort : 1420

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: devPort,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
}))

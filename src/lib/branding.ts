import packageJson from '../../package.json'

export const APP_NAME = 'EcholIKE'
export const APP_VERSION = packageJson.version
export const DEFAULT_UPDATE_CHECK_URL = 'http://127.0.0.1:8787/echo-api/app/update'
export const DEFAULT_DESKTOP_BOOTSTRAP_URL = 'http://127.0.0.1:8787/echo-api/desktop/bootstrap'

export const UPDATE_CHECK_URL =
  import.meta.env.VITE_ECHOLIKE_UPDATE_CHECK_URL?.trim() || DEFAULT_UPDATE_CHECK_URL

export const DESKTOP_BOOTSTRAP_URL =
  import.meta.env.VITE_ECHOLIKE_DESKTOP_BOOTSTRAP_URL?.trim() || DEFAULT_DESKTOP_BOOTSTRAP_URL

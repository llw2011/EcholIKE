export function maskSecret(value: string | null | undefined) {
  const secret = value?.trim() ?? ''
  if (!secret) return ''
  if (secret.length <= 8) {
    return `${secret.slice(0, 2)}****${secret.slice(-2)}`
  }
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`
}

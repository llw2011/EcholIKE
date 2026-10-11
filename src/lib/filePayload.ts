export function fileToBase64(
  file: File,
  options: {
    readErrorMessage?: string
    emptyErrorMessage?: string
  } = {},
) {
  const { readErrorMessage = '读取文件失败。', emptyErrorMessage = '文件内容为空。' } = options

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(readErrorMessage))
    reader.onload = () => {
      const value = String(reader.result ?? '')
      const base64 = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value
      if (!base64.trim()) {
        reject(new Error(emptyErrorMessage))
        return
      }
      resolve(base64)
    }
    reader.readAsDataURL(file)
  })
}

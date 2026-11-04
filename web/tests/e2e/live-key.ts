import { readFile } from 'node:fs/promises'

export function parseLiveKey(contents: string) {
  const match = /^\s*(?:export\s+)?(?:DEEPSEEK|DEEPSEEK_API_KEY)\s*=\s*(.*?)\s*$/m.exec(contents)
  const value = match?.[1] ?? ''
  const quoted = /^(['"])(.*?)\1(?:\s+#.*)?$/.exec(value)
  const key = quoted ? quoted[2]!.trim() : value.split(/\s+#/)[0]!.trim()
  if (!key || key.startsWith('"') || key.startsWith("'")) {
    throw new Error('真实模型凭据文件需要非空的 DEEPSEEK 或 DEEPSEEK_API_KEY 变量，内容已省略')
  }
  return key
}

export async function readLiveKey(path: string) {
  let contents: string
  try { contents = await readFile(path, 'utf8') }
  catch { throw new Error('无法读取用户指定的真实模型凭据文件，内容与系统异常已省略') }
  return parseLiveKey(contents)
}

import { readFile } from 'node:fs/promises'

function parseKey(contents: string, names: RegExp, missing: string) {
  const match = names.exec(contents)
  const value = match?.[1] ?? ''
  const quoted = /^(['"])(.*?)\1(?:\s+#.*)?$/.exec(value)
  const key = quoted ? quoted[2]!.trim() : value.split(/\s+#/)[0]!.trim()
  if (!key || key.startsWith('"') || key.startsWith("'")) {
    throw new Error(missing)
  }
  return key
}

export function parseLiveKey(contents: string) {
  return parseKey(contents, /^\s*(?:export\s+)?(?:DEEPSEEK|DEEPSEEK_API_KEY)\s*=\s*(.*?)\s*$/m,
    '真实模型凭据文件需要非空的 DEEPSEEK 或 DEEPSEEK_API_KEY 变量，内容已省略')
}

async function readKeyFile(path: string, parse: (contents: string) => string) {
  let contents: string
  try { contents = await readFile(path, 'utf8') }
  catch { throw new Error('无法读取用户指定的真实测试凭据文件，内容与系统异常已省略') }
  return parse(contents)
}

export const readLiveKey = (path: string) => readKeyFile(path, parseLiveKey)
export const readGitHubMcpKey = (path: string) => readKeyFile(path, contents =>
  parseKey(contents, /^\s*(?:export\s+)?(?:GitHub|GitHub_TOKEN|GitHub_MCP_TOKEN|GitHub_PAT)\s*=\s*(.*?)\s*$/im,
    'GitHub 凭据文件需要非空的 GitHub 或 GITHUB_MCP_TOKEN 变量，内容已省略'))

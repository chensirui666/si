import { homedir } from 'node:os'
import { join } from 'node:path'
import { readCredentialFile, withCredentialFileLock, writeCredentialFile } from '@agent-learning/credentials'

const defaultPath = join(homedir(), '.agent-learning', 'settings.json')

export function isSettingsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function readSettingsFile(filename = defaultPath): Promise<Record<string, unknown>> {
  const contents = await readCredentialFile(filename)
  if (contents === undefined) return {}
  const value: unknown = JSON.parse(contents)
  if (!isSettingsObject(value)) throw new Error('本机设置文件无效，请修复后重试。')
  return value
}

export async function updateSettingsFile(filename = defaultPath, update: (settings: Record<string, unknown>) => void) {
  await withCredentialFileLock(filename, async () => {
    const settings = await readSettingsFile(filename)
    update(settings)
    await writeCredentialFile(filename, JSON.stringify(settings, null, 2) + '\n')
  })
}

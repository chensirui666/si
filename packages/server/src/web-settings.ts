import { homedir } from 'node:os'
import { join } from 'node:path'
import { readCredentialFile, withCredentialFileLock, writeCredentialFile, type Credentials, type CredentialStatus } from '@agent-learning/credentials'
import type { WebProvider } from './web-providers.js'

type WebSelection = { searchProvider: string; fetchProvider: string }
type Capability = 'search' | 'fetch'
export type WebSettingsView = WebSelection & {
  providers: { id: string; name: string; capabilities: Capability[]; status: CredentialStatus }[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class WebSettings {
  constructor(private readonly providers: readonly WebProvider[], private readonly credentials: Credentials,
    private readonly filename = join(homedir(), '.agent-learning', 'settings.json')) {}

  private async read(): Promise<Record<string, unknown>> {
    const contents = await readCredentialFile(this.filename)
    if (contents === undefined) return {}
    const file: unknown = JSON.parse(contents)
    if (!isObject(file)) throw new Error('网页服务商设置文件无效，请修复后重试。')
    if (isObject(file.web) && this.hasProvider('tavily') && !this.hasProvider('exa')) {
      const { searchProvider, fetchProvider } = file.web
      file.web = {
        ...file.web,
        searchProvider: searchProvider === 'exa' ? 'tavily' : searchProvider,
        fetchProvider: fetchProvider === 'exa' ? 'tavily' : fetchProvider,
      }
    }
    if (Object.hasOwn(file, 'web') && !this.validSelection(file.web)) {
      throw new Error('网页服务商设置文件无效，请修复后重试。')
    }
    return file
  }

  private async selection(): Promise<WebSelection> {
    const file = await this.read()
    if (this.validSelection(file.web)) return file.web
    const defaultFor = (capability: Capability) => {
      const available = this.providers.filter(provider => provider[capability])
      if (available.length !== 1) throw new Error('请配置网页工具的默认服务商。')
      return available[0]!.id
    }
    return { searchProvider: defaultFor('search'), fetchProvider: defaultFor('fetch') }
  }

  validSelection(value: unknown): value is WebSelection {
    return isObject(value) && Object.keys(value).length === 2
      && this.providers.some(provider => provider.id === value.searchProvider && provider.search)
      && this.providers.some(provider => provider.id === value.fetchProvider && provider.fetch)
  }

  hasProvider(id: string) { return this.providers.some(provider => provider.id === id) }

  async save(selection: WebSelection) {
    if (!this.validSelection(selection)) throw new Error('请选择支持对应能力的网页服务商。')
    await withCredentialFileLock(this.filename, async () => {
      const file = await this.read()
      await writeCredentialFile(this.filename, JSON.stringify({ ...file, web: selection }, null, 2) + '\n')
    })
  }

  async view(): Promise<WebSettingsView> {
    const selection = await this.selection()
    const providers = await Promise.all(this.providers.map(async provider => ({
      id: provider.id, name: provider.name,
      capabilities: (['search', 'fetch'] as const).filter(capability => provider[capability]),
      status: await this.credentials.readStatus(provider.id),
    })))
    return { ...selection, providers }
  }

  async provider(capability: Capability): Promise<WebProvider> {
    const id = (await this.selection())[capability === 'search' ? 'searchProvider' : 'fetchProvider']
    const provider = this.providers.find(provider => provider.id === id && provider[capability])
    if (!provider) throw new Error('未配置支持该能力的网页服务商。')
    return provider
  }
}

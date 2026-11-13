import type { Credentials, CredentialStatus } from '@agent-learning/credentials'
import type { WebProvider } from '@agent-learning/coding-agent'
import { isSettingsObject, readSettingsFile, updateSettingsFile } from './settings-file.js'

type WebSelection = { searchProvider: string; fetchProvider: string }
type Capability = 'search' | 'fetch'
export type WebSettingsView = WebSelection & {
  providers: { id: string; name: string; capabilities: Capability[]; status: CredentialStatus }[]
}

export class WebSettings {
  constructor(private readonly providers: readonly WebProvider[], private readonly credentials: Credentials,
    private readonly filename?: string) {}

  private readSelection(file: Record<string, unknown>): WebSelection | undefined {
    if (!Object.hasOwn(file, 'web')) return undefined
    let web = file.web
    if (isSettingsObject(web) && this.hasProvider('tavily') && !this.hasProvider('exa')) {
      const { searchProvider, fetchProvider } = web
      web = {
        ...web,
        searchProvider: searchProvider === 'exa' ? 'tavily' : searchProvider,
        fetchProvider: fetchProvider === 'exa' ? 'tavily' : fetchProvider,
      }
    }
    if (!this.validSelection(web)) throw new Error('网页服务商设置文件无效，请修复后重试。')
    return web
  }

  private async selection(): Promise<WebSelection> {
    const selection = this.readSelection(await readSettingsFile(this.filename))
    if (selection) return selection
    const defaultFor = (capability: Capability) => {
      const available = this.providers.filter(provider => provider[capability])
      if (available.length !== 1) throw new Error('请配置网页工具的默认服务商。')
      return available[0]!.id
    }
    return { searchProvider: defaultFor('search'), fetchProvider: defaultFor('fetch') }
  }

  validSelection(value: unknown): value is WebSelection {
    return isSettingsObject(value) && Object.keys(value).length === 2
      && this.providers.some(provider => provider.id === value.searchProvider && provider.search)
      && this.providers.some(provider => provider.id === value.fetchProvider && provider.fetch)
  }

  hasProvider(id: string) { return this.providers.some(provider => provider.id === id) }

  async save(selection: WebSelection) {
    if (!this.validSelection(selection)) throw new Error('请选择支持对应能力的网页服务商。')
    await updateSettingsFile(this.filename, file => {
      this.readSelection(file)
      file.web = selection
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

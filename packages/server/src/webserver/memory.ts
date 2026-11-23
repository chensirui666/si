import { readSettingsFile, updateSettingsFile } from '../settings-file.js'

function enabledFrom(file: Record<string, unknown>): boolean {
  const { memoryEnabled = true } = file
  if (typeof memoryEnabled !== 'boolean') throw new Error('记忆开关设置无效')
  return memoryEnabled
}

export class MemorySettings {
  private previous?: boolean
  private generation = 0
  private tail = Promise.resolve()

  constructor(private readonly filename?: string) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation)
    this.tail = next.then(() => {}, () => {})
    return next
  }

  private observe(enabled: boolean) {
    if (this.previous !== undefined && this.previous !== enabled) this.generation++
    this.previous = enabled
    return { enabled, generation: this.generation }
  }

  read(fallbackToDisabled = false) {
    return this.enqueue(async () => {
      try { return this.observe(enabledFrom(await readSettingsFile(this.filename))) }
      catch (error) {
        if (!fallbackToDisabled) throw error
        console.error('无法读取记忆设置，本轮停用记忆。')
        return this.observe(false)
      }
    })
  }

  save(enabled: boolean) {
    return this.enqueue(async () => {
      let before = true
      await updateSettingsFile(this.filename, file => {
        before = enabledFrom(file)
        file.memoryEnabled = enabled
      })
      this.observe(before)
      return this.observe(enabled)
    })
  }
}

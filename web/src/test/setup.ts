import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(cleanup)

// jsdom 不执行排版；这些空实现只供编辑器 DOM 测试，排版由浏览器测试验证。
Range.prototype.getBoundingClientRect = () => new DOMRect()
Range.prototype.getClientRects = () => Object.assign([], { item: () => null })
HTMLElement.prototype.scrollIntoView = () => {}

class ClipboardEvent extends Event {
  readonly clipboardData: DataTransfer | null
  constructor(type: string, init: ClipboardEventInit = {}) {
    super(type, init)
    this.clipboardData = init.clipboardData ?? null
  }
}
Object.assign(globalThis, { ClipboardEvent })

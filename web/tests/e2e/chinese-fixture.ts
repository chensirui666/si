import { test as base } from '@playwright/test'

export { expect, type Page } from '@playwright/test'

// The existing chat scenarios use Chinese UI locators. Language E2E uses the real setting.
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route('**/api/settings/language', route => route.fulfill({ json: { language: 'zh-CN' } }))
    await use(context)
  },
})

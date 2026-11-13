import { expect, test } from 'vitest'
import { createInstance } from 'i18next'
import { en } from './en'
import { zh } from './zh-CN'

test('each interface label has both translations and matching interpolation parameters', () => {
  expect(Object.keys(zh)).toEqual(Object.keys(en))
  const placeholders = (value: string) => [...value.matchAll(/{{\s*(\w+)\s*}}/g)].map(match => match[1]).sort()
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    expect(en[key].trim(), key).not.toBe('')
    expect(zh[key].trim(), key).not.toBe('')
    expect(placeholders(zh[key]), key).toEqual(placeholders(en[key]))
  }
})

test('a missing Chinese translation falls back to English', async () => {
  const i18n = createInstance()
  await i18n.init({
    resources: { en: { translation: en }, 'zh-CN': { translation: {} } },
    lng: 'zh-CN', fallbackLng: 'en', keySeparator: false,
  })
  expect(i18n.t('settings.general')).toBe('General')
})

import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { en } from './en'
import { zh } from './zh-CN'

export const i18n = createInstance()
void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, 'zh-CN': { translation: zh } },
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: ['en', 'zh-CN'],
  load: 'currentOnly',
  initAsync: false,
  keySeparator: false,
  interpolation: { escapeValue: false },
})

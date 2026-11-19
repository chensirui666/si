import '../src/styles.css'
import { beforeMount } from '@playwright/experimental-ct-react/hooks'
import { i18n } from '../src/i18n/copy'
import { loadLanguage } from '../src/i18n'

beforeMount<{ loadSavedLanguage?: boolean }>(async ({ hooksConfig }) => {
  if (hooksConfig?.loadSavedLanguage) await loadLanguage()
  else await i18n.changeLanguage('zh-CN')
})

import { init, mount } from 'imp'
import { root } from './app.js'
import { THEMES } from './themes.js'

await init({
  themes: THEMES,
  theme: 'system',
  persist: true,
  translations: { en: () => import('./locales/en.js') },
})

mount('#app', root())

import { init, mount } from 'imp'
import { root } from './app.js'
import { alyDark } from './themes.js'

await init({ theme: alyDark, translations: { en: () => import('./locales/en.js') } })

mount('#app', root())

import { init, mount } from 'imp'
import { root } from './app.js'
import { alyDark } from './themes.js'

await init({ theme: alyDark })

mount('#app', root())

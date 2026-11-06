import { component } from 'imp'
import { initState } from 'imp/state'
import { button, icon } from 'imp/std'
import { notify } from 'imp/std/feedback'
import { luMonitorDown } from 'imp/icons'
import { installMode, onInstallChange, promptInstall } from '../lib/install.js'

export const installButton = component('aly-install-button', {
  setup: (self) => {
    const mode = initState(self, 'aly.install', installMode())
    onInstallChange(() => mode.set(installMode()), self.abortSignal)
    const install = () => {
      if (mode.get() === 'prompt') return promptInstall()
      notify({
        kind: 'info',
        title: 'Install the console',
        description: 'In Safari, tap Share, then tap "Add to Home Screen".',
      })
    }
    return mode.view((value) =>
      value === 'none'
        ? null
        : button(
            { variant: 'ghost', size: 'sm', events: { click: install } },
            icon(luMonitorDown),
            'Install the app',
          ),
    )
  },
})

import { component } from 'imp'
import { initHttpClient } from 'imp/http'
import { router } from 'imp/router'
import { initState } from 'imp/state'
import { icon } from 'imp/std'
import { toast } from 'imp/std/feedback'
import { appLogo, shell, themeSelect } from 'imp/std/shell'
import {
  luArchive,
  luChartColumn,
  luFiles,
  luGauge,
  luGlobe,
  luLayoutDashboard,
  luPackage,
  luSearch,
  luServer,
} from 'imp/icons'
import { app } from './app-map.js'
import { messageOf, serversParam } from './lib/api.js'
import { initScope } from './lib/scope.js'
import { appsScreen } from './screens/apps.js'
import { audienceScreen } from './screens/audience.js'
import { backupScreen } from './screens/backup.js'
import { exploreScreen } from './screens/explore.js'
import { overviewScreen } from './screens/overview.js'
import { pagesScreen } from './screens/pages.js'
import { serversScreen } from './screens/servers.js'
import { speedScreen } from './screens/speed.js'

const loadCatalog = async (api, servers) => {
  const saved = await api.get('/servers')
  const names = new Set(saved.servers.map(({ name }) => name))
  const chosen = servers.filter((name) => names.has(name))
  try {
    const { apps, failedServers } = await api.get('/apps', {
      query: { servers: serversParam(chosen) },
    })
    return { servers: saved, chosen, apps, failedServers, error: null }
  } catch (error) {
    return { servers: saved, chosen, apps: [], failedServers: [], error: messageOf(error) }
  }
}

export const root = component('aly-root', {
  setup: (self) => {
    const api = initHttpClient(self, 'aly.api', { baseUrl: '/api', requestId: false })
    const { servers, app: chosenApp } = initScope(self)
    const catalog = initState(self, 'aly.catalog', undefined)
    const revision = initState(self, 'aly.revision', 0)
    let latest = 0
    const reload = async () => {
      const run = ++latest
      let next
      try {
        next = await loadCatalog(api, servers.get())
      } catch (error) {
        next = { servers: null, chosen: [], apps: [], failedServers: [], error: messageOf(error) }
      }
      if (run !== latest || self.abortSignal.aborted) return
      if (next.chosen.length !== servers.get().length) servers.set(next.chosen)
      catalog.set(next)
      const names = [...new Set(next.apps.map(({ name }) => name))].sort()
      if (!next.error && !names.includes(chosenApp.get())) chosenApp.set(names[0])
    }
    servers.watch(self, reload)
    revision.watch(self, reload)
    return shell(
      {
        logo: appLogo({
          label: 'imp-aly',
          tagline: 'console',
          icon: icon(luChartColumn, { size: 'lg' }),
        }),
        navbar: {
          map: app,
          icons: {
            [app.console.overview]: luLayoutDashboard,
            [app.console.pages]: luFiles,
            [app.console.speed]: luGauge,
            [app.console.audience]: luGlobe,
            [app.console.explore]: luSearch,
            [app.console.apps]: luPackage,
            [app.console.servers]: luServer,
            [app.console.backup]: luArchive,
          },
        },
        extras: [themeSelect()],
      },
      toast(),
      router({
        map: app,
        screens: {
          [app.console.overview]: () => overviewScreen(),
          [app.console.pages]: () => pagesScreen(),
          [app.console.speed]: () => speedScreen(),
          [app.console.audience]: () => audienceScreen(),
          [app.console.explore]: () => exploreScreen(),
          [app.console.apps]: () => appsScreen(),
          [app.console.servers]: () => serversScreen(),
          [app.console.backup]: () => backupScreen(),
        },
        title: ({ crumbs }) => `${crumbs.at(-1)} - imp-aly console`,
      }),
    )
  },
})

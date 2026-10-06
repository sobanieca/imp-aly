import { component } from 'imp'
import { initHttpClient } from 'imp/http'
import { router } from 'imp/router'
import { computed, initState } from 'imp/state'
import { icon } from 'imp/std'
import { notify, toast } from 'imp/std/feedback'
import { flex } from 'imp/std/layout'
import { appLogo, orgSelect, shell, themeSelect } from 'imp/std/shell'
import {
  luArchive,
  luChartColumn,
  luFiles,
  luGauge,
  luMousePointerClick,
  luPackage,
  luSearch,
  luServer,
  luTarget,
  luTriangleAlert,
} from 'imp/icons'
import { app } from './app-map.js'
import { messageOf } from './lib/api.js'
import { appNamesOf } from './lib/catalog.js'
import { appsOf, CLIENT_OPTIONS } from './lib/client.js'
import { initScope } from './lib/scope.js'
import { loadServers, useServer } from './lib/vault.js'
import { alyDark, alyLight } from './themes.js'
import { installButton } from './parts/install-button.js'
import { backupScreen } from './screens/backup.js'
import { errorsScreen } from './screens/errors.js'
import { exploreScreen } from './screens/explore.js'
import { outcomesScreen } from './screens/outcomes.js'
import { overviewScreen } from './screens/overview.js'
import { pagesScreen } from './screens/pages.js'
import { registryScreen } from './screens/registry.js'
import { serversScreen } from './screens/servers.js'
import { zonesScreen } from './screens/zones.js'

const loadCatalog = async (api, servers) => {
  const saved = await loadServers()
  const names = new Set(saved.servers.map(({ name }) => name))
  const chosen = servers.filter((name) => names.has(name))
  if (!saved.servers.length) {
    return { servers: saved, chosen, apps: [], failedServers: [], error: null }
  }
  try {
    const { apps, failedServers } = await appsOf(api, chosen)
    return { servers: saved, chosen, apps, failedServers, error: null }
  } catch (error) {
    return { servers: saved, chosen, apps: [], failedServers: [], error: messageOf(error) }
  }
}

const serverOrgs = (catalog) =>
  (catalog?.servers?.servers ?? []).map(({ name, url }) => ({ id: name, name, description: url }))

export const root = component('aly-root', {
  setup: (self) => {
    const api = initHttpClient(self, 'aly.api', CLIENT_OPTIONS)
    const { servers, app: chosenApp } = initScope(self)
    const catalog = initState(self, 'aly.catalog', undefined)
    const revision = initState(self, 'aly.revision', 0)
    const active = initState(self, 'aly.server.active', undefined)
    const orgs = computed([catalog], serverOrgs)
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
      active.set(next.servers?.default || undefined)
      const names = appNamesOf(next)
      if (!next.error && !names.includes(chosenApp.get())) chosenApp.set(names[0])
    }
    servers.watch(self, reload)
    revision.watch(self, reload)
    const switchServer = async (event) => {
      try {
        await useServer(event.detail.id)
      } catch (error) {
        event.preventDefault()
        return notify({
          kind: 'error',
          title: 'The server did not change',
          description: messageOf(error),
        })
      }
      if (servers.get().length) servers.set([])
      else revision.set((value) => value + 1)
    }
    return shell(
      {
        logo: flex(
          { gap: 2, verticalAlign: 'center', wrap: true },
          appLogo({
            label: 'imp-aly',
            tagline: 'console',
            icon: icon(luChartColumn, { size: 'lg' }),
          }),
          orgs.view((list) =>
            list.length
              ? orgSelect({
                orgs: list,
                selected: active,
                label: 'Active server',
                size: 'sm',
                events: { select: switchServer },
              })
              : null
          ),
        ),
        navbar: {
          map: app,
          icons: {
            [app.console.overview]: luGauge,
            [app.console.pages]: luFiles,
            [app.console.zones]: luMousePointerClick,
            [app.console.outcomes]: luTarget,
            [app.console.errors]: luTriangleAlert,
            [app.console.explore]: luSearch,
            [app.console.registry]: luPackage,
            [app.console.servers]: luServer,
            [app.console.backup]: luArchive,
          },
        },
        extras: [
          installButton(),
          themeSelect({
            themes: [
              { value: alyDark.name, label: 'Dark', theme: alyDark },
              { value: alyLight.name, label: 'Light', theme: alyLight },
            ],
          }),
        ],
      },
      toast(),
      router({
        map: app,
        screens: {
          [app.console.overview]: () => overviewScreen(),
          [app.console.pages]: () => pagesScreen(),
          [app.console.zones]: () => zonesScreen(),
          [app.console.outcomes]: () => outcomesScreen(),
          [app.console.errors]: () => errorsScreen(),
          [app.console.explore]: () => exploreScreen(),
          [app.console.registry]: () => registryScreen(),
          [app.console.servers]: () => serversScreen(),
          [app.console.backup]: () => backupScreen(),
        },
        title: ({ crumbs }) => `${crumbs.at(-1)} - imp-aly console`,
      }),
    )
  },
})

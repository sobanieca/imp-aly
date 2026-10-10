import { component } from 'imp'
import { initHttpClient } from 'imp/http'
import { router } from 'imp/router'
import { computed, initState } from 'imp/state'
import { icon } from 'imp/std'
import { toast } from 'imp/std/feedback'
import { flex } from 'imp/std/layout'
import { appLogo, orgSelect, shell, themeSelect } from 'imp/std/shell'
import {
  luChartColumn,
  luFiles,
  luGauge,
  luMousePointerClick,
  luPackage,
  luServer,
  luTarget,
  luTriangleAlert,
} from 'imp/icons'
import { app } from './app-map.js'
import { messageOf } from './lib/api.js'
import { appNamesOf } from './lib/catalog.js'
import { appsOf, CLIENT_OPTIONS } from './lib/client.js'
import { failuresOf, keepServers, onHealthChange } from './lib/health.js'
import { serversTag } from './lib/nav-tags.js'
import { initScope } from './lib/scope.js'
import { loadServers } from './lib/vault.js'
import { alyDark, alyLight } from './themes.js'
import { installButton } from './parts/install-button.js'
import { errorsScreen } from './screens/errors.js'
import { outcomesScreen } from './screens/outcomes.js'
import { overviewScreen } from './screens/overview.js'
import { pagesScreen } from './screens/pages.js'
import { registryScreen } from './screens/registry.js'
import { serversScreen } from './screens/servers.js'
import { zonesScreen } from './screens/zones.js'

const loadCatalog = async (api) => {
  const saved = await loadServers()
  if (!saved.servers.length) return { servers: saved, apps: [], failedServers: [], error: null }
  try {
    const { apps, failedServers } = await appsOf(api, saved.servers.map(({ name }) => name))
    return { servers: saved, apps, failedServers, error: null }
  } catch (error) {
    return { servers: saved, apps: [], failedServers: [], error: messageOf(error) }
  }
}

const appOrgs = (catalog) => appNamesOf(catalog).map((name) => ({ id: name, name }))

export const root = component('aly-root', {
  setup: (self) => {
    const api = initHttpClient(self, 'aly.api', CLIENT_OPTIONS)
    const { app: chosenApp } = initScope(self)
    const catalog = initState(self, 'aly.catalog', undefined)
    const revision = initState(self, 'aly.revision', 0)
    const health = initState(self, 'aly.health', failuresOf())
    onHealthChange(() => health.set(failuresOf()), self.abortSignal)
    const orgs = computed([catalog], appOrgs)
    const serversNavTag = computed(
      [catalog, chosenApp, health],
      (value, name, failures) => serversTag({ catalog: value, app: name, failures }),
    )
    let latest = 0
    const reload = async () => {
      const run = ++latest
      let next
      try {
        next = await loadCatalog(api)
      } catch (error) {
        next = { servers: null, apps: [], failedServers: [], error: messageOf(error) }
      }
      if (run !== latest || self.abortSignal.aborted) return
      if (next.servers) keepServers(next.servers.servers.map(({ name }) => name))
      catalog.set(next)
      const names = appNamesOf(next)
      if (!next.error && !names.includes(chosenApp.get())) chosenApp.set(names[0])
    }
    revision.watch(self, reload)
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
                selected: chosenApp,
                label: computed([chosenApp], (name) => `App: ${name ?? '-'}`),
                size: 'sm',
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
            [app.console.registry]: luPackage,
            [app.console.servers]: luServer,
          },
          tags: { [app.console.servers]: serversNavTag },
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
          [app.console.registry]: () => registryScreen(),
          [app.console.servers]: () => serversScreen(),
        },
        title: ({ crumbs }) => `${crumbs.at(-1)} - imp-aly console`,
      }),
    )
  },
})

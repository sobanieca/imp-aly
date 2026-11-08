import { component } from 'imp'
import { initHttpClient } from 'imp/http'
import { router } from 'imp/router'
import { computed, initState } from 'imp/state'
import { icon } from 'imp/std'
import { toast } from 'imp/std/feedback'
import { appLogo, orgSelect, shell, themeSelect } from 'imp/std/shell'
import {
  luChartColumn,
  luChartNoAxesCombined,
  luFiles,
  luGauge,
  luMousePointerClick,
  luPackage,
  luServer,
  luSettings2,
  luTarget,
  luTriangleAlert,
} from 'imp/icons'
import { app } from './app-map.js'
import { messageOf } from './lib/api.js'
import { appNamesOf } from './lib/catalog.js'
import { appsOf, CLIENT_OPTIONS } from './lib/client.js'
import { failuresOf, keepServers, onHealthChange } from './lib/health.js'
import { sectionTag, serversTag } from './lib/nav-tags.js'
import { initScope } from './lib/scope.js'
import { loadServers } from './lib/vault.js'
import { barsRoom, colorBars, cornerArt } from './parts/brand-art.js'
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
    const { apps, failedServers } = await appsOf(
      api,
      saved.servers.map(({ name }) => name),
    )
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
    const serversTagOf = (value, name, failures) =>
      serversTag({ catalog: value, app: name, failures })
    const serversNavTag = initState(
      self,
      'aly.serversTag',
      serversTagOf(catalog.get(), chosenApp.get(), health.get()),
    )
    const manageNavTag = initState(self, 'aly.manageTag', sectionTag(serversNavTag.get()))
    computed([catalog, chosenApp, health], serversTagOf).watch(self, (tag) => {
      serversNavTag.set(tag)
      manageNavTag.set(sectionTag(tag))
    })
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
        logo: appLogo({
          label: 'imp-aly',
          tagline: 'console',
          icon: icon(luChartColumn, { size: 'lg' }),
        }),
        map: app,
        navbar: { label: 'Sections', background: colorBars() },
        sidebar: { label: 'Pages' },
        background: cornerArt(),
        nav: {
          [app.reports]: { icon: luChartNoAxesCombined },
          [app.reports.overview]: { icon: luGauge },
          [app.reports.pages]: { icon: luFiles },
          [app.reports.zones]: { icon: luMousePointerClick },
          [app.reports.outcomes]: { icon: luTarget },
          [app.reports.errors]: { icon: luTriangleAlert },
          [app.manage]: { icon: luSettings2, tag: 'aly.manageTag' },
          [app.manage.registry]: { icon: luPackage },
          [app.manage.servers]: { icon: luServer, tag: 'aly.serversTag' },
        },
        extras: [
          orgs.view((list) =>
            list.length
              ? orgSelect({
                  orgs: list,
                  selected: chosenApp,
                  label: computed([chosenApp], (name) => `App: ${name ?? '-'}`),
                  size: 'sm',
                })
              : null,
          ),
          installButton(),
          themeSelect({ variant: 'ghost' }),
          barsRoom(),
        ],
      },
      toast(),
      router({
        map: app,
        screens: {
          [app.reports.overview]: () => overviewScreen(),
          [app.reports.pages]: () => pagesScreen(),
          [app.reports.zones]: () => zonesScreen(),
          [app.reports.outcomes]: () => outcomesScreen(),
          [app.reports.errors]: () => errorsScreen(),
          [app.manage.registry]: () => registryScreen(),
          [app.manage.servers]: () => serversScreen(),
        },
        title: ({ crumbs }) => `${crumbs.at(-1)} - imp-aly console`,
      }),
    )
  },
})

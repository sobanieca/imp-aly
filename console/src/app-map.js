import { appMap } from 'imp'

export const app = appMap({
  console: {
    path: '/',
    overview: {
      description: 'The visits, the page views, the speed and the errors of an app',
      group: 'Reports',
    },
    pages: {
      description: 'The views, visits, interactions, errors and speed of each page',
      group: 'Reports',
    },
    speed: { description: 'How fast the pages are ready, per day and per page', group: 'Reports' },
    audience: { description: 'The visits per country and per segment', group: 'Reports' },
    explore: {
      description: 'Build a query, run it, and see a table and a chart',
      group: 'Reports',
    },
    apps: { description: 'Register, check, refresh and remove apps', group: 'Manage' },
    servers: { description: 'The saved servers and their state', group: 'Manage' },
    backup: {
      description: 'Download a backup of the daily summaries, or restore one',
      group: 'Manage',
    },
  },
})

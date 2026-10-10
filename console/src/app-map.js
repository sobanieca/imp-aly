import { appMap } from 'imp'

export const app = appMap({
  console: {
    path: '/',
    overview: { description: 'The visits of the apps, and how they change', group: 'Reports' },
    pages: { description: 'How often each page was viewed and used', group: 'Reports' },
    zones: { description: 'How often each zone was seen and used', group: 'Reports' },
    outcomes: { description: 'How often the visits reached each outcome', group: 'Reports' },
    errors: { description: 'The pages with errors, and the errors per view', group: 'Reports' },
    registry: {
      label: 'Registered apps',
      description: 'Register, check, refresh and remove apps',
      group: 'Manage',
    },
    servers: { description: 'The saved servers and their state', group: 'Manage' },
  },
})

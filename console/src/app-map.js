import { appMap } from 'imp'

export const app = appMap({
  reports: {
    overview: 'The visits of the apps, and how they change',
    pages: 'How often each page was viewed and used',
    zones: 'How often each zone was seen and used',
    outcomes: 'How often the visits reached each outcome',
    errors: 'The pages with errors, and the errors per view',
  },
  manage: {
    registry: 'Register, check, refresh and remove apps',
    servers: 'The saved servers and their state',
  },
})

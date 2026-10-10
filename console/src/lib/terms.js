import { RARELY_USED } from './reports.js'

const VISIT = [
  'Visit',
  'One session of a person in one browser tab. The console counts visits, not people. Two tabs are two visits. A tab that stays open past midnight UTC counts as one visit on each day.',
]

const CHANGE = [
  'Change',
  'The difference from the previous period of the same length, just before this one. For "Last 30 days", that is "Previous 30 days": the 30 days before them. For "Last 3 months", that is "Previous 3 months". A custom period shows no change.',
]

const RARELY =
  `viewed ${RARELY_USED.minShown} times or more, and used in less than ${RARELY_USED.maxShare}% of them`

export const OVERVIEW_TERMS = [
  VISIT,
  ['Page views', 'How many times people opened a page of the app.'],
  [
    'Visits with an outcome',
    'The visits that reached one outcome or more, divided by the visits with a page view.',
  ],
  ['Errors per 100 views', 'The errors, divided by the page views, times 100.'],
  CHANGE,
]

export const PAGE_TERMS = [
  ['Views', 'How many times people opened the page. Each opening is one page view.'],
  [
    'Used',
    'The page views where the person clicked, tapped or typed on the page at least once. The app does not need zones for this.',
  ],
  [
    'Used when viewed',
    'Used divided by Views. A low share means that people open the page but do nothing on it.',
  ],
  ['Never reached', 'A page of the app map with no view in these days.'],
  ['Never used', 'A page with views, but with no click, tap or key in any of them.'],
  ['Viewed, rarely used', `A page ${RARELY}.`],
]

export const ZONE_TERMS = [
  ['Zone', 'A named part of a page that the app marks, such as a form or a list.'],
  ['Seen', 'The page views where the zone came into view on the screen.'],
  ['Used', 'The page views where the person clicked, tapped or typed in the zone.'],
  [
    'Used when seen',
    'Used divided by Seen. A low share means that people see the zone but do not use it.',
  ],
  ['Never used', 'A zone that people saw, but never used.'],
  [
    'Seen, rarely used',
    `A zone seen ${RARELY_USED.minShown} times or more, and used in less than ${RARELY_USED.maxShare}% of them.`,
  ],
]

export const OUTCOME_TERMS = [
  ['Outcome', 'A task that a person completed, such as "invoice sent". The app reports it.'],
  ['Count', 'How many times people reached the outcome.'],
  ['Share', 'The count of the outcome, divided by the count of all outcomes.'],
  VISIT,
  [
    'Visits with an outcome',
    'The visits that reached one outcome or more, divided by the visits with a page view.',
  ],
  CHANGE,
]

export const ERROR_TERMS = [
  [
    'Error',
    'A script error or a failed promise on a page. One error stands for up to 5 seconds of failures on one page view.',
  ],
  ['Page views', 'How many times people opened the page.'],
  ['Errors per 100 views', 'The errors, divided by the page views, times 100.'],
  CHANGE,
]

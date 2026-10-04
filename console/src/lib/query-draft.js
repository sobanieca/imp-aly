import { NULL_LABEL } from './rows.js'

const DEFAULT_LIMIT = 1000

export const DEFAULT_DRAFT = {
  groupBy: ['page'],
  measures: ['records', 'visits'],
  filters: [{ field: 'type', values: ['page'] }],
  limit: DEFAULT_LIMIT,
}

export const EXAMPLES = [
  { id: 'visits', label: 'Visits per day', query: { groupBy: ['day'], measures: ['visits'] } },
  {
    id: 'weeks',
    label: 'Visits per week',
    query: { groupBy: ['week'], measures: ['visits'] },
  },
  {
    id: 'pages',
    label: 'Views, uses and errors per page',
    query: {
      where: { type: ['page', 'used', 'error'] },
      groupBy: ['page', 'type'],
      measures: ['records'],
    },
  },
  {
    id: 'zones',
    label: 'Zones, seen and used',
    query: { where: { type: ['seen', 'used'] }, groupBy: ['zone', 'type'] },
  },
  { id: 'outcomes', label: 'Outcomes', query: { where: { type: 'outcome' }, groupBy: ['name'] } },
  {
    id: 'countries',
    label: 'Page views per day and country',
    query: { where: { type: 'page' }, groupBy: ['day', 'country'], measures: ['records'] },
  },
]

export const draftToQuery = (draft) => {
  const where = {}
  for (const { field, values } of draft?.filters ?? []) {
    if (!field || !values?.length) continue
    const list = values.map((value) => (value === NULL_LABEL ? null : value))
    where[field] = list.length === 1 ? list[0] : list
  }
  const query = {}
  if (Object.keys(where).length) query.where = where
  if (draft?.groupBy?.length) query.groupBy = draft.groupBy
  if (draft?.measures?.length) query.measures = draft.measures
  if (draft?.limit && draft.limit !== DEFAULT_LIMIT) query.limit = draft.limit
  return query
}

export const queryToDraft = (query) => ({
  groupBy: query.groupBy ?? [],
  measures: query.measures ?? ['records'],
  filters: Object.entries(query.where ?? {}).map(([field, value]) => ({
    field,
    values: (Array.isArray(value) ? value : [value]).map((item) =>
      item === null ? NULL_LABEL : String(item)
    ),
  })),
  limit: query.limit ?? DEFAULT_LIMIT,
})

export const parseQueryText = (text) => {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`The query is not valid JSON: ${error.message}`, { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The query is a JSON object, like {"groupBy": ["page"]}')
  }
  return value
}

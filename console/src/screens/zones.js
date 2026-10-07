import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { table } from 'imp/std/data'
import { tag } from 'imp/std/display'
import { stack } from 'imp/std/layout'
import { ZONE_TERMS } from '../lib/terms.js'
import { problemsOf, runPrevious, runQuery } from '../lib/api.js'
import { barOf, bucketsOf } from '../lib/days.js'
import { formatCount, formatPercent } from '../lib/format.js'
import { MAX_ROWS, NEVER_USED, RARELY, RARELY_USED, zoneRows } from '../lib/reports.js'
import { stackedSeries, TOP, topKeys, totalsBy, usedSeries } from '../lib/series.js'
import {
  changeHint,
  dataNote,
  noRecords,
  problemNotices,
  reportCard,
  reportError,
  reportLoading,
  reportScreen,
  statTile,
  tileGrid,
  trendChart,
} from '../parts/report.js'

const countColumn = (key, label) => ({
  key,
  label,
  align: 'end',
  sortable: true,
  render: (row) => formatCount(row[key]),
})

const ZONE_COLUMNS = [
  { key: 'zone', label: 'Zone', sortable: true },
  { key: 'page', label: 'Page', sortable: true },
  countColumn('seen', 'Seen'),
  countColumn('used', 'Used'),
  {
    key: 'share',
    label: 'Used when seen',
    align: 'end',
    sortable: true,
    sortValue: (row) => row.share ?? -1,
    render: (row) => formatPercent(row.share),
  },
  {
    key: 'flag',
    label: 'Flag',
    render: (row) =>
      row.flag ? tag({ color: row.flag === NEVER_USED ? 'red' : 'orange' }, row.flag) : '',
  },
]

const usedOf = (rows) =>
  rows.filter((row) => row.zone !== null && row.zone !== undefined).reduce(
    (total, row) => total + row.records,
    0,
  )

const zonesReport = component('aly-zones-report', {
  loading: () => reportLoading(),
  setup: async (self, { scope, filters }) => {
    const api = useHttpClient(self, 'aly.api')
    const bar = barOf(scope.from, scope.to)
    const buckets = bucketsOf(scope.from, scope.to, bar)
    const one = filters.zone !== undefined
    const [current, before, trend] = await Promise.all([
      runQuery(api, scope, {
        where: { ...filters, type: ['seen', 'used'] },
        groupBy: ['zone', 'page', 'type'],
        measures: ['records'],
        limit: MAX_ROWS,
      }),
      runPrevious(api, scope, {
        where: { ...filters, type: 'used' },
        groupBy: ['zone'],
        measures: ['records'],
        limit: MAX_ROWS,
      }),
      runQuery(api, scope, {
        where: { ...filters, type: one ? ['seen', 'used'] : 'used' },
        groupBy: [bar, one ? 'type' : 'zone'],
        measures: ['records'],
        limit: MAX_ROWS,
      }),
    ])
    if (!current.days) return noRecords(current)
    const rows = zoneRows(current.rows)
    const uses = rows.reduce((total, row) => total + row.used, 0)
    const earlier = before ? usedOf(before.rows) : null
    const mostUsed = rows.filter((row) => row.used > 0).sort((a, b) => b.used - a.used)
      .slice(0, TOP)
    const leastUsed = [...rows].sort((a, b) => a.used - b.used || b.seen - a.seen).slice(0, TOP)
    const usedPerZone = totalsBy(
      current.rows.filter((row) => row.type === 'used' && row.zone !== null),
      'zone',
    )
    const [topZone] = [...usedPerZone].sort((a, b) => b[1] - a[1])
    const seenZones = new Set(rows.filter((row) => row.seen > 0).map((row) => row.zone))
    const rarely = rows.filter((row) => row.flag === RARELY).length
    const zoneTrend = trend.rows.filter((row) => row.zone !== null)
    const series = one
      ? usedSeries(trend.rows, { bar, buckets, shownType: 'seen', shownLabel: 'Seen, not used' })
      : stackedSeries(zoneTrend, { bar, field: 'zone', buckets, keys: topKeys(zoneTrend, 'zone') })
    return stack(
      { gap: 5 },
      ...problemNotices(problemsOf([current, before, trend])),
      tileGrid(
        statTile({
          label: 'Zone uses',
          value: formatCount(uses),
          hint: changeHint(uses, earlier, scope),
        }),
        statTile({
          label: 'Most used zone',
          name: true,
          value: topZone ? topZone[0] : '-',
          hint: topZone ? `${formatCount(topZone[1])} uses` : null,
        }),
        statTile({
          label: 'Zones seen',
          value: formatCount(seenZones.size),
          hint: `${formatCount(rows.length)} pairs of zone and page`,
        }),
        statTile({
          label: RARELY,
          value: formatCount(rarely),
          hint:
            `Seen ${RARELY_USED.minShown} times or more, used in less than ${RARELY_USED.maxShare}%`,
        }),
      ),
      reportCard(
        {
          title: one ? `Uses of ${filters.zone}` : 'Uses of the top zones',
          description: one
            ? 'The page views where the zone was used, and where it was seen but not used.'
            : 'The 10 most used zones, and the uses of all other zones as "Other". One visit can use several zones.',
        },
        trendChart({ label: 'Zone uses', bar, buckets, series }),
      ),
      stack(
        { gap: 5 },
        reportCard(
          {
            title: 'Most used zones',
            description:
              '"Used when seen" is the share of the page views that saw the zone and used it.',
          },
          table({ label: 'Most used zones', rows: mostUsed, columns: ZONE_COLUMNS }),
        ),
        reportCard(
          {
            title: 'Least used zones',
            description:
              `"${RARELY}" marks a zone seen ${RARELY_USED.minShown} times or more and used in less than ${RARELY_USED.maxShare}% of them.`,
          },
          table({ label: 'Least used zones', rows: leastUsed, columns: ZONE_COLUMNS }),
        ),
      ),
      dataNote(current),
    )
  },
  error: (self, error) => reportError(error),
})

export const zonesScreen = component('aly-zones', {
  setup: (self) =>
    reportScreen(self, {
      terms: ZONE_TERMS,
      title: 'Zones',
      description: 'How often each zone was seen and used on each page.',
      filters: ['page', 'zone', 'segments', 'country'],
      render: (value) => zonesReport(value),
    }),
})

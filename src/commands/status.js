import { requireOnlyFlags } from '../args.js'
import { callApi } from '../api-client.js'

export const status = async ({ positional, flags }) => {
  requireOnlyFlags(flags, ['auth', 'url'], 'status')
  if (positional.length > 1) throw new Error('use: imp-analytics-server status [--url <url>]')
  const result = await callApi({ url: flags.url, auth: flags.auth, method: 'GET', path: '/status' })
  console.log(JSON.stringify(result, null, 2))
}

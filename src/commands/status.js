import { parseTimeout, requireOnlyFlags } from '../args.js'
import { callApi } from '../api-client.js'

export const status = async ({ positional, flags }) => {
  requireOnlyFlags(flags, ['auth', 'url', 'server', 'timeout'], 'status')
  if (positional.length > 1) throw new Error('use: imp-aly status [-s <server> | --url <url>]')
  const result = await callApi({
    url: flags.url,
    auth: flags.auth,
    server: flags.server,
    method: 'GET',
    path: '/status',
    timeoutMs: parseTimeout(flags.timeout),
  })
  console.log(JSON.stringify(result, null, 2))
}

import { requireOnlyFlags } from '../args.js'
import { createToken, findKey } from '../auth.js'

export const token = async ({ positional, flags }) => {
  requireOnlyFlags(flags, ['auth'], 'token')
  if (positional.length > 1) throw new Error('use: imp-analytics-server token [-a <key or file>]')
  console.log(await createToken(findKey(flags.auth)))
}

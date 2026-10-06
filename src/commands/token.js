import { requireOnlyFlags } from '../args.js'
import { findKey } from '../auth.js'
import { createToken, EMPTY_BODY_HASH } from '../token.js'
import { resolveTarget } from '../servers.js'
import { hashStream } from '../sha256.js'

const USAGE =
  'use: imp-aly token <method> <path> [<body file>] [-s <server>] [-a <key or file>], like: imp-aly token GET /status'

export const token = async ({ positional, flags }) => {
  requireOnlyFlags(flags, ['auth', 'server'], 'token')
  const [, method, path, file, ...rest] = positional
  if (!method || !path || rest.length || !/^[A-Za-z]+$/.test(method) || !path.startsWith('/')) {
    throw new Error(USAGE)
  }
  const bodyHash = file
    ? await hashStream(
      (await Deno.open(file).catch((error) => {
        throw new Error(`cannot read the body file ${file}: ${error.message}`)
      })).readable,
    )
    : EMPTY_BODY_HASH
  const { auth } = resolveTarget({ auth: flags.auth, server: flags.server })
  console.log(await createToken(findKey(auth), { method, path, bodyHash }))
}

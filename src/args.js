const FLAGS = {
  port: 'string',
  'admin-port': 'string',
  'admin-bind': 'string',
  data: 'string',
  auth: 'string',
  bind: 'string',
  url: 'string',
  server: 'string',
  'ip-header': 'string',
  'trusted-proxy': 'string',
  'max-requests': 'string',
  'country-header': 'string',
  'allow-origin': 'string',
  'min-free': 'string',
  'tls-cert': 'string',
  'tls-key': 'string',
  segments: 'string',
  app: 'string',
  from: 'string',
  to: 'string',
  'limit-5s': 'string',
  'limit-1m': 'string',
  'limit-1h': 'string',
  'limit-24h': 'string',
  foreground: 'boolean',
  init: 'boolean',
  uninstall: 'boolean',
  json: 'boolean',
  help: 'boolean',
  version: 'boolean',
  debug: 'boolean',
}

const ALIASES = { p: 'port', a: 'auth', d: 'data', s: 'server', h: 'help', v: 'version' }

const camelCase = (name) => name.replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase())

export const parseArgs = (argv) => {
  const positional = []
  const flags = {}
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--') {
      positional.push(...argv.slice(index + 1))
      break
    }
    let name = null
    let inline = null
    if (argument.startsWith('--')) {
      const equals = argument.indexOf('=')
      name = equals === -1 ? argument.slice(2) : argument.slice(2, equals)
      inline = equals === -1 ? null : argument.slice(equals + 1)
    } else if (/^-[a-zA-Z]$/.test(argument)) {
      name = ALIASES[argument[1]]
      if (!name) throw new Error(`unknown option ${argument} - run imp-aly help`)
    } else {
      positional.push(argument)
      continue
    }
    const kind = FLAGS[name]
    if (!kind) throw new Error(`unknown option --${name} - run imp-aly help`)
    if (kind === 'boolean') {
      if (inline !== null) throw new Error(`--${name} takes no value`)
      flags[camelCase(name)] = true
      continue
    }
    const value = inline ?? argv[++index]
    if (value === undefined || (inline === null && value.startsWith('-') && value.length > 1)) {
      throw new Error(`--${name} needs a value`)
    }
    flags[camelCase(name)] = value
  }
  return { positional, flags }
}

export const flagName = (camel) =>
  `--${Object.keys(FLAGS).find((name) => camelCase(name) === camel) ?? camel}`

export const requireOnlyFlags = (flags, allowed, command) => {
  const extra = Object.keys(flags).filter((flag) => !allowed.includes(flag) && flag !== 'debug')
  if (extra.length) {
    throw new Error(`${command} does not take ${extra.map(flagName).join(', ')}`)
  }
}

export const parsePort = (value) => {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`"${value}" is not a port - use a number from 1 to 65535`)
  }
  return port
}

export const parsePositiveInteger = (value, flag) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${flag} "${value}" is not a whole number above 0`)
  }
  return number
}

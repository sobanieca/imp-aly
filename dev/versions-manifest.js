import { compareVersions, parseVersion } from '../src/update.js'

const FORMAT = /export const DATA_FORMAT = (\d+)/

export const readFormat = (source) => {
  const match = FORMAT.exec(source ?? '')
  return match ? Number(match[1]) : null
}

const git = async (...args) => {
  const { code, stdout } = await new Deno.Command('git', {
    args,
    stdout: 'piped',
    stderr: 'null',
  }).output()
  return code === 0 ? new TextDecoder().decode(stdout) : null
}

const showFile = (tag, path) => git('show', `${tag}:${path}`)

export const buildManifest = async ({ tags, show }) => {
  const versions = []
  for (const tag of tags) {
    const version = tag.slice(1)
    if (!tag.startsWith('v') || !parseVersion(version)) continue
    const denoJson = await show(tag, 'deno.json')
    if (!denoJson || JSON.parse(denoJson).version !== version) continue
    const format = readFormat(await show(tag, 'src/data-format.js'))
    if (format === null) continue
    versions.push({ version, format })
  }
  versions.sort((a, b) => compareVersions(b.version, a.version))
  return { versions }
}

if (import.meta.main) {
  const tags = ((await git('tag', '--list', 'v*')) ?? '').split('\n').filter(Boolean)
  const manifest = await buildManifest({ tags, show: showFile })
  console.log(JSON.stringify(manifest, null, 2))
}

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
// During dev, this resolves from the actual source location. During build,
// Nitro bundles + traces; we anchor on process.cwd() instead.
function tryRequire (paths: string[]): any {
  const req = createRequire(import.meta.url)
  for (const p of paths) {
    try { return req(p) } catch (_) {}
  }
  throw new Error(`SessionManager not found in: ${paths.join(', ')}`)
}

const { getManager } = tryRequire([
  resolve(here, '../../lib/SessionManager.js'),
  resolve(process.cwd(), 'lib/SessionManager.js')
])

export function manager () {
  return getManager()
}

'use strict'

// Tool schema shared by every MCP transport (stdio in bin/overflayer-mcp.js,
// HTTP via the Nuxt route at /mcp). Keep this as the single source of truth.

const TOOLS = [
  {
    name: 'list_players',
    description: 'List all bots managed by Overflayer with their status, position, health, loaded snippets, and viewer port.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'get_player',
    description: 'Get a single bot by username.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: ['username'],
      properties: { username: { type: 'string' } }
    }
  },
  {
    name: 'list_catalog',
    description: 'List all snippets in the catalog (file-backed from snippet_dirs + inline ones currently running). Each entry includes id, source, code, kind, and loadedOn (bots running it).',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'list_snippet_dirs',
    description: 'List configured snippet directories with their writable flag.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'read_snippet',
    description: 'Read the full source code of a single catalog snippet by id. Use this to study an existing snippet as a template before writing a new one.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string' } }
    }
  },
  {
    name: 'read_snippet_globals_docs',
    description: 'Returns the README sections describing the globals injected into every snippet (bot, sleep, interval, run, report, stop, signal, Vec3, GoalNear/Block/XZ/Y/Follow/Invert, plus state*) and async patterns. Read this before authoring a new snippet.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'apply_snippet',
    description: 'Load a snippet onto one or more bots. `code` may be inline JavaScript source OR a file path to a .js file in a snippet_dir.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: ['targets', 'id', 'code'],
      properties: {
        targets: { oneOf: [
          { const: 'all' },
          { type: 'string' },
          { type: 'array', items: { type: 'string' } }
        ] },
        id: { type: 'string' },
        code: { type: 'string', description: 'inline JS source, or a path to a .js file' }
      }
    }
  },
  {
    name: 'unload_snippet',
    description: 'Unload a snippet (by id) from one or more bots. State is cleared.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: ['targets', 'id'],
      properties: {
        targets: { oneOf: [
          { const: 'all' }, { type: 'string' }, { type: 'array', items: { type: 'string' } }
        ] },
        id: { type: 'string' }
      }
    }
  },
  {
    name: 'save_snippet',
    description: 'Persist a snippet to disk in a writable snippet_dir. Triggers hot-reload on every bot that has it loaded.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: ['id', 'code', 'dir'],
      properties: {
        id: { type: 'string', pattern: '^[a-zA-Z0-9_\\-]+$' },
        code: { type: 'string' },
        dir: { type: 'string', description: 'Must match a snippet_dirs entry where writable: true' }
      }
    }
  },
  {
    name: 'set_state',
    description: 'Set a player-level state value for one or more bots. If the key is declared and exported by a loaded behavior, sets it directly; otherwise stores it as a preset for when a behavior declares it.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: ['targets', 'key', 'value'],
      properties: {
        targets: { oneOf: [
          { const: 'all' }, { type: 'string' }, { type: 'array', items: { type: 'string' } }
        ] },
        key: { type: 'string' },
        value: { description: 'string | number | boolean | object (e.g. { x, y, z } for vec3)' }
      }
    }
  },
  {
    name: 'get_recent_events',
    description: 'Return the most recent N events from the SessionManager ring buffer (load, unload, report, stop, state, catalog:*, bot:* …).',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 }
      }
    }
  },
  {
    name: 'get_viewer_url',
    description: 'Returns the prismarine-viewer HTTP URL for a bot (first-person live view). The MCP client can open this in a browser or screenshot it externally.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: ['username'],
      properties: { username: { type: 'string' } }
    }
  }
]

// README slicing for the read_snippet_globals_docs tool. Cached after first read.
const fs = require('fs')
const path = require('path')
let _globalsDocsCache = null
function readGlobalsDocs () {
  if (_globalsDocsCache) return _globalsDocsCache
  const readme = path.resolve(__dirname, '..', 'README.md')
  let text
  try { text = fs.readFileSync(readme, 'utf8') } catch (err) {
    throw new Error(`failed to read README.md at ${readme}: ${err.message}`)
  }
  const start = text.indexOf('### Injected Globals')
  const end = text.indexOf('### Blocked Globals')
  if (start < 0) throw new Error('README.md: could not find "### Injected Globals" section')
  const slice = end > start ? text.slice(start, end) : text.slice(start)
  _globalsDocsCache = slice.trim()
  return _globalsDocsCache
}

module.exports = { TOOLS, readGlobalsDocs }

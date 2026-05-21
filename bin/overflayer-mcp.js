#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js')

const BASE = (process.env.OVERFLAYER_URL || 'http://localhost:3000').replace(/\/+$/, '')

async function http (method, route, body) {
  const url = `${BASE}${route}`
  const init = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await fetch(url, init)
  const text = await res.text()
  if (!res.ok) {
    let msg = res.statusText || `HTTP ${res.status}`
    try { msg = JSON.parse(text).statusMessage || JSON.parse(text).message || msg } catch (_) {}
    throw new Error(`${method} ${route} → ${res.status} ${msg}`)
  }
  if (!text) return null
  try { return JSON.parse(text) } catch (_) { return text }
}

// ---- read_snippet_globals_docs cache ----
let _globalsDocsCache = null
function readGlobalsDocs () {
  if (_globalsDocsCache) return _globalsDocsCache
  const readme = path.resolve(__dirname, '..', 'README.md')
  let text
  try { text = fs.readFileSync(readme, 'utf8') } catch (err) {
    throw new Error(`failed to read README.md at ${readme}: ${err.message}`)
  }
  // Slice from "### Injected Globals" up to (but not including) "### Blocked Globals"
  const start = text.indexOf('### Injected Globals')
  const end = text.indexOf('### Blocked Globals')
  if (start < 0) throw new Error('README.md: could not find "### Injected Globals" section')
  const slice = end > start ? text.slice(start, end) : text.slice(start)
  _globalsDocsCache = slice.trim()
  return _globalsDocsCache
}

// ---- get_recent_events: one-shot SSE replay ----
async function getRecentEvents (limit) {
  // The /api/events endpoint replays a buffer of recent events on connect, then
  // streams new ones. We open the connection, read until we have `limit` lines
  // or the buffer pauses, then bail.
  const url = `${BASE}/api/events`
  const res = await fetch(url, { headers: { accept: 'text/event-stream' } })
  if (!res.ok) throw new Error(`GET /api/events → ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ''
  const deadline = Date.now() + 800 // give the replay buffer a moment

  try {
    while (Date.now() < deadline && events.length < limit) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise(resolve => setTimeout(() => resolve({ value: undefined, done: false }), 200))
      ])
      if (done) break
      if (!value) continue
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try { events.push(JSON.parse(line.slice(6))) } catch (_) {}
        if (events.length >= limit) break
      }
    }
  } finally {
    try { reader.cancel() } catch (_) {}
  }
  return events.slice(-limit)
}

// ---- tool definitions ----
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
        ]},
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
        ]},
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
        ]},
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

const HANDLERS = {
  list_players:               (_a) => http('GET', '/api/players'),
  get_player:                 (a)  => http('GET', `/api/players/${encodeURIComponent(a.username)}`),
  list_catalog:               (_a) => http('GET', '/api/catalog'),
  list_snippet_dirs:          (_a) => http('GET', '/api/snippet-dirs'),
  read_snippet: async         (a)  => {
    const cat = await http('GET', '/api/catalog')
    const entry = cat.find(e => e.id === a.id)
    if (!entry) throw new Error(`no catalog entry with id "${a.id}"`)
    return { id: entry.id, kind: entry.kind, source: entry.source, code: entry.code }
  },
  read_snippet_globals_docs:  (_a) => readGlobalsDocs(),
  apply_snippet:              (a)  => http('POST', '/api/snippets', { targets: a.targets, id: a.id, code: a.code }),
  unload_snippet:             (a)  => http('DELETE', '/api/snippets', { targets: a.targets, id: a.id }),
  save_snippet:               (a)  => http('POST', '/api/snippets/save', { id: a.id, code: a.code, dir: a.dir }),
  set_state:                  (a)  => http('POST', '/api/state', { targets: a.targets, key: a.key, value: a.value }),
  get_recent_events:    async (a)  => getRecentEvents(a?.limit ?? 50),
  get_viewer_url: async       (a)  => {
    const p = await http('GET', `/api/players/${encodeURIComponent(a.username)}`)
    if (!p?.viewerPort) throw new Error(`bot "${a.username}" has no viewer port (prismarine-viewer not loaded or bot not spawned)`)
    return { url: `http://localhost:${p.viewerPort}/`, viewerPort: p.viewerPort, username: p.username }
  }
}

const server = new Server(
  { name: 'overflayer', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  const handler = HANDLERS[name]
  if (!handler) {
    return {
      isError: true,
      content: [{ type: 'text', text: `unknown tool: ${name}` }]
    }
  }
  try {
    const result = await handler(args)
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    return { content: [{ type: 'text', text }] }
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: String(err && err.message ? err.message : err) }]
    }
  }
})

async function main () {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(err => {
  // stderr only — never write to stdout (reserved for JSON-RPC frames).
  process.stderr.write(`[overflayer-mcp] fatal: ${err && err.stack ? err.stack : err}\n`)
  process.exit(1)
})

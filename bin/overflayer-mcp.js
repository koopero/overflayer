#!/usr/bin/env node
'use strict'

const { createServer: createHttpServer } = require('http')
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js')

// Shared tool schema + globals-docs reader. Keeps the stdio path and the
// in-process Nuxt route (server/api/mcp.*.ts) in sync.
const { TOOLS, readGlobalsDocs } = require('../lib/mcpTools.js')

const BASE = (process.env.OVERFLAYER_URL || 'http://localhost:3000').replace(/\/+$/, '')

async function http (method, route, body) {
  const url = `${BASE}${route}`
  const init = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  let res
  try {
    res = await fetch(url, init)
  } catch (err) {
    // fetch() throws a TypeError with the real reason (ECONNREFUSED, DNS, etc.)
    // hidden in err.cause. Surface it so callers don't just see "fetch failed".
    const cause = err && err.cause
    const detail = cause && (cause.code || cause.message)
      ? `${cause.code || ''}${cause.code && cause.message ? ': ' : ''}${cause.message || ''}`.trim()
      : (err && err.message) || String(err)
    throw new Error(`${method} ${url} failed to connect: ${detail} (is the overflayer server running at ${BASE}?)`)
  }
  const text = await res.text()
  if (!res.ok) {
    let msg = res.statusText || `HTTP ${res.status}`
    try { msg = JSON.parse(text).statusMessage || JSON.parse(text).message || msg } catch (_) {}
    throw new Error(`${method} ${route} → ${res.status} ${msg}`)
  }
  if (!text) return null
  try { return JSON.parse(text) } catch (_) { return text }
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

// Tool schema lives in lib/mcpTools.js so the stdio (this file) and HTTP
// (server/api/mcp.*.ts) transports advertise the exact same surface.

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

// Factory so each transport (stdio: one instance; http: one per request in stateless mode)
// gets its own Server with handlers registered.
function createMcpServer () {
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

  return server
}

// ---- transports ----

async function runStdio () {
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

async function runHttp (port, host) {
  // Stateless: each POST/GET to /mcp gets its own Server + Transport pair, no
  // session state carried across requests. Simpler and matches the SDK's
  // documented stateless pattern.
  const httpServer = createHttpServer(async (req, res) => {
    // CORS + health probes
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, mcp-session-id, mcp-protocol-version'
      })
      res.end()
      return
    }
    const url = req.url || '/'
    if (url === '/' || url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, name: 'overflayer-mcp', endpoint: '/mcp' }))
      return
    }
    if (!url.startsWith('/mcp')) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found — MCP endpoint is at /mcp')
      return
    }

    const server = createMcpServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
      // Clean up after the response cycle completes.
      res.on('close', () => {
        try { transport.close() } catch (_) {}
        try { server.close() } catch (_) {}
      })
    } catch (err) {
      process.stderr.write(`[overflayer-mcp] http handler error: ${err && err.stack ? err.stack : err}\n`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(err && err.message ? err.message : err) }))
      }
    }
  })

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject)
      resolve()
    })
  })
  // Stderr only to avoid corrupting any wrapping stdio listener.
  process.stderr.write(`[overflayer-mcp] listening on http://${host}:${port}/mcp\n`)
}

// ---- arg/env parsing ----

function parseArgs (argv) {
  const out = { http: null, host: '127.0.0.1' }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--http' || a === '-h') {
      const next = argv[i + 1]
      const p = Number(next)
      if (!next || Number.isNaN(p)) throw new Error('--http requires a port number')
      out.http = p
      i++
    } else if (a.startsWith('--http=')) {
      const p = Number(a.slice(7))
      if (Number.isNaN(p)) throw new Error('--http requires a port number')
      out.http = p
    } else if (a === '--host') {
      out.host = argv[++i]
    } else if (a.startsWith('--host=')) {
      out.host = a.slice(7)
    } else if (a === '--help') {
      process.stderr.write([
        'Usage: overflayer-mcp [--http <port>] [--host <addr>]',
        '',
        '  stdio (default): JSON-RPC frames over stdin/stdout',
        '  --http <port>:   listen for MCP requests at http://<host>:<port>/mcp',
        '  --host <addr>:   bind host for HTTP mode (default 127.0.0.1)',
        '',
        'Env vars:',
        '  OVERFLAYER_URL    base URL for the overflayer REST API (default http://localhost:3000)',
        '  MCP_HTTP_PORT     equivalent to --http',
        '  MCP_HTTP_HOST     equivalent to --host',
        ''
      ].join('\n'))
      process.exit(0)
    }
  }
  if (out.http == null && process.env.MCP_HTTP_PORT) {
    const p = Number(process.env.MCP_HTTP_PORT)
    if (Number.isNaN(p)) throw new Error('MCP_HTTP_PORT must be a number')
    out.http = p
  }
  if (process.env.MCP_HTTP_HOST) out.host = process.env.MCP_HTTP_HOST
  return out
}

async function main () {
  const opts = parseArgs(process.argv)
  if (opts.http) await runHttp(opts.http, opts.host)
  else await runStdio()
}

main().catch(err => {
  // stderr only — never write to stdout (reserved for JSON-RPC frames in stdio mode).
  process.stderr.write(`[overflayer-mcp] fatal: ${err && err.stack ? err.stack : err}\n`)
  process.exit(1)
})

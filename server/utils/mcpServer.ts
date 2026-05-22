import { createRequire } from 'node:module'
import { manager } from './manager'

// Pull CJS deps via createRequire — both the MCP SDK and our shared tool
// schema are CommonJS, while this file is compiled as ESM by Nitro.
const req = createRequire(import.meta.url)
const { Server } = req('@modelcontextprotocol/sdk/server/index.js')
const { StreamableHTTPServerTransport } = req('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { ListToolsRequestSchema, CallToolRequestSchema } = req('@modelcontextprotocol/sdk/types.js')
const { TOOLS, readGlobalsDocs } = req('../../lib/mcpTools.js')

// Direct-manager handlers — no HTTP loopback. Mirrors the surface area
// exposed by the stdio bin script, but reads/writes the SessionManager
// in-process.
function createHandlers () {
  const m = () => manager()
  return {
    list_players: () => m().list(),
    get_player: (a: any) => {
      const p = m().get(a.username)
      if (!p) throw new Error(`no such player: ${a.username}`)
      return p
    },
    list_catalog: () => m().catalogView(),
    list_snippet_dirs: () => m().snippetDirs,
    read_snippet: (a: any) => {
      const entry = m().catalogView().find((e: any) => e.id === a.id)
      if (!entry) throw new Error(`no catalog entry with id "${a.id}"`)
      return { id: entry.id, kind: entry.kind, source: entry.source, code: entry.code }
    },
    read_snippet_globals_docs: () => readGlobalsDocs(),
    apply_snippet: async (a: any) => {
      const results = await m().loadSnippet({ targets: a.targets, id: a.id, code: a.code })
      return { id: a.id, results }
    },
    unload_snippet: (a: any) => ({ id: a.id, results: m().unloadSnippet({ targets: a.targets, id: a.id }) }),
    save_snippet: (a: any) => m().saveSnippetToDir({ id: a.id, code: a.code, dir: a.dir }),
    set_state: (a: any) => ({ key: a.key, results: m().setState({ targets: a.targets, key: a.key, value: a.value }) }),
    get_recent_events: (a: any) => {
      const limit = Math.min(Math.max(a?.limit ?? 50, 1), 500)
      return m().recentEvents(limit)
    },
    get_viewer_url: (a: any) => {
      const p = m().get(a.username)
      if (!p?.viewerPort) throw new Error(`bot "${a.username}" has no viewer port (prismarine-viewer not loaded or bot not spawned)`)
      return { url: `http://localhost:${p.viewerPort}/`, viewerPort: p.viewerPort, username: a.username }
    }
  } as Record<string, (a: any) => any>
}

function buildServer () {
  const server = new Server(
    { name: 'overflayer', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  const handlers = createHandlers()
  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    const { name, arguments: args = {} } = req.params
    const fn = handlers[name]
    if (!fn) {
      return { isError: true, content: [{ type: 'text', text: `unknown tool: ${name}` }] }
    }
    try {
      const result = await fn(args)
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      return { content: [{ type: 'text', text }] }
    } catch (err: any) {
      return { isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] }
    }
  })
  return server
}

// Stateless: each request gets its own Server + Transport pair. The handler
// writes the response directly to event.node.res and resolves once the
// response cycle is finished.
export async function handleMcpRequest (event: any, parsedBody?: any) {
  const nodeReq = event.node.req
  const nodeRes = event.node.res

  const server = buildServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  const cleanup = () => {
    try { transport.close() } catch (_) {}
    try { server.close() } catch (_) {}
  }

  try {
    await server.connect(transport)
    await transport.handleRequest(nodeReq, nodeRes, parsedBody)
  } catch (err: any) {
    if (!nodeRes.headersSent) {
      nodeRes.statusCode = 500
      nodeRes.setHeader('content-type', 'application/json')
      nodeRes.end(JSON.stringify({ error: String(err?.message ?? err) }))
    }
    cleanup()
    return
  }

  // Wait for the response to finish, then clean up. handleRequest may return
  // before the body is fully flushed (especially for SSE), so we hook 'finish'
  // and 'close' on the response.
  await new Promise<void>((resolve) => {
    if (nodeRes.writableEnded) { cleanup(); resolve(); return }
    const done = () => { cleanup(); resolve() }
    nodeRes.once('close', done)
    nodeRes.once('finish', done)
  })
}

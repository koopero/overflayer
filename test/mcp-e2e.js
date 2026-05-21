#!/usr/bin/env node
'use strict'

// End-to-end MCP test against the running dev server (localhost:3000).
// Spawns the MCP bin and drives it through a realistic sequence.

const path = require('path')
const { spawn } = require('child_process')
const assert = require('assert')

const BIN = path.resolve(__dirname, '..', 'bin', 'overflayer-mcp.js')

function client () {
  const child = spawn('node', [BIN], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, OVERFLAYER_URL: 'http://localhost:3000' } })
  let buf = '', stderr = ''
  const pend = new Map(); let id = 1
  child.stderr.on('data', d => { stderr += d.toString() })
  child.stdout.on('data', chunk => {
    buf += chunk.toString()
    const lines = buf.split('\n'); buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      let m; try { m = JSON.parse(line) } catch (_) { continue }
      if (m.id !== undefined && pend.has(m.id)) {
        const p = pend.get(m.id); pend.delete(m.id)
        if (m.error) p.reject(new Error(m.error.message))
        else p.resolve(m.result)
      }
    }
  })
  function call (method, params) {
    const i = id++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
    return new Promise((resolve, reject) => {
      pend.set(i, { resolve, reject })
      setTimeout(() => { if (pend.has(i)) { pend.delete(i); reject(new Error(`timeout ${method} (stderr: ${stderr.slice(-200)})`)) } }, 10000)
    })
  }
  function call_tool (name, args) {
    return call('tools/call', { name, arguments: args }).then(r => {
      if (r.isError) throw new Error(r.content[0].text)
      const text = r.content[0].text
      try { return JSON.parse(text) } catch (_) { return text }
    })
  }
  function close () { try { child.stdin.end(); child.kill() } catch (_) {} }
  return { call, call_tool, close }
}

async function main () {
  const c = client()
  await c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })

  console.log('-- list_players')
  const players = await c.call_tool('list_players', {})
  assert.strictEqual(players.length, 12)
  console.log(`  ${players.length} players; first: ${players[0].username} (${players[0].status})`)

  console.log('-- list_catalog')
  const cat0 = await c.call_tool('list_catalog', {})
  const fileCount = cat0.filter(e => e.kind === 'file').length
  console.log(`  catalog: ${cat0.length} entries (${fileCount} file-backed)`)

  console.log('-- read_snippet { id: "scatter" }')
  const scatter = await c.call_tool('read_snippet', { id: 'scatter' })
  assert.strictEqual(scatter.id, 'scatter')
  assert.ok(scatter.code.includes("kind: 'arrived'"), 'scatter code should mention arrived report')
  console.log(`  scatter code: ${scatter.code.length} chars, source: ${scatter.source}`)

  console.log('-- read_snippet_globals_docs')
  const docsText = await c.call_tool('read_snippet_globals_docs', {})
  assert.ok(docsText.includes('Injected Globals'))
  assert.ok(docsText.includes('Vec3'))
  console.log(`  docs: ${docsText.length} chars`)

  console.log('-- apply_snippet announce → all')
  const applied = await c.call_tool('apply_snippet', { targets: 'all', id: 'announce', code: 'snippets/shared/announce.js' })
  const ok = applied.results.filter(r => r.ok).length
  console.log(`  applied: ${ok}/${applied.results.length}`)
  assert.ok(ok >= 1)

  console.log('-- list_catalog (post-apply)')
  const cat1 = await c.call_tool('list_catalog', {})
  const ann = cat1.find(e => e.id === 'announce')
  console.log(`  announce loadedOn: ${ann.loadedOn.length}`)
  assert.ok(ann.loadedOn.length >= 1)

  console.log('-- unload_snippet announce → all')
  const unloaded = await c.call_tool('unload_snippet', { targets: 'all', id: 'announce' })
  const okU = unloaded.results.filter(r => r.ok).length
  console.log(`  unloaded: ${okU}/${unloaded.results.length}`)

  console.log('-- get_recent_events { limit: 5 }')
  const events = await c.call_tool('get_recent_events', { limit: 5 })
  console.log(`  got ${events.length} events; latest type: ${events[events.length - 1]?.type}`)
  assert.ok(events.length > 0)

  console.log('-- get_viewer_url (first spawned bot)')
  const spawned = players.find(p => p.status === 'spawned' && p.viewerPort)
  if (spawned) {
    const vu = await c.call_tool('get_viewer_url', { username: spawned.username })
    assert.match(vu.url, /^http:\/\/localhost:\d+\/$/)
    console.log(`  ${spawned.username} → ${vu.url}`)
  } else {
    console.log('  (no spawned bot with viewer port — skipping)')
  }

  c.close()
  console.log('\nALL OK')
}

main().catch(err => { console.error('FAIL', err); process.exit(1) })

#!/usr/bin/env node
'use strict'

const path = require('path')
const { spawn } = require('child_process')
const assert = require('assert')

const BIN = path.resolve(__dirname, '..', 'bin', 'overflayer-mcp.js')

const EXPECTED_TOOLS = new Set([
  'list_players', 'get_player', 'list_catalog', 'list_snippet_dirs',
  'read_snippet', 'read_snippet_globals_docs',
  'apply_snippet', 'unload_snippet', 'save_snippet',
  'set_state', 'get_recent_events', 'get_viewer_url'
])

function createClient () {
  const child = spawn('node', [BIN], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OVERFLAYER_URL: 'http://127.0.0.1:1' } // unreachable on purpose
  })

  let stderr = ''
  child.stderr.on('data', d => { stderr += d.toString() })

  let buffer = ''
  const pending = new Map() // id -> {resolve, reject}
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch (_) { continue }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else p.resolve(msg.result)
      }
    }
  })

  let nextId = 1
  function call (method, params) {
    const id = nextId++
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    child.stdin.write(frame)
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout on ${method} (stderr: ${stderr.slice(-200)})`)) }
      }, 5000)
    })
  }
  function close () {
    try { child.stdin.end() } catch (_) {}
    try { child.kill() } catch (_) {}
  }
  return { call, close, get stderr () { return stderr } }
}

let passed = 0, failed = 0
async function test (name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) }
  catch (err) { failed++; console.error(`  FAIL ${name}\n      ${err.stack || err}`) }
}

async function main () {
  console.log('Overflayer MCP smoke tests')
  const c = createClient()

  await test('initialize handshake', async () => {
    const r = await c.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0.0.1' }
    })
    assert.ok(r.serverInfo?.name === 'overflayer')
  })

  await test('tools/list returns 12 expected tools', async () => {
    const r = await c.call('tools/list', {})
    const names = new Set(r.tools.map(t => t.name))
    assert.strictEqual(r.tools.length, EXPECTED_TOOLS.size)
    for (const expected of EXPECTED_TOOLS) {
      assert.ok(names.has(expected), `missing tool: ${expected}`)
    }
    // Spot-check schemas
    const apply = r.tools.find(t => t.name === 'apply_snippet')
    assert.ok(apply.inputSchema?.properties?.targets)
    assert.ok(apply.inputSchema.required.includes('id'))
  })

  await test('read_snippet_globals_docs returns README slice', async () => {
    const r = await c.call('tools/call', { name: 'read_snippet_globals_docs', arguments: {} })
    assert.strictEqual(r.isError, undefined, `got error: ${JSON.stringify(r)}`)
    const text = r.content[0].text
    assert.ok(text.includes('### Injected Globals'), 'expected header in slice')
    assert.ok(text.includes('sleep'), 'expected sleep mentioned')
    assert.ok(text.includes('run'), 'expected run mentioned')
  })

  await test('unknown tool returns isError', async () => {
    const r = await c.call('tools/call', { name: 'nope', arguments: {} })
    assert.strictEqual(r.isError, true)
    assert.match(r.content[0].text, /unknown tool/)
  })

  await test('HTTP-backed tool surfaces transport error gracefully', async () => {
    // OVERFLAYER_URL points at 127.0.0.1:1 so this must fail without crashing.
    const r = await c.call('tools/call', { name: 'list_players', arguments: {} })
    assert.strictEqual(r.isError, true)
    assert.ok(r.content[0].text.length > 0)
  })

  c.close()
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })

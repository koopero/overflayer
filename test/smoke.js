'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const { EventEmitter } = require('events')

const Overflayer = require('..')
const { ScopeDisposedError } = require('..')

function makeFakeBot () {
  const bot = new EventEmitter()
  bot.username = 'TestBot'
  bot.chat = (msg) => { bot.lastChat = msg; bot.emit('_chatSent', msg) }
  bot.entity = { position: { x: 0, y: 64, z: 0 } }
  bot.players = {}
  bot.inventory = { items: () => [] }
  bot.food = 20
  return bot
}

function delay (ms) { return new Promise(r => setTimeout(r, ms)) }

let passed = 0
let failed = 0
async function test (name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}\n      ${err && err.stack ? err.stack : err}`)
  }
}

async function main () {
  console.log('Overflayer smoke tests')

  // --- 1. Inline load + chat listener fires
  await test('inline snippet: chat listener responds', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    await ov.load('greeter', `bot.on('chat', (u, m) => { if (m === 'hi') bot.chat('hello ' + u) })`)
    bot.emit('chat', 'alice', 'hi')
    await delay(10)
    assert.strictEqual(bot.lastChat, 'hello alice')
    await ov.close()
  })

  // --- 2. Listener tracking + cleanup on unload
  await test('unload removes only this snippet\'s listeners', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    // Pre-existing host listener — must survive unload.
    let hostHits = 0
    bot.on('chat', () => hostHits++)

    await ov.load('s', `bot.on('chat', () => bot.chat('s-fired'))`)
    assert.strictEqual(bot.listenerCount('chat'), 2)

    bot.emit('chat', 'a', 'x')
    await delay(5)
    assert.strictEqual(bot.lastChat, 's-fired')
    assert.strictEqual(hostHits, 1)

    assert.strictEqual(ov.unload('s'), true)
    assert.strictEqual(bot.listenerCount('chat'), 1)

    bot.lastChat = null
    bot.emit('chat', 'a', 'x')
    await delay(5)
    assert.strictEqual(bot.lastChat, null, 'snippet listener should be gone')
    assert.strictEqual(hostHits, 2, 'host listener should still run')
  })

  // --- 3. Hot reload replaces listeners
  await test('hot reload replaces listeners', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    await ov.load('s', `bot.on('chat', () => bot.chat('v1'))`)
    bot.emit('chat', 'a', 'x'); await delay(5)
    assert.strictEqual(bot.lastChat, 'v1')

    await ov.load('s', `bot.on('chat', () => bot.chat('v2'))`)
    assert.strictEqual(bot.listenerCount('chat'), 1)
    bot.emit('chat', 'a', 'x'); await delay(5)
    assert.strictEqual(bot.lastChat, 'v2')
    await ov.close()
  })

  // --- 4. sleep() rejects with ScopeDisposedError on unload
  await test('sleep rejects with ScopeDisposedError when snippet is unloaded', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    let observed = null
    await ov.load('s', `
      run(async () => {
        try { await sleep(5000) }
        catch (e) { bot.emit('_sleepResult', e) }
      })
    `)
    bot.on('_sleepResult', (e) => { observed = e })
    await delay(10)
    ov.unload('s')
    await delay(20)
    assert.ok(observed instanceof Error, 'should observe rejection')
    assert.strictEqual(observed.name, 'ScopeDisposedError')
  })

  // --- 5. interval cleared on unload
  await test('interval is cleared on unload', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    let ticks = 0
    bot.tick = () => ticks++
    await ov.load('s', `interval(10, () => bot.tick())`)
    await delay(55)
    const before = ticks
    assert.ok(before >= 2, 'interval should fire multiple times')
    ov.unload('s')
    await delay(50)
    assert.strictEqual(ticks, before, 'interval should not fire after unload')
  })

  // --- 6. Blocked globals are undefined
  await test('blocked globals (require, process, ...) are undefined inside snippet', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    let captured = null
    bot.report = (v) => { captured = v }
    await ov.load('s', `
      bot.report({
        require: typeof require,
        process: typeof process,
        module: typeof module,
        __dirname: typeof __dirname,
        __filename: typeof __filename,
        global: typeof global,
        exports: typeof exports
      })
    `)
    assert.deepStrictEqual(captured, {
      require: 'undefined', process: 'undefined', module: 'undefined',
      __dirname: 'undefined', __filename: 'undefined', global: 'undefined', exports: 'undefined'
    })
  })

  // --- 7. inject extra globals
  await test('options.inject merges into snippet globals', async () => {
    const bot = makeFakeBot()
    const myThing = { ping: () => 'pong' }
    const ov = new Overflayer(bot, { inject: { myThing } })
    let result = null
    bot.report = (v) => { result = v }
    await ov.load('s', `bot.report(myThing.ping())`)
    assert.strictEqual(result, 'pong')
  })

  // --- 8. errorHandler captures listener exceptions; bot stays up
  await test('runtime listener errors are routed to errorHandler', async () => {
    const bot = makeFakeBot()
    const errors = []
    const ov = new Overflayer(bot, {
      errorHandler: (id, err) => errors.push([id, err.message])
    })
    await ov.load('boom', `bot.on('chat', () => { throw new Error('kaboom') })`)
    bot.emit('chat', 'a', 'x')
    await delay(10)
    assert.strictEqual(errors.length, 1)
    assert.strictEqual(errors[0][0], 'boom')
    assert.match(errors[0][1], /kaboom/)
  })

  // --- 9. Sync load error rejects the load promise
  await test('synchronous load error rejects load() and registers nothing', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    let threw = null
    try { await ov.load('bad', `throw new Error('nope')`) } catch (e) { threw = e }
    assert.ok(threw, 'should reject')
    assert.match(threw.message, /nope/)
    assert.deepStrictEqual(ov.inspect(), [])
  })

  // --- 10. Load from file + reload from disk
  await test('load from file path and reload re-reads disk', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overflayer-'))
    const file = path.join(dir, 'greeter.js')
    fs.writeFileSync(file, `bot.on('chat', () => bot.chat('disk-v1'))`)
    await ov.load('greeter', file)
    bot.emit('chat', 'a', 'x'); await delay(5)
    assert.strictEqual(bot.lastChat, 'disk-v1')

    fs.writeFileSync(file, `bot.on('chat', () => bot.chat('disk-v2'))`)
    await ov.reload('greeter')
    bot.emit('chat', 'a', 'x'); await delay(5)
    assert.strictEqual(bot.lastChat, 'disk-v2')

    await ov.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // --- 11. inspect()
  await test('inspect() reports id, source, listenerCount', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    await ov.load('a', `bot.on('chat', () => {}); bot.on('move', () => {})`)
    await ov.load('b', `bot.on('chat', () => {})`)
    const snap = ov.inspect()
    const a = snap.find(s => s.id === 'a')
    const b = snap.find(s => s.id === 'b')
    assert.strictEqual(a.listenerCount, 2)
    assert.strictEqual(b.listenerCount, 1)
    assert.strictEqual(a.source, '<inline>')
    assert.ok(typeof a.loadedAt === 'number')
    await ov.close()
  })

  await test('SessionManager player summaries omit snippet source code', async () => {
    const { SessionManager } = require('../lib/SessionManager.js')
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    const code = `bot.on('chat', () => bot.chat('secret'))`
    await ov.load('secret', code)

    const sm = new SessionManager()
    sm.config = { server: { host: 'localhost' }, players: [] }
    sm.sessions.set('TestBot', { config: { username: 'TestBot' }, bot, ov, status: 'spawned' })

    const listed = sm.list()[0]
    const detail = sm.get('TestBot')
    assert.strictEqual(listed.snippets[0].code, undefined)
    assert.strictEqual(detail.snippets[0].code, undefined)
    assert.strictEqual(detail.snippets[0].codeLength, code.length)
    assert.strictEqual(ov.inspect()[0].code, code)

    await ov.close()
  })

  // --- 12. bot.end() and bot.quit() are denied
  await test('bot.end() / bot.quit() throw in snippet scope', async () => {
    const bot = makeFakeBot()
    bot.end = () => { throw new Error('should not be called') }
    bot.quit = () => { throw new Error('should not be called') }
    const errors = []
    const ov = new Overflayer(bot, { errorHandler: (id, e) => errors.push(e.message) })
    let threw = null
    try {
      await ov.load('bad', `bot.end()`)
    } catch (e) { threw = e }
    assert.ok(threw, 'sync throw should propagate')
    assert.match(threw.message, /not available in snippet scope/)
  })

  // --- 13. Watcher autoloads + reloads from a directory (uses chokidar)
  await test('watcher autoloads files and reloads on change', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot, { watchDebounce: 30 })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overflayer-watch-'))
    const file = path.join(dir, 'hi.js')
    fs.writeFileSync(file, `bot.on('chat', () => bot.chat('w-v1'))`)
    const watcher = ov.watch(dir)
    // Wait for autoLoad
    for (let i = 0; i < 50 && !ov.snippets.has('hi'); i++) await delay(20)
    assert.ok(ov.snippets.has('hi'), 'should autoload existing file')
    bot.emit('chat', 'a', 'x'); await delay(5)
    assert.strictEqual(bot.lastChat, 'w-v1')

    // Modify the file
    fs.writeFileSync(file, `bot.on('chat', () => bot.chat('w-v2'))`)
    // Wait for debounce + reload
    let got = null
    for (let i = 0; i < 80; i++) {
      bot.lastChat = null
      bot.emit('chat', 'a', 'x')
      await delay(5)
      if (bot.lastChat === 'w-v2') { got = bot.lastChat; break }
      await delay(20)
    }
    assert.strictEqual(got, 'w-v2', 'watcher should reload on change')

    // Delete the file
    fs.unlinkSync(file)
    for (let i = 0; i < 50 && ov.snippets.has('hi'); i++) await delay(20)
    assert.ok(!ov.snippets.has('hi'), 'watcher should unload on remove')

    await watcher.stop()
    await ov.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // --- 14. ScopeDisposedError is exported and recognizable inside snippets
  await test('ScopeDisposedError is catchable inside snippets', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    let result = null
    bot.report = (v) => { result = v }
    await ov.load('s', `
      run(async () => {
        try { await sleep(5000) }
        catch (e) { bot.report(e instanceof ScopeDisposedError ? 'caught' : 'other:' + e.name) }
      })
    `)
    await delay(10)
    ov.unload('s')
    await delay(20)
    assert.strictEqual(result, 'caught')
    assert.ok(ScopeDisposedError.prototype instanceof Error)
  })

  // --- 16. stop(): snippet can request self-unload
  await test('stop() unloads the snippet and emits stop + unload', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    const stops = []
    const unloads = []
    ov.on('stop', (id, reason) => stops.push([id, reason]))
    ov.on('unload', (id) => unloads.push(id))

    await ov.load('selfstop', `
      bot.on('chat', (u, m) => {
        if (m === 'die') stop('asked to die')
      })
    `)
    assert.strictEqual(bot.listenerCount('chat'), 1)
    bot.emit('chat', 'a', 'die')
    await delay(15)
    assert.deepStrictEqual(stops, [['selfstop', 'asked to die']])
    assert.deepStrictEqual(unloads, ['selfstop'])
    assert.strictEqual(bot.listenerCount('chat'), 0)
    assert.strictEqual(ov.inspect().length, 0)
  })

  await test('stop() inside run() lets the current frame finish', async () => {
    const bot = makeFakeBot()
    let after = false
    bot.markAfter = () => { after = true }
    const ov = new Overflayer(bot)
    await ov.load('s', `
      run(async () => {
        stop('done')
        // Synchronous code following stop() should still run; only the next
        // tick disposes the scope.
        bot.markAfter()
      })
    `)
    await delay(15)
    assert.strictEqual(after, true, 'code after stop() in the same tick should still execute')
    assert.strictEqual(ov.inspect().length, 0, 'snippet should be unloaded by now')
  })

  await test('stop() is idempotent (calling twice does nothing extra)', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    const stops = []
    ov.on('stop', (id, reason) => stops.push(reason))
    await ov.load('s', `stop('first'); stop('second')`)
    await delay(15)
    assert.deepStrictEqual(stops, ['first'])
    assert.strictEqual(ov.inspect().length, 0)
  })

  // --- state(): player-level state shared across behaviors
  await test('declareState initialises from default', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    let captured = null
    bot.report = (v) => { captured = v }
    await ov.load('s', `
      declareState('target', { type: 'player', default: 'rotiboater', export: true })
      bot.report(stateGet('target'))
    `)
    assert.strictEqual(captured, 'rotiboater')
    const ps = ov.playerState()
    assert.deepStrictEqual(ps.target, { type: 'player', value: 'rotiboater', exported: true, declaredBy: ['s'] })
  })

  await test('stateGet/stateSet read and write player-level state', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    const log = []
    bot.log = (v) => log.push(v)
    await ov.load('s', `
      declareState('count', { type: 'number', default: 0 })
      bot.log(stateGet('count'))
      stateSet('count', 5)
      bot.log(stateGet('count'))
    `)
    assert.deepStrictEqual(log, [0, 5])
  })

  await test('state persists across hot-reload of the same id', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    await ov.load('s', `
      declareState('count', { type: 'number', default: 0 })
      stateSet('count', 7)
    `)
    assert.strictEqual(ov.playerState().count.value, 7)
    let observed = null
    bot.report = (v) => { observed = v }
    await ov.load('s', `
      declareState('count', { type: 'number', default: 0 })
      bot.report(stateGet('count'))
    `)
    assert.strictEqual(observed, 7, 'value should survive hot-reload')
    assert.strictEqual(ov.playerState().count.value, 7)
  })

  await test('player state persists across explicit unload (player-level semantics)', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    await ov.load('s', `declareState('x', { type: 'number', default: 1 }); stateSet('x', 99)`)
    assert.strictEqual(ov.playerState().x.value, 99)
    // Explicit unload with keepState=true (default for hot-reload path) — value survives.
    ov.unload('s', { keepState: true })
    let observed = null
    bot.report = (v) => { observed = v }
    await ov.load('s', `declareState('x', { type: 'number', default: 1 }); bot.report(stateGet('x'))`)
    assert.strictEqual(observed, 99, 'player-level state survives reload')
  })

  await test('explicit unload without keepState prunes undeclared keys', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    await ov.load('s', `declareState('x', { type: 'number', default: 1 }); stateSet('x', 99)`)
    assert.strictEqual(ov.playerState().x.value, 99)
    ov.unload('s') // keepState defaults to false — prunes orphaned key
    assert.strictEqual(ov.playerState().x, undefined, 'orphaned key removed on explicit unload')
    let observed = null
    bot.report = (v) => { observed = v }
    await ov.load('s', `declareState('x', { type: 'number', default: 1 }); bot.report(stateGet('x'))`)
    assert.strictEqual(observed, 1, 'fresh load gets default after prune')
  })

  await test('two behaviors sharing a key read the same value', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    await ov.load('a', `declareState('target', { type: 'player', export: true, default: 'alice' })`)
    await ov.load('b', `declareState('target', { type: 'player', export: true })`)
    // Both declare same key — value set by a persists for b
    assert.strictEqual(ov.playerState().target.value, 'alice')
    assert.deepStrictEqual(ov.playerState().target.declaredBy.sort(), ['a', 'b'])
  })

  await test('setExportedState rejects non-exported keys, accepts exported', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    const stateEvents = []
    ov.on('state', (key, value, meta) => stateEvents.push({ key, value, source: meta.source }))
    await ov.load('s', `
      declareState('priv', { type: 'string', default: 'a' })
      declareState('pub',  { type: 'string', default: 'b', export: true })
    `)

    assert.throws(() => ov.setExportedState('priv', 'x'), /not exported/)
    assert.throws(() => ov.setExportedState('missing', 'x'), /not configured/)

    const before = stateEvents.length
    ov.setExportedState('pub', 'updated')
    assert.strictEqual(ov.playerState().pub.value, 'updated')
    const newEvts = stateEvents.slice(before)
    assert.strictEqual(newEvts.length, 1)
    assert.deepStrictEqual(newEvts[0], { key: 'pub', value: 'updated', source: 'api' })
  })

  // --- 15. report(): snippets push data up to Overflayer
  await test('report() emits on overflayer and updates inspect()', async () => {
    const bot = makeFakeBot()
    const ov = new Overflayer(bot)
    const seen = []
    ov.on('report', (id, payload) => seen.push([id, payload]))
    await ov.load('r', `
      report('hello')
      report({ x: 1, y: 2 })
      report('a', 'b', 'c')
    `)
    await delay(10)
    assert.deepStrictEqual(seen[0], ['r', 'hello'])
    assert.deepStrictEqual(seen[1], ['r', { x: 1, y: 2 }])
    assert.deepStrictEqual(seen[2], ['r', ['a', 'b', 'c']])

    const snap = ov.inspect()[0]
    assert.strictEqual(snap.reportCount, 3)
    assert.deepStrictEqual(snap.lastReport, ['a', 'b', 'c'])
    assert.ok(typeof snap.lastReportAt === 'number')

    // After unload, late report() calls are no-ops.
    ov.unload('r')
    await delay(5)
    // Nothing further added:
    assert.strictEqual(seen.length, 3)
  })

  // --- catalog: boot scan, change/delete propagation
  await test('catalog: boot scan discovers .js files without loading them', async () => {
    const { SessionManager } = require('../lib/SessionManager.js')
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'overflayer-cat-'))
    const dir1 = path.join(tmpRoot, 'a'); fs.mkdirSync(dir1)
    fs.writeFileSync(path.join(dir1, 'alpha.js'), `report("alpha")`)
    fs.writeFileSync(path.join(dir1, 'beta.js'),  `report("beta")`)

    const sm = new SessionManager()
    sm.config = { snippet_dirs: [{ path: dir1 }], players: [] }
    sm.snippetDirs = sm._normalizeSnippetDirs(sm.config.snippet_dirs)
    sm._scanCatalog()

    const view = sm.catalogView()
    assert.strictEqual(view.length, 2)
    assert.deepStrictEqual(view.map(v => v.id).sort(), ['alpha', 'beta'])
    assert.strictEqual(view.every(v => v.kind === 'file'), true)
    assert.strictEqual(view.every(v => v.loadedOn.length === 0), true, 'discovery must not load anything')

    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  await test('catalog: file change hot-reloads only sessions that have it loaded', async () => {
    const { SessionManager } = require('../lib/SessionManager.js')
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'overflayer-cat-'))
    const dir1 = path.join(tmpRoot, 'a'); fs.mkdirSync(dir1)
    const file = path.join(dir1, 'demo.js')
    fs.writeFileSync(file, `bot.report("v1")`)

    // Two synthetic sessions, each with a real Overflayer wrapping a fake bot.
    const botA = makeFakeBot(); botA.report = (v) => { botA.last = v }
    const botB = makeFakeBot(); botB.report = (v) => { botB.last = v }
    const ovA = new Overflayer(botA)
    const ovB = new Overflayer(botB)

    const sm = new SessionManager()
    sm.config = { snippet_dirs: [{ path: dir1 }], players: [] }
    sm.snippetDirs = sm._normalizeSnippetDirs(sm.config.snippet_dirs)
    sm._scanCatalog()
    sm.sessions.set('A', { config: { username: 'A' }, bot: botA, ov: ovA, status: 'spawned' })
    sm.sessions.set('B', { config: { username: 'B' }, bot: botB, ov: ovB, status: 'spawned' })

    // Apply to A only.
    const code = sm.catalog.get('demo').code
    await ovA.load('demo', code === '' ? code : file)
    // Run the synchronous bot.report from snippet:
    assert.strictEqual(botA.last, 'v1')
    assert.strictEqual(botB.last, undefined)

    // Directly mutate the file and invoke the propagation path the watcher would.
    fs.writeFileSync(file, `bot.report("v2")`)
    sm._upsertCatalogFile(file, sm.snippetDirs[0])
    sm._propagateChange(file)
    await delay(20)
    assert.strictEqual(botA.last, 'v2', 'A should hot-reload to v2')
    assert.strictEqual(botB.last, undefined, 'B should not be touched')

    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  await test('catalog: file delete unloads sessions that have it', async () => {
    const { SessionManager } = require('../lib/SessionManager.js')
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'overflayer-cat-'))
    const dir1 = path.join(tmpRoot, 'a'); fs.mkdirSync(dir1)
    const file = path.join(dir1, 'ghost.js')
    fs.writeFileSync(file, `bot.report("hi")`)

    const bot = makeFakeBot(); bot.report = () => {}
    const ov = new Overflayer(bot)
    const sm = new SessionManager()
    sm.config = { snippet_dirs: [{ path: dir1 }], players: [] }
    sm.snippetDirs = sm._normalizeSnippetDirs(sm.config.snippet_dirs)
    sm._scanCatalog()
    sm.sessions.set('A', { config: { username: 'A' }, bot, ov, status: 'spawned' })

    await ov.load('ghost', file)
    assert.strictEqual(ov.inspect().length, 1)

    sm._removeCatalogFile(file)
    assert.strictEqual(sm.catalog.has('ghost'), false)
    assert.strictEqual(ov.inspect().length, 0, 'session should be unloaded after file delete')

    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  // --- snippet_dirs: SessionManager normalizes, auto-mkdirs writable dirs, saveSnippetToDir works
  await test('SessionManager saveSnippetToDir writes a file to a writable dir', async () => {
    const { SessionManager } = require('../lib/SessionManager.js')
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'overflayer-sd-'))
    const writableDir = path.join(tmpRoot, 'writable')   // does NOT exist yet
    const readOnlyDir = path.join(tmpRoot, 'read-only')
    fs.mkdirSync(readOnlyDir)

    const sm = new SessionManager()
    sm.config = {
      snippet_dirs: [
        { path: readOnlyDir },
        { path: writableDir, writable: true }
      ],
      players: []
    }
    // start() requires mineflayer; do the side-effect we care about directly.
    sm.snippetDirs = sm._normalizeSnippetDirs(sm.config.snippet_dirs)
    // mkdir step from start():
    for (const e of sm.snippetDirs) if (e.writable) fs.mkdirSync(e.path, { recursive: true })

    assert.ok(fs.existsSync(writableDir), 'writable dir should be auto-created')
    assert.deepStrictEqual(sm.snippetDirs, [
      { path: readOnlyDir, writable: false },
      { path: writableDir, writable: true }
    ])

    // Save succeeds in writable dir.
    const out = sm.saveSnippetToDir({ id: 'demo', code: 'report("hello")', dir: writableDir })
    assert.ok(out.absolute.endsWith(path.join('writable', 'demo.js')))
    assert.strictEqual(fs.readFileSync(out.absolute, 'utf8'), 'report("hello")')

    // Negative: writable=false dir is rejected.
    assert.throws(
      () => sm.saveSnippetToDir({ id: 'demo', code: 'x', dir: readOnlyDir }),
      /not writable/
    )

    // Negative: unsafe id is rejected.
    assert.throws(
      () => sm.saveSnippetToDir({ id: '../escape', code: 'x', dir: writableDir }),
      /must match/
    )
    assert.throws(
      () => sm.saveSnippetToDir({ id: 'has space', code: 'x', dir: writableDir }),
      /must match/
    )

    // Negative: unknown dir is rejected.
    assert.throws(
      () => sm.saveSnippetToDir({ id: 'demo', code: 'x', dir: '/etc/passwd' }),
      /unknown snippet_dir/
    )

    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })

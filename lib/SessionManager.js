'use strict'

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const chokidar = require('chokidar')
const { EventEmitter } = require('events')

const Overflayer = require('..')

let mineflayer = null
try { mineflayer = require('mineflayer') } catch (_) {}

let pathfinderPlugin = null
try { pathfinderPlugin = require('mineflayer-pathfinder').pathfinder } catch (_) {}

let mineflayerViewer = null
try { mineflayerViewer = require('prismarine-viewer').mineflayer } catch (_) {}

let collectBlockPlugin = null
try { collectBlockPlugin = require('mineflayer-collectblock').plugin } catch (_) {}

const VIEWER_PORT_BASE = parseInt(process.env.OVERFLAYER_VIEWER_PORT_BASE || '4100', 10)

const MAX_EVENT_BUFFER = 500

class SessionManager extends EventEmitter {
  constructor () {
    super()
    this.sessions = new Map() // username -> { bot, ov, status, config, viewerPort }
    this.events = []          // ring buffer
    this.config = null
    this.configPath = null
    this.snippetDirs = []     // [{ path, writable }]
    this.catalog = new Map()  // id -> { id, source, absPath, code, mtime, fromDir, kind: 'file' }
    this._catalogWatchers = [] // [chokidar.FSWatcher]
    this._nextViewerPort = VIEWER_PORT_BASE
  }

  _normalizeSnippetDirs (raw) {
    if (!Array.isArray(raw)) return []
    return raw.map((e) => typeof e === 'string'
      ? { path: e, writable: false }
      : { path: e.path, writable: !!e.writable })
      .filter(e => typeof e.path === 'string' && e.path.length > 0)
  }

  saveSnippetToDir ({ id, code, dir }) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_\-]+$/.test(id)) {
      throw new Error('id must match /^[a-zA-Z0-9_\\-]+$/')
    }
    if (typeof code !== 'string') throw new Error('code is required')
    const entry = this.snippetDirs.find(e => e.path === dir)
    if (!entry) throw new Error(`unknown snippet_dir: ${dir}`)
    if (!entry.writable) throw new Error(`snippet_dir is not writable: ${dir}`)

    const abs = path.isAbsolute(entry.path) ? entry.path : path.resolve(process.cwd(), entry.path)
    fs.mkdirSync(abs, { recursive: true })
    const filePath = path.join(abs, id + '.js')
    fs.writeFileSync(filePath, code)
    const rel = path.relative(process.cwd(), filePath) || filePath
    this._record('snippet:saved', { id, dir: entry.path, path: rel })
    return { path: rel, absolute: filePath }
  }

  loadConfig (configPath) {
    const abs = path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath)
    this.configPath = abs
    this.config = yaml.load(fs.readFileSync(abs, 'utf8'))
    return this.config
  }

  start () {
    if (!mineflayer) throw new Error('mineflayer is not installed')
    if (!this.config) throw new Error('SessionManager: loadConfig() before start()')

    this.snippetDirs = this._normalizeSnippetDirs(this.config.snippet_dirs)
    for (const entry of this.snippetDirs) {
      if (!entry.writable) continue
      const abs = path.isAbsolute(entry.path) ? entry.path : path.resolve(process.cwd(), entry.path)
      try {
        fs.mkdirSync(abs, { recursive: true })
        this._record('snippet_dir:ready', { path: entry.path, writable: true })
      } catch (err) {
        this._record('error', { id: entry.path, message: `mkdir failed: ${err.message}` })
      }
    }

    this._scanCatalog()
    this._startCatalogWatchers()

    const players = Array.isArray(this.config.players) ? this.config.players : []
    for (const p of players) {
      if (!p.username) continue
      if (this.sessions.has(p.username)) continue
      this._spawn(p)
    }
  }

  _absDir (entry) {
    return path.isAbsolute(entry.path) ? entry.path : path.resolve(process.cwd(), entry.path)
  }

  _idFromPath (filePath) {
    return path.basename(filePath, path.extname(filePath))
  }

  _scanCatalog () {
    this.catalog.clear()
    for (const entry of this.snippetDirs) {
      const abs = this._absDir(entry)
      if (!fs.existsSync(abs)) continue
      let files = []
      try { files = fs.readdirSync(abs).filter(f => f.endsWith('.js')) } catch (_) { continue }
      for (const f of files) this._upsertCatalogFile(path.join(abs, f), entry, { silent: true })
    }
  }

  _upsertCatalogFile (absPath, dirEntry, { silent = false } = {}) {
    const id = this._idFromPath(absPath)
    const existing = this.catalog.get(id)
    if (existing && existing.absPath !== absPath) {
      // Earlier dir wins per snippet_dirs order. Reject duplicate from a later dir.
      this._record('catalog:conflict', { id, kept: existing.absPath, rejected: absPath })
      return
    }
    let code = ''
    let mtime = 0
    try {
      code = fs.readFileSync(absPath, 'utf8')
      mtime = fs.statSync(absPath).mtimeMs
    } catch (err) {
      this._record('error', { id, message: `read failed: ${err.message}` })
      return
    }
    const rel = path.relative(process.cwd(), absPath) || absPath
    const wasNew = !existing
    this.catalog.set(id, { id, source: rel, absPath, code, mtime, fromDir: dirEntry.path, kind: 'file' })
    if (!silent) this._record(wasNew ? 'catalog:add' : 'catalog:change', { id, source: rel })
  }

  _removeCatalogFile (absPath) {
    const id = this._idFromPath(absPath)
    const entry = this.catalog.get(id)
    if (!entry || entry.absPath !== absPath) return
    this.catalog.delete(id)
    this._record('catalog:remove', { id, source: entry.source })
    // Unload from any session that has it loaded (deletion = retire).
    for (const [, s] of this.sessions) {
      if (!s.ov) continue
      const snap = s.ov.inspect().find(x => x.id === id)
      if (snap) {
        try { s.ov.unload(id) } catch (_) {}
      }
    }
  }

  _propagateChange (absPath) {
    const id = this._idFromPath(absPath)
    const entry = this.catalog.get(id)
    if (!entry || entry.absPath !== absPath) return
    // The catalog file is the source of truth: any session with this id loaded
    // — inline or file-backed — gets the new code.
    for (const [, s] of this.sessions) {
      if (!s.ov) continue
      const snap = s.ov.inspect().find(x => x.id === id)
      if (snap) {
        s.ov.load(id, absPath).catch(err => this._record('error', { id, message: err.message }))
      }
    }
  }

  _startCatalogWatchers () {
    for (const entry of this.snippetDirs) {
      const abs = this._absDir(entry)
      const watcher = chokidar.watch(abs, { ignoreInitial: true, persistent: true })
      watcher.on('add',    p => { if (p.endsWith('.js')) this._upsertCatalogFile(p, entry) })
      watcher.on('change', p => { if (p.endsWith('.js')) { this._upsertCatalogFile(p, entry); this._propagateChange(p) } })
      watcher.on('unlink', p => { if (p.endsWith('.js')) this._removeCatalogFile(p) })
      this._catalogWatchers.push(watcher)
    }
  }

  _spawn (p) {
    const server = this.config.server || {}
    const debounce = p.debounce ?? server.debounce ?? 300
    const version = p.version ?? server.version
    const session = { config: p, bot: null, ov: null, status: 'connecting', _spawned: false }
    this.sessions.set(p.username, session)
    this._record('session', { username: p.username, status: 'connecting' })

    const bot = mineflayer.createBot({
      host: p.host ?? server.host ?? 'localhost',
      port: p.port ?? server.port ?? 25565,
      username: p.username,
      auth: p.auth ?? server.auth ?? 'offline',
      version: version === 'auto' ? undefined : version
    })
    session.bot = bot

    if (pathfinderPlugin) {
      try { bot.loadPlugin(pathfinderPlugin) } catch (_) {}
    }

    if (collectBlockPlugin) {
      try { bot.loadPlugin(collectBlockPlugin) } catch (_) {}
    }

    const ov = new Overflayer(bot, {
      watchDebounce: debounce,
      errorHandler: (id, err) => {
        this._record('error', { username: p.username, id, message: String(err && err.message ? err.message : err) })
      },
      inject: {
        _catalogResolver: (snippetId) => this.catalog.get(snippetId)?.absPath ?? null
      }
    })
    session.ov = ov

    ov.on('load',         (id, src) => this._record('load',         { username: p.username, id, source: src }))
    ov.on('unload',       (id)      => this._record('unload',       { username: p.username, id }))
    ov.on('reload',       (id, src) => this._record('reload',       { username: p.username, id, source: src }))
    ov.on('report', (id, payload) => this._record('report', { username: p.username, id, payload }))
    ov.on('stop',   (id, reason)  => this._record('stop',   { username: p.username, id, reason }))
    ov.on('state',  (id, key, value, meta) => this._record('state', { username: p.username, id, key, value, source: meta?.source, exported: meta?.exported }))

    bot.on('error',  (err) => this._record('bot:error', { username: p.username, message: String(err && err.message ? err.message : err) }))
    bot.on('kicked', (reason) => { session.status = 'kicked'; this._record('bot:kicked', { username: p.username, reason: String(reason) }) })
    bot.on('end',    (reason) => { session.status = 'ended'; this._record('bot:end', { username: p.username, reason: String(reason) }) })

    bot.on('spawn', async () => {
      session.status = 'spawned'
      this._record('bot:spawn', { username: p.username })

      if (mineflayerViewer && !session.viewerPort) {
        try {
          const port = this._nextViewerPort++
          mineflayerViewer(bot, { port, firstPerson: true })
          session.viewerPort = port
          this._record('viewer:start', { username: p.username, port })
        } catch (err) {
          this._record('error', { username: p.username, id: 'viewer', message: err.message })
        }
      }

      if (!session._spawned) {
        session._spawned = true
        for (const file of p.load || []) {
          try {
            const id = path.basename(file, path.extname(file))
            await ov.load(id, file)
          } catch (err) {
            this._record('error', { username: p.username, id: file, message: err.message })
          }
        }
      }
    })
  }

  _record (type, data) {
    const evt = { ts: Date.now(), type, ...data }
    this.events.push(evt)
    if (this.events.length > MAX_EVENT_BUFFER) this.events.splice(0, this.events.length - MAX_EVENT_BUFFER)
    this.emit('event', evt)
  }

  list () {
    const out = []
    for (const [username, s] of this.sessions) {
      const snippets = s.ov ? s.ov.inspect() : []

      // Collect state for snippets that have preset values but aren't currently loaded
      const pendingState = {}
      if (s.ov) {
        for (const [snippetId, slot] of s.ov._state) {
          if (!s.ov.snippets.has(snippetId) && Object.keys(slot.values).length > 0) {
            pendingState[snippetId] = slot.values
          }
        }
      }

      out.push({
        username,
        status: s.status,
        viewerPort: s.viewerPort || null,
        knownPlayers: s.bot?.players ? Object.keys(s.bot.players) : [],
        host: s.bot?.socket?.remoteAddress || s.config.host || (this.config.server?.host),
        position: s.bot?.entity?.position
          ? { x: s.bot.entity.position.x, y: s.bot.entity.position.y, z: s.bot.entity.position.z }
          : null,
        health: s.bot?.health,
        food: s.bot?.food,
        snippetCount: snippets.length,
        snippets,
        pendingState,
        inventory: s.bot?.inventory
          ? s.bot.inventory.items().map(i => ({ name: i.name, count: i.count, slot: i.slot }))
          : []
      })
    }
    return out
  }

  get (username) {
    const s = this.sessions.get(username)
    if (!s) return null
    return this.list().find(p => p.username === username)
  }

  async loadSnippet ({ targets, id, code }) {
    if (!id || typeof id !== 'string') throw new Error('id is required')
    if (typeof code !== 'string') throw new Error('code is required')
    const resolved = this._resolveTargets(targets)
    const results = []
    for (const username of resolved) {
      const s = this.sessions.get(username)
      if (!s || !s.ov) { results.push({ username, ok: false, error: 'session not ready' }); continue }
      try {
        await s.ov.load(id, code)
        results.push({ username, ok: true })
      } catch (err) {
        results.push({ username, ok: false, error: err.message })
      }
    }
    return results
  }

  setState ({ targets, id, key, value }) {
    if (!id || !key) throw new Error('id and key are required')
    const resolved = this._resolveTargets(targets)
    const results = []
    for (const username of resolved) {
      const s = this.sessions.get(username)
      if (!s || !s.ov) { results.push({ username, ok: false, error: 'session not ready' }); continue }
      try {
        if (s.ov.snippets.has(id)) {
          s.ov.setExportedState(id, key, value)
        } else {
          s.ov.preset(id, key, value)
        }
        results.push({ username, ok: true })
      } catch (err) {
        results.push({ username, ok: false, error: err.message })
      }
    }
    return results
  }

  unloadSnippet ({ targets, id }) {
    const resolved = this._resolveTargets(targets)
    const results = []
    for (const username of resolved) {
      const s = this.sessions.get(username)
      if (!s || !s.ov) { results.push({ username, ok: false, error: 'session not ready' }); continue }
      const removed = s.ov.unload(id)
      results.push({ username, ok: removed })
    }
    return results
  }

  _resolveTargets (targets) {
    if (!targets || targets === 'all' || (Array.isArray(targets) && targets.length === 0)) {
      return [...this.sessions.keys()]
    }
    if (typeof targets === 'string') return [targets]
    if (Array.isArray(targets)) return targets
    throw new Error('targets must be "all", a username, or an array of usernames')
  }

  // Compute the merged catalog: file-backed (this.catalog) + ephemeral inline
  // (derived from any session currently running a snippet with source === '<inline>').
  // File entries shadow inline entries of the same id.
  catalogView () {
    const out = new Map()
    for (const entry of this.catalog.values()) {
      out.set(entry.id, {
        id: entry.id,
        source: entry.source,
        code: entry.code,
        kind: 'file',
        fromDir: entry.fromDir,
        loadedOn: []
      })
    }
    // Layer inline entries from running sessions.
    for (const [username, s] of this.sessions) {
      if (!s.ov) continue
      for (const snap of s.ov.inspect()) {
        if (snap.source === '<inline>') {
          if (!out.has(snap.id)) {
            out.set(snap.id, {
              id: snap.id,
              source: '<inline>',
              code: snap.code,
              kind: 'inline',
              loadedOn: [username]
            })
          } else if (out.get(snap.id).kind === 'inline') {
            out.get(snap.id).loadedOn.push(username)
          }
        }
        // Record loadedOn for file-backed entries too.
        const item = out.get(snap.id)
        if (item && item.kind === 'file' && snap.source !== '<inline>') {
          item.loadedOn.push(username)
        }
      }
    }
    return [...out.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'file' ? -1 : 1
      return a.id.localeCompare(b.id)
    })
  }

  recentEvents (limit = 100) {
    const n = Math.min(limit, this.events.length)
    return this.events.slice(this.events.length - n)
  }

  async close () {
    for (const w of this._catalogWatchers) {
      try { await w.close() } catch (_) {}
    }
    this._catalogWatchers = []
    for (const [, s] of this.sessions) {
      try { await s.ov?.close() } catch (_) {}
      try { s.bot?.quit() } catch (_) {}
    }
    this.sessions.clear()
  }
}

let _singleton = null
function getManager () {
  if (!_singleton) _singleton = new SessionManager()
  return _singleton
}

module.exports = { SessionManager, getManager }

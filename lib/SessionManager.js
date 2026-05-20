'use strict'

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const { EventEmitter } = require('events')

const Overflayer = require('..')

let mineflayer = null
try { mineflayer = require('mineflayer') } catch (_) {}

let pathfinderPlugin = null
try { pathfinderPlugin = require('mineflayer-pathfinder').pathfinder } catch (_) {}

let mineflayerViewer = null
try { mineflayerViewer = require('prismarine-viewer').mineflayer } catch (_) {}

const VIEWER_PORT_BASE = parseInt(process.env.OVERFLAYER_VIEWER_PORT_BASE || '4100', 10)

const MAX_EVENT_BUFFER = 500

class SessionManager extends EventEmitter {
  constructor () {
    super()
    this.sessions = new Map() // username -> { bot, ov, status, config, viewerPort }
    this.events = []          // ring buffer
    this.config = null
    this.configPath = null
    this._nextViewerPort = VIEWER_PORT_BASE
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
    const players = Array.isArray(this.config.players) ? this.config.players : []
    for (const p of players) {
      if (!p.username) continue
      if (this.sessions.has(p.username)) continue
      this._spawn(p)
    }
  }

  _spawn (p) {
    const server = this.config.server || {}
    const debounce = p.debounce ?? server.debounce ?? 300
    const version = p.version ?? server.version
    const session = { config: p, bot: null, ov: null, status: 'connecting' }
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

    const ov = new Overflayer(bot, {
      watchDebounce: debounce,
      errorHandler: (id, err) => {
        this._record('error', { username: p.username, id, message: String(err && err.message ? err.message : err) })
      }
    })
    session.ov = ov

    ov.on('load',         (id, src) => this._record('load',         { username: p.username, id, source: src }))
    ov.on('unload',       (id)      => this._record('unload',       { username: p.username, id }))
    ov.on('reload',       (id, src) => this._record('reload',       { username: p.username, id, source: src }))
    ov.on('watch:add',    (id, fp)  => this._record('watch:add',    { username: p.username, id, path: fp }))
    ov.on('watch:change', (id, fp)  => this._record('watch:change', { username: p.username, id, path: fp }))
    ov.on('watch:remove', (id, fp)  => this._record('watch:remove', { username: p.username, id, path: fp }))
    ov.on('report', (id, payload) => this._record('report', { username: p.username, id, payload }))
    ov.on('stop',   (id, reason)  => this._record('stop',   { username: p.username, id, reason }))

    bot.on('error',  (err) => this._record('bot:error', { username: p.username, message: String(err && err.message ? err.message : err) }))
    bot.on('kicked', (reason) => { session.status = 'kicked'; this._record('bot:kicked', { username: p.username, reason: String(reason) }) })
    bot.on('end',    (reason) => { session.status = 'ended'; this._record('bot:end', { username: p.username, reason: String(reason) }) })

    bot.once('spawn', async () => {
      session.status = 'spawned'
      this._record('bot:spawn', { username: p.username })

      if (mineflayerViewer) {
        try {
          const port = this._nextViewerPort++
          mineflayerViewer(bot, { port, firstPerson: true })
          session.viewerPort = port
          this._record('viewer:start', { username: p.username, port })
        } catch (err) {
          this._record('error', { username: p.username, id: 'viewer', message: err.message })
        }
      }
      for (const file of p.load || []) {
        try {
          const id = path.basename(file, path.extname(file))
          await ov.load(id, file)
        } catch (err) {
          this._record('error', { username: p.username, id: file, message: err.message })
        }
      }
      for (const dir of p.watch || []) {
        try { ov.watch(dir); this._record('watch:start', { username: p.username, dir }) }
        catch (err) { this._record('error', { username: p.username, id: dir, message: err.message }) }
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
      out.push({
        username,
        status: s.status,
        viewerPort: s.viewerPort || null,
        host: s.bot?.socket?.remoteAddress || s.config.host || (this.config.server?.host),
        position: s.bot?.entity?.position
          ? { x: s.bot.entity.position.x, y: s.bot.entity.position.y, z: s.bot.entity.position.z }
          : null,
        health: s.bot?.health,
        food: s.bot?.food,
        snippetCount: snippets.length,
        snippets
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

  library () {
    // Aggregate unique snippet definitions across all loaded sessions.
    // Prefer file-backed sources over <inline> when an id appears in both.
    const byId = new Map()
    for (const [username, s] of this.sessions) {
      if (!s.ov) continue
      for (const snap of s.ov.inspect()) {
        const existing = byId.get(snap.id)
        if (!existing) {
          byId.set(snap.id, {
            id: snap.id,
            source: snap.source,
            code: snap.code,
            loadedOn: [username],
            firstLoadedAt: snap.loadedAt,
            lastLoadedAt: snap.loadedAt
          })
        } else {
          existing.loadedOn.push(username)
          if (snap.loadedAt > existing.lastLoadedAt) existing.lastLoadedAt = snap.loadedAt
          if (snap.loadedAt < existing.firstLoadedAt) existing.firstLoadedAt = snap.loadedAt
          // Prefer file-backed source over <inline> for displayed code.
          if (existing.source === '<inline>' && snap.source !== '<inline>') {
            existing.source = snap.source
            existing.code = snap.code
          }
        }
      }
    }
    return [...byId.values()].sort((a, b) => b.lastLoadedAt - a.lastLoadedAt)
  }

  recentEvents (limit = 100) {
    const n = Math.min(limit, this.events.length)
    return this.events.slice(this.events.length - n)
  }

  async close () {
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

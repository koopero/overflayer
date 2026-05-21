'use strict'

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const CleanupScope = require('./lib/CleanupScope')
const { createUtils } = require('./lib/utils')
const { createBotProxy } = require('./lib/BotProxy')
const { runSnippet } = require('./lib/runner')
const { Watcher } = require('./lib/watcher')
const { ScopeDisposedError } = require('./lib/errors')

let Vec3
try { Vec3 = require('vec3').Vec3 || require('vec3') } catch (_) { Vec3 = undefined }

let pathfinderGoals = null
try {
  const pf = require('mineflayer-pathfinder')
  pathfinderGoals = pf.goals || null
} catch (_) {
  pathfinderGoals = null
}

const DEFAULT_OPTIONS = {
  inject: {},
  errorHandler: (id, err) => {
    // eslint-disable-next-line no-console
    console.error(`[overflayer:${id ?? 'unknown'}]`, err)
  },
  watchDebounce: 300
}

function looksLikeFilePath (s) {
  if (typeof s !== 'string') return false
  if (s.endsWith('.js')) return true
  try {
    return fs.existsSync(s) && fs.statSync(s).isFile()
  } catch (_) { return false }
}

class Overflayer extends EventEmitter {
  constructor (bot, options = {}) {
    super()
    if (!bot) throw new TypeError('new Overflayer(bot, options): bot is required')
    this.bot = bot
    this.options = { ...DEFAULT_OPTIONS, ...options, inject: { ...(options.inject || {}) } }
    this.snippets = new Map() // id -> { scope, source, loadedAt, getListenerCount }
    this._watchers = new Set()
    this._state = new Map() // snippetId -> { schema: {key: {type, export, default}}, values: {key: value} }
    // Prevent EventEmitter's default throw-on-unhandled-error behavior:
    // errors are always routed through options.errorHandler too.
    this.on('error', () => {})
  }

  _getOrCreateStateSlot (id) {
    let slot = this._state.get(id)
    if (!slot) { slot = { schema: {}, values: {} }; this._state.set(id, slot) }
    return slot
  }

  _typeCheck (type, value) {
    if (value === undefined || value === null) return true
    switch (type) {
      case 'string':  return typeof value === 'string'
      case 'number':  return typeof value === 'number' && !Number.isNaN(value)
      case 'boolean': return typeof value === 'boolean'
      case 'player':  return typeof value === 'string'
      case 'vec3':    return value && typeof value.x === 'number' && typeof value.y === 'number' && typeof value.z === 'number'
      default:        return true // opaque
    }
  }

  setExportedState (id, key, value) {
    const slot = this._state.get(id)
    if (!slot || !slot.schema[key]) {
      throw new Error(`state key "${key}" is not configured for snippet "${id}"`)
    }
    if (!slot.schema[key].export) {
      throw new Error(`state key "${key}" is not exported`)
    }
    if (!this._typeCheck(slot.schema[key].type, value)) {
      throw new Error(`value for "${key}" does not match type ${slot.schema[key].type}`)
    }
    slot.values[key] = value
    this.emit('state', id, key, value, { source: 'api', exported: true })
    return value
  }

  preset (id, key, value) {
    const slot = this._getOrCreateStateSlot(id)
    slot.values[key] = value
  }

  async load (id, source) {
    if (typeof id !== 'string' || !id.length) throw new TypeError('load(id, source): id must be a non-empty string')
    if (typeof source !== 'string') throw new TypeError('load(id, source): source must be a string')

    if (this.snippets.has(id)) this.unload(id, { keepState: true })

    const isFile = looksLikeFilePath(source)
    let code
    let storedSource
    if (isFile) {
      const abs = path.isAbsolute(source) ? source : path.resolve(process.cwd(), source)
      code = await fs.promises.readFile(abs, 'utf8')
      storedSource = source
    } else {
      code = source
      storedSource = '<inline>'
    }

    const scope = new CleanupScope()
    scope.on('error', (err) => {
      this.emit('error', id, err)
      try { this.options.errorHandler(id, err) } catch (_) {}
    })

    const utils = createUtils(scope)
    const { proxy, getListenerCount } = createBotProxy(this.bot, scope)

    if (this.bot.pathfinder) {
      scope.register(() => {
        try { this.bot.pathfinder.setGoal(null) } catch (_) {}
      })
    }

    const entry = {
      scope,
      source: storedSource,
      code,
      loadedAt: Date.now(),
      getListenerCount,
      reportCount: 0,
      lastReport: undefined,
      lastReportAt: undefined
    }

    const report = (...args) => {
      if (scope.disposed) return
      const payload = args.length <= 1 ? args[0] : args
      entry.reportCount++
      entry.lastReport = payload
      entry.lastReportAt = Date.now()
      this.emit('report', id, payload)
    }

    let stopRequested = false
    const stop = (reason) => {
      if (stopRequested || scope.disposed) return
      stopRequested = true
      entry.stoppedReason = reason
      this.emit('stop', id, reason)
      // Defer so the caller's current frame can finish before its scope is torn down.
      queueMicrotask(() => {
        if (this.snippets.get(id) === entry) this.unload(id)
      })
    }

    const slot = this._getOrCreateStateSlot(id)
    const warn = (msg) => {
      const err = new Error(msg)
      this.emit('error', id, err)
      try { this.options.errorHandler(id, err) } catch (_) {}
    }
    const stateConfigure = (key, opts = {}) => {
      if (typeof key !== 'string' || !key) throw new TypeError('stateConfigure: key must be a non-empty string')
      const { type = 'string', export: exported = false, default: dflt } = opts
      const prev = slot.schema[key]
      slot.schema[key] = { type, export: !!exported, default: dflt }
      if (!(key in slot.values)) {
        // First-time configuration — initialise from default.
        const initial = typeof dflt === 'function' ? dflt() : dflt
        if (initial !== undefined) {
          if (!this._typeCheck(type, initial)) {
            warn(`stateConfigure("${key}"): default does not match type ${type}; storing anyway`)
          }
          slot.values[key] = initial
          this.emit('state', id, key, initial, { source: 'default', exported: !!exported })
        }
      } else if (prev && prev.type !== type && !this._typeCheck(type, slot.values[key])) {
        // Existing value, type changed, value incompatible — keep old value, warn.
        warn(`stateConfigure("${key}"): new type ${type} incompatible with existing value; preserving old value`)
      }
    }
    const stateGet = (key) => slot.values[key]
    const stateSet = (key, value) => {
      if (!slot.schema[key]) {
        throw new Error(`stateSet("${key}"): key is not configured. Call stateConfigure first.`)
      }
      if (!this._typeCheck(slot.schema[key].type, value)) {
        warn(`stateSet("${key}"): value does not match type ${slot.schema[key].type}; storing anyway`)
      }
      slot.values[key] = value
      this.emit('state', id, key, value, { source: 'snippet', exported: !!slot.schema[key].export })
      return value
    }

    const resolver = this.options.inject?._catalogResolver ?? null

    // Load a snippet by catalog ID (or explicit source path), with optional initial state.
    // snippetLoad('provision')
    // snippetLoad('provision', { output_chest: { x, y, z } })
    // snippetLoad('provision', '/path/to/provision.js', { output_chest: { x, y, z } })
    const snippetLoad = async (targetId, sourceOrState, maybeState) => {
      let src, initialState
      if (typeof sourceOrState === 'string' || sourceOrState == null) {
        src = sourceOrState ?? (resolver ? resolver(targetId) : null)
        initialState = maybeState
      } else {
        src = resolver ? resolver(targetId) : null
        initialState = sourceOrState
      }
      if (!src) throw new Error(`snippetLoad("${targetId}"): not found in catalog`)
      await this.load(targetId, src)
      if (initialState && typeof initialState === 'object') {
        const slot = this._state.get(targetId)
        if (slot) {
          for (const [k, v] of Object.entries(initialState)) {
            if (slot.schema[k]) {
              slot.values[k] = v
              this.emit('state', targetId, k, v, { source: 'snippetLoad', exported: !!slot.schema[k].export })
            }
          }
        }
      }
    }

    // Unload by ID, or unload self when called with no argument.
    // Defaults keepState:true so state survives snippet hand-off cycles.
    const snippetUnload = (targetId, { keepState = true } = {}) => {
      queueMicrotask(() => this.unload(targetId ?? id, { keepState }))
    }

    const globals = {
      bot: proxy,
      sleep: utils.sleep,
      interval: utils.interval,
      run: utils.run,
      report,
      stop,
      stateConfigure,
      stateGet,
      stateSet,
      signal: scope.signal,
      Vec3,
      GoalNear: pathfinderGoals?.GoalNear,
      GoalBlock: pathfinderGoals?.GoalBlock,
      GoalXZ: pathfinderGoals?.GoalXZ,
      GoalY: pathfinderGoals?.GoalY,
      GoalFollow: pathfinderGoals?.GoalFollow,
      GoalInvert: pathfinderGoals?.GoalInvert,
      ScopeDisposedError,
      snippetLoad,
      snippetUnload,
      ...this.options.inject
    }

    try {
      runSnippet(code, globals)
    } catch (err) {
      scope.dispose()
      throw err
    }

    this.snippets.set(id, entry)

    this.emit('load', id, storedSource)
  }

  unload (id, { keepState = false } = {}) {
    const entry = this.snippets.get(id)
    if (!entry) return false
    this.snippets.delete(id)
    try { entry.scope.dispose() } catch (err) {
      this.emit('error', id, err)
      try { this.options.errorHandler(id, err) } catch (_) {}
    }
    if (!keepState) this._state.delete(id)
    this.emit('unload', id)
    return true
  }

  async reload (id) {
    const entry = this.snippets.get(id)
    if (!entry) throw new Error(`reload(${id}): snippet is not loaded`)
    if (entry.source === '<inline>') throw new Error(`reload(${id}): snippet was loaded inline; reload requires a file path`)
    const source = entry.source
    await this.load(id, source)
    this.emit('reload', id, source)
  }

  watch (dir, options = {}) {
    const watcher = new Watcher(this, dir, options)
    this._watchers.add(watcher)
    const origStop = watcher.stop.bind(watcher)
    watcher.stop = async () => {
      this._watchers.delete(watcher)
      await origStop()
    }
    return watcher
  }

  inspect () {
    const out = []
    for (const [id, entry] of this.snippets) {
      const slot = this._state.get(id)
      const state = {}
      if (slot) {
        for (const [key, schema] of Object.entries(slot.schema)) {
          state[key] = { type: schema.type, value: slot.values[key], exported: !!schema.export }
        }
      }
      out.push({
        id,
        source: entry.source,
        code: entry.code,
        loadedAt: entry.loadedAt,
        listenerCount: entry.getListenerCount(),
        pendingTasks: entry.scope.pendingTasks,
        reportCount: entry.reportCount,
        lastReport: entry.lastReport,
        lastReportAt: entry.lastReportAt,
        state
      })
    }
    return out
  }

  async close () {
    for (const w of [...this._watchers]) {
      try { await w.stop() } catch (_) {}
    }
    for (const id of [...this.snippets.keys()]) this.unload(id)
  }
}

module.exports = Overflayer
module.exports.Overflayer = Overflayer
module.exports.ScopeDisposedError = ScopeDisposedError

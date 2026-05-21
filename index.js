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
    this.snippets = new Map() // id -> { scope, source, loadedAt, getListenerCount, declaredStateKeys }
    this._watchers = new Set()
    // Player-level state: Map<key, { value, schema: { type, export, default, declaredBy: Set<snippetId> } | null }>
    this._state = new Map()
    this.on('error', () => {})
  }

  _typeCheck (type, value) {
    if (value === undefined || value === null) return true
    switch (type) {
      case 'string':  return typeof value === 'string'
      case 'number':  return typeof value === 'number' && !Number.isNaN(value)
      case 'boolean': return typeof value === 'boolean'
      case 'player':  return typeof value === 'string'
      case 'vec3':    return value && typeof value.x === 'number' && typeof value.y === 'number' && typeof value.z === 'number'
      default:        return true
    }
  }

  // Set an exported player-state key from outside (API / operator).
  setExportedState (key, value) {
    const entry = this._state.get(key)
    if (!entry || !entry.schema) {
      throw new Error(`state key "${key}" is not configured`)
    }
    if (!entry.schema.export) {
      throw new Error(`state key "${key}" is not exported`)
    }
    if (!this._typeCheck(entry.schema.type, value)) {
      throw new Error(`value for "${key}" does not match type ${entry.schema.type}`)
    }
    entry.value = value
    this.emit('state', key, value, { source: 'api', exported: true })
    return value
  }

  // Pre-set a player-state value before any behavior has declared the key.
  preset (key, value) {
    let entry = this._state.get(key)
    if (!entry) { entry = { value: undefined, schema: null }; this._state.set(key, entry) }
    entry.value = value
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

    // Track which player-state keys this behavior declares (for cleanup on unload).
    const declaredStateKeys = new Set()

    const entry = {
      scope,
      source: storedSource,
      code,
      loadedAt: Date.now(),
      getListenerCount,
      reportCount: 0,
      lastReport: undefined,
      lastReportAt: undefined,
      declaredStateKeys
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
      queueMicrotask(() => {
        if (this.snippets.get(id) === entry) this.unload(id)
      })
    }

    const warn = (msg) => {
      const err = new Error(msg)
      this.emit('error', id, err)
      try { this.options.errorHandler(id, err) } catch (_) {}
    }

    // Declare a player-state key this behavior reads/writes. Shared across behaviors
    // that declare the same key — intentional key sharing is how behaviors coordinate.
    const declareState = (key, opts = {}) => {
      if (typeof key !== 'string' || !key) throw new TypeError('declareState: key must be a non-empty string')
      const { type = 'string', export: exported = false, default: dflt } = opts

      declaredStateKeys.add(key)

      let stateEntry = this._state.get(key)
      if (!stateEntry) {
        stateEntry = { value: undefined, schema: { type, export: !!exported, default: dflt, declaredBy: new Set() } }
        this._state.set(key, stateEntry)
        const initial = typeof dflt === 'function' ? dflt() : dflt
        if (initial !== undefined) {
          stateEntry.value = initial
          this.emit('state', key, initial, { source: 'default', snippetId: id, exported: !!exported })
        }
      } else {
        if (!stateEntry.schema) {
          // Was preset without a schema — attach schema now.
          stateEntry.schema = { type, export: !!exported, default: dflt, declaredBy: new Set() }
        } else {
          if (stateEntry.schema.type !== type) {
            warn(`declareState("${key}"): type conflict — existing: ${stateEntry.schema.type}, new: ${type}; keeping existing`)
          }
          if (exported) stateEntry.schema.export = true
        }
        // Apply default only if value is still unset.
        if (stateEntry.value === undefined) {
          const initial = typeof dflt === 'function' ? dflt() : dflt
          if (initial !== undefined) {
            stateEntry.value = initial
            this.emit('state', key, initial, { source: 'default', snippetId: id, exported: !!exported })
          }
        }
      }
      stateEntry.schema.declaredBy.add(id)
    }

    const stateGet = (key) => this._state.get(key)?.value

    const stateSet = (key, value) => {
      const stateEntry = this._state.get(key)
      if (!stateEntry || !stateEntry.schema) {
        throw new Error(`stateSet("${key}"): key is not configured. Call declareState first.`)
      }
      if (!this._typeCheck(stateEntry.schema.type, value)) {
        warn(`stateSet("${key}"): value does not match type ${stateEntry.schema.type}; storing anyway`)
      }
      stateEntry.value = value
      this.emit('state', key, value, { source: 'snippet', snippetId: id, exported: !!stateEntry.schema.export })
      return value
    }

    const resolver = this.options.inject?._catalogResolver ?? null

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
        for (const [k, v] of Object.entries(initialState)) {
          let se = this._state.get(k)
          if (!se) { se = { value: undefined, schema: null }; this._state.set(k, se) }
          se.value = v
          this.emit('state', k, v, { source: 'snippetLoad', snippetId: targetId })
        }
      }
    }

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
      declareState,
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
    // Remove this behavior from declaredBy for each key it declared.
    for (const key of entry.declaredStateKeys) {
      const se = this._state.get(key)
      if (se?.schema) se.schema.declaredBy.delete(id)
    }
    // keepState=false: clear keys that no other behavior has declared.
    // Player state persists by default (keepState=true); explicit unload prunes orphaned keys.
    if (!keepState) {
      for (const key of entry.declaredStateKeys) {
        const se = this._state.get(key)
        if (se?.schema && se.schema.declaredBy.size === 0) this._state.delete(key)
      }
    }
    try { entry.scope.dispose() } catch (err) {
      this.emit('error', id, err)
      try { this.options.errorHandler(id, err) } catch (_) {}
    }
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

  // Snapshot of all loaded behaviors.
  inspect () {
    const out = []
    for (const [id, entry] of this.snippets) {
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
        declaredState: [...entry.declaredStateKeys]
      })
    }
    return out
  }

  // Snapshot of this player's state (union of all loaded behaviors' declared keys + presets).
  playerState () {
    const out = {}
    for (const [key, se] of this._state) {
      out[key] = {
        value: se.value,
        type: se.schema?.type ?? 'string',
        exported: !!(se.schema?.export),
        declaredBy: se.schema?.declaredBy ? [...se.schema.declaredBy] : []
      }
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

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
    // Prevent EventEmitter's default throw-on-unhandled-error behavior:
    // errors are always routed through options.errorHandler too.
    this.on('error', () => {})
  }

  async load (id, source) {
    if (typeof id !== 'string' || !id.length) throw new TypeError('load(id, source): id must be a non-empty string')
    if (typeof source !== 'string') throw new TypeError('load(id, source): source must be a string')

    if (this.snippets.has(id)) this.unload(id)

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

    const globals = {
      bot: proxy,
      sleep: utils.sleep,
      interval: utils.interval,
      run: utils.run,
      report,
      stop,
      signal: scope.signal,
      Vec3,
      GoalNear: pathfinderGoals?.GoalNear,
      GoalBlock: pathfinderGoals?.GoalBlock,
      GoalXZ: pathfinderGoals?.GoalXZ,
      GoalY: pathfinderGoals?.GoalY,
      GoalFollow: pathfinderGoals?.GoalFollow,
      GoalInvert: pathfinderGoals?.GoalInvert,
      ScopeDisposedError,
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

  unload (id) {
    const entry = this.snippets.get(id)
    if (!entry) return false
    this.snippets.delete(id)
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
        lastReportAt: entry.lastReportAt
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

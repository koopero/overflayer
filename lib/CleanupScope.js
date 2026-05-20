'use strict'

const { EventEmitter } = require('events')

class CleanupScope extends EventEmitter {
  #handlers = []
  #controller = new AbortController()
  #disposed = false
  #pendingTasks = 0

  register (fn) {
    if (typeof fn !== 'function') throw new TypeError('register(fn): fn must be a function')
    if (this.#disposed) {
      try { fn() } catch (err) { this.#emitCleanupError(err) }
      return
    }
    this.#handlers.push(fn)
  }

  dispose () {
    if (this.#disposed) return
    this.#disposed = true
    try { this.#controller.abort() } catch (err) { this.#emitCleanupError(err) }
    while (this.#handlers.length) {
      const fn = this.#handlers.pop()
      try { fn() } catch (err) { this.#emitCleanupError(err) }
    }
    this.emit('dispose')
  }

  get signal () { return this.#controller.signal }
  get disposed () { return this.#disposed }
  get pendingTasks () { return this.#pendingTasks }

  trackTask (promise) {
    this.#pendingTasks++
    const done = () => { this.#pendingTasks = Math.max(0, this.#pendingTasks - 1) }
    Promise.resolve(promise).then(done, done)
  }

  #emitCleanupError (err) {
    if (this.listenerCount('cleanupError') > 0) {
      this.emit('cleanupError', err)
    } else {
      // Last resort: log but do not throw — cleanup must keep going.
      // eslint-disable-next-line no-console
      console.error('[overflayer] cleanup handler threw:', err)
    }
  }
}

module.exports = CleanupScope

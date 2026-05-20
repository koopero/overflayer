'use strict'

const { ScopeDisposedError } = require('./errors')

function createUtils (scope) {
  function sleep (ms) {
    return new Promise((resolve, reject) => {
      if (scope.signal.aborted) return reject(new ScopeDisposedError())
      const id = setTimeout(() => {
        scope.signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(id)
        reject(new ScopeDisposedError())
      }
      scope.signal.addEventListener('abort', onAbort, { once: true })
      scope.register(() => {
        clearTimeout(id)
        scope.signal.removeEventListener('abort', onAbort)
      })
    })
  }

  function interval (ms, fn) {
    const id = setInterval(() => {
      if (scope.disposed) { clearInterval(id); return }
      try {
        const r = fn()
        if (r && typeof r.then === 'function') {
          r.catch(err => {
            if (err instanceof ScopeDisposedError) return
            scope.emit('error', err)
          })
        }
      } catch (err) {
        if (err instanceof ScopeDisposedError) return
        scope.emit('error', err)
      }
    }, ms)
    scope.register(() => clearInterval(id))
    return id
  }

  function run (asyncFn) {
    if (typeof asyncFn !== 'function') {
      throw new TypeError('run(fn): fn must be a function')
    }
    const p = Promise.resolve().then(() => asyncFn()).catch(err => {
      if (err instanceof ScopeDisposedError) return
      scope.emit('error', err)
    })
    scope.trackTask(p)
    return p
  }

  return { sleep, interval, run }
}

module.exports = { createUtils }

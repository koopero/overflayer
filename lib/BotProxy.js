'use strict'

const { ScopeDisposedError } = require('./errors')

function wrapHandler (fn, scope) {
  return async (...args) => {
    if (scope.disposed) return
    try {
      await fn(...args)
    } catch (err) {
      if (err instanceof ScopeDisposedError) return
      scope.emit('error', err)
    }
  }
}

function createBotProxy (bot, scope) {
  // Map<eventName, Set<{ user: fn, wrapped: fn }>> — tracks listeners this scope registered.
  const listeners = new Map()

  function track (event, user, wrapped) {
    let set = listeners.get(event)
    if (!set) { set = new Set(); listeners.set(event, set) }
    const entry = { user, wrapped }
    set.add(entry)
    return entry
  }

  function untrack (event, entry) {
    const set = listeners.get(event)
    if (!set) return
    set.delete(entry)
    if (set.size === 0) listeners.delete(event)
  }

  function on (event, fn) {
    const wrapped = wrapHandler(fn, scope)
    const entry = track(event, fn, wrapped)
    bot.on(event, wrapped)
    scope.register(() => {
      bot.removeListener(event, wrapped)
      untrack(event, entry)
    })
    return proxy
  }

  function once (event, fn) {
    let entry
    const wrapped = wrapHandler(async (...args) => {
      untrack(event, entry)
      await fn(...args)
    }, scope)
    entry = track(event, fn, wrapped)
    bot.once(event, wrapped)
    scope.register(() => {
      bot.removeListener(event, wrapped)
      untrack(event, entry)
    })
    return proxy
  }

  function removeListener (event, fn) {
    const set = listeners.get(event)
    if (!set) return proxy
    for (const entry of set) {
      if (entry.user === fn) {
        bot.removeListener(event, entry.wrapped)
        set.delete(entry)
        break
      }
    }
    if (set && set.size === 0) listeners.delete(event)
    return proxy
  }

  function removeAllListeners (event) {
    if (event === undefined) {
      for (const [evt, set] of listeners) {
        for (const entry of set) bot.removeListener(evt, entry.wrapped)
      }
      listeners.clear()
      return proxy
    }
    const set = listeners.get(event)
    if (!set) return proxy
    for (const entry of set) bot.removeListener(event, entry.wrapped)
    listeners.delete(event)
    return proxy
  }

  function denied (name) {
    return () => { throw new Error(`bot.${name}() is not available in snippet scope`) }
  }

  const overrides = {
    on,
    addListener: on,
    once,
    removeListener,
    off: removeListener,
    removeAllListeners,
    end: denied('end'),
    quit: denied('quit')
  }

  function getListenerCount () {
    let n = 0
    for (const set of listeners.values()) n += set.size
    return n
  }

  const proxy = new Proxy(bot, {
    get (target, prop, receiver) {
      if (prop === '__overflayerListenerCount') return getListenerCount
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop]
      const value = Reflect.get(target, prop, target)
      if (typeof value === 'function') return value.bind(target)
      return value
    },
    set (target, prop, value) {
      target[prop] = value
      return true
    },
    has (target, prop) {
      return prop in target
    }
  })

  return { proxy, getListenerCount }
}

module.exports = { createBotProxy, wrapHandler }

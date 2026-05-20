'use strict'

class ScopeDisposedError extends Error {
  constructor (message = 'Snippet scope was disposed') {
    super(message)
    this.name = 'ScopeDisposedError'
  }
}

module.exports = { ScopeDisposedError }

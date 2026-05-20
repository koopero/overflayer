'use strict'

const path = require('path')
const { EventEmitter } = require('events')

let chokidar
try { chokidar = require('chokidar') } catch (_) { chokidar = null }

function idFromPath (filePath) {
  return path.basename(filePath, path.extname(filePath))
}

class Watcher extends EventEmitter {
  constructor (ov, dir, options = {}) {
    super()
    if (!chokidar) {
      throw new Error('chokidar is not installed — install it to use overflayer.watch()')
    }
    const { autoLoad = true, ignored = [], debounce = ov.options.watchDebounce } = options
    this.ov = ov
    this.dir = dir
    this.debounceMs = typeof debounce === 'number' ? debounce : 300
    this._pending = new Map()

    this.watcher = chokidar.watch(dir, {
      ignoreInitial: !autoLoad,
      ignored,
      persistent: true
    })

    const isJs = p => p.endsWith('.js')

    this.watcher.on('add', (p) => {
      if (!isJs(p)) return
      this._schedule(p, 'add')
    })
    this.watcher.on('change', (p) => {
      if (!isJs(p)) return
      this._schedule(p, 'change')
    })
    this.watcher.on('unlink', (p) => {
      if (!isJs(p)) return
      const id = idFromPath(p)
      const t = this._pending.get(p)
      if (t) { clearTimeout(t.timer); this._pending.delete(p) }
      ov.emit('watch:remove', id, p)
      ov.unload(id)
    })
    this.watcher.on('error', (err) => ov.emit('error', null, err))
  }

  _schedule (p, kind) {
    const existing = this._pending.get(p)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      this._pending.delete(p)
      const id = idFromPath(p)
      this.ov.emit(kind === 'add' ? 'watch:add' : 'watch:change', id, p)
      this.ov.load(id, p).catch(err => this.ov.emit('error', id, err))
    }, this.debounceMs)
    this._pending.set(p, { timer, kind })
  }

  async stop () {
    for (const { timer } of this._pending.values()) clearTimeout(timer)
    this._pending.clear()
    await this.watcher.close()
  }
}

module.exports = { Watcher, idFromPath }

# Overflayer

> Write normal Mineflayer code. Overflayer keeps the bot connected while your snippets reload.

Overflayer is a persistent runtime layer on top of [Mineflayer](https://github.com/PrismarineJS/mineflayer) that decouples the **Minecraft connection lifecycle** from the **snippet code lifecycle**.

Instead of restarting the process whenever your bot logic changes, Overflayer keeps the underlying client and bot alive while hot-swapping snippet code in real time.

---

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [Snippets](#snippets)
  - [Format](#format)
  - [Injected Globals](#injected-globals)
  - [Async Patterns](#async-patterns)
  - [Blocked Globals](#blocked-globals)
- [API](#api)
  - [new Overflayer(bot, options)](#new-overflaerbot-options)
  - [overflayer.load(id, source)](#overflayerloadid-source)
  - [overflayer.unload(id)](#overflayerunloadid)
  - [overflayer.reload(id)](#overflayerreloadid)
  - [overflayer.watch(dir, options)](#overflayerwatchdir-options)
  - [overflayer.inspect()](#overflayerinspect)
- [CLI](#cli)
- [File Watching](#file-watching)
- [Error Handling](#error-handling)
- [Events](#events)
- [Implementation Notes](#implementation-notes)
- [Not in v1](#not-in-v1)

---

## Install

```bash
npm install overflayer
```

Requires Node.js >= 18. Peer dependency: `mineflayer` >= 4.

---

## Quick Start

**Programmatic:**

```js
const mineflayer = require('mineflayer')
const Overflayer = require('overflayer')

const bot = mineflayer.createBot({ host: 'localhost', username: 'Bot' })
const ov = new Overflayer(bot)

bot.once('spawn', async () => {
  await ov.load('greeter', './snippets/greeter.js')
  await ov.load('auto-eat', './snippets/auto-eat.js')
  ov.watch('./snippets/')
})
```

**CLI:**

```bash
overflayer --host localhost --username Bot --watch ./snippets/
```

**Snippet file (`snippets/greeter.js`):**

```js
bot.on('chat', (username, message) => {
  if (username === bot.username) return
  if (message === 'hi') bot.chat(`Hello, ${username}!`)
})
```

Edit and save `greeter.js`. Overflayer reloads it instantly — the bot stays connected.

---

## Snippets

### Format

Snippets are plain `.js` files. No exports, no boilerplate. Globals are injected automatically.

```js
// snippets/patrol.js

run(async () => {
  const points = [new Vec3(10, 64, 10), new Vec3(-10, 64, -10)]
  let i = 0
  while (!signal.aborted) {
    await bot.pathfinder.goto(new GoalNear(points[i].x, points[i].y, points[i].z, 1))
    await sleep(3000)
    i = (i + 1) % points.length
  }
})
```

Snippets may register event listeners, start async loops, or do both. All resources are automatically cleaned up when the snippet is reloaded or unloaded.

### Injected Globals

The following are available in every snippet without importing:

| Global | Type | Description |
|---|---|---|
| `bot` | `Bot` (proxied) | The Mineflayer bot. Same API as normal — listeners and timers are tracked automatically. |
| `sleep(ms)` | `(number) => Promise<void>` | Cancellable sleep. Rejects with `ScopeDisposedError` when the snippet is unloaded. |
| `interval(ms, fn)` | `(number, function) => void` | Scope-tracked `setInterval`. Cleared automatically on unload. |
| `run(asyncFn)` | `(AsyncFunction) => void` | Run a top-level async function with error capture and cancellation wiring. Use this instead of floating IIFEs. |
| `signal` | `AbortSignal` | Aborted when the snippet is unloaded. Pass to any API that accepts it. |
| `Vec3` | class | From `vec3`. |
| `GoalNear` | class | From `mineflayer-pathfinder`. |
| `GoalBlock` | class | From `mineflayer-pathfinder`. |
| `GoalXZ` | class | From `mineflayer-pathfinder`. |
| `GoalY` | class | From `mineflayer-pathfinder`. |
| `GoalFollow` | class | From `mineflayer-pathfinder`. |
| `GoalInvert` | class | From `mineflayer-pathfinder`. |

Pathfinder goal globals are only injected when `mineflayer-pathfinder` is installed in the project. If it is not present, they are `undefined`.

### Async Patterns

**Short async task:**

```js
run(async () => {
  await sleep(1000)
  bot.chat('ready')
})
```

**Long-running loop (must check `signal.aborted`):**

```js
run(async () => {
  while (!signal.aborted) {
    const food = bot.inventory.items().find(i => i.name.includes('bread'))
    if (food && bot.food < 15) await bot.consume(food)
    await sleep(2000)
  }
})
```

**Periodic side effect:**

```js
interval(5000, () => {
  bot.chat(`Position: ${bot.entity.position}`)
})
```

**Combining listeners and async:**

```js
bot.on('chat', (username, message) => {
  if (message !== 'come') return
  run(async () => {
    const player = bot.players[username]
    if (!player?.entity) return bot.chat("I can't see you.")
    const { x, y, z } = player.entity.position
    await bot.pathfinder.goto(new GoalNear(x, y, z, 2))
    bot.chat('Here!')
  })
})
```

### Blocked Globals

The following are `undefined` inside snippet scope. This is developer containment, not a security sandbox.

`require` · `module` · `exports` · `process` · `global` · `__dirname` · `__filename`

If your snippet needs a module, load it in the host process and pass it in via `options.inject` (see [API](#new-overflaerbot-options)).

---

## API

### `new Overflayer(bot, options)`

Creates an Overflayer instance attached to an existing Mineflayer bot.

```js
const ov = new Overflayer(bot, options)
```

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `inject` | `object` | `{}` | Additional globals to inject into every snippet. Values are merged with the default globals. Keys shadow defaults if they conflict. |
| `errorHandler` | `function` | `console.error` | Called with `(id, error)` when a snippet throws. Receives the snippet ID and the error. |
| `watchDebounce` | `number` | `300` | Milliseconds to debounce file change events before triggering a reload. |

**Example with extra injection:**

```js
const axios = require('axios')
const ov = new Overflayer(bot, {
  inject: { axios },
  errorHandler: (id, err) => myLogger.error(`[${id}]`, err)
})
```

---

### `overflayer.load(id, source)`

Loads a snippet. `source` is either a file path (string ending in `.js` or an existing file path) or a raw code string.

Returns a `Promise<void>` that resolves when the snippet has been executed (listener registration phase complete). Rejects if the snippet throws synchronously on load.

If a snippet with this `id` is already loaded, it is unloaded first (full cleanup), then the new code runs. This is the hot-reload path.

```js
// Load from file
await ov.load('greeter', './snippets/greeter.js')

// Load from string
await ov.load('ping', `bot.on('chat', (u, m) => { if (m === 'ping') bot.chat('pong') })`)
```

File paths may be absolute or relative to `process.cwd()`.

---

### `overflayer.unload(id)`

Unloads a snippet by ID. Disposes its scope synchronously: all event listeners are removed, all timers are cleared, and the `signal` is aborted (cancelling any pending `sleep` calls).

Returns `true` if a snippet with that ID was loaded, `false` otherwise.

```js
ov.unload('greeter')
```

---

### `overflayer.reload(id)`

Reloads a snippet from its original source. Only valid for snippets loaded from a file path — throws if the snippet was loaded from a code string.

Re-reads the file from disk, unloads the current snippet, and loads the new code.

Returns a `Promise<void>`.

```js
await ov.reload('greeter')
```

---

### `overflayer.watch(dir, options)`

Watches a directory for `.js` file changes and automatically loads, reloads, and unloads snippets.

- **New file added**: loaded with the filename (without extension) as the ID.
- **File changed**: reloaded.
- **File deleted**: unloaded.

Returns a `Watcher` instance with a `.stop()` method.

```js
const watcher = ov.watch('./snippets/')
// later:
watcher.stop()
```

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `autoLoad` | `boolean` | `true` | Load all existing `.js` files in the directory immediately on watch start. |
| `ignored` | `string \| RegExp \| string[]` | `[]` | File patterns to ignore. Passed to chokidar. |

Uses [chokidar](https://github.com/paulmillr/chokidar) internally.

---

### `overflayer.inspect()`

Returns a snapshot of all currently loaded snippets.

```js
ov.inspect()
// [
//   {
//     id: 'greeter',
//     source: './snippets/greeter.js',
//     loadedAt: 1716230400000,
//     listenerCount: 2,
//     pendingTasks: 1
//   },
//   ...
// ]
```

**Return shape per snippet:**

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Snippet ID. |
| `source` | `string` | File path or `'<inline>'` for code strings. |
| `loadedAt` | `number` | Unix ms timestamp of last load. |
| `listenerCount` | `number` | Number of active `bot.on`/`bot.once` listeners registered by this snippet. |
| `pendingTasks` | `number` | Number of unresolved `run(...)` promises. |

---

## CLI

```bash
overflayer [options]
```

The CLI creates a bot and starts Overflayer. All snippet management happens via file watching.

**Options:**

| Flag | Description |
|---|---|
| `--host <host>` | Minecraft server host. Default: `localhost`. |
| `--port <port>` | Server port. Default: `25565`. |
| `--username <name>` | Bot username. Required. |
| `--auth <type>` | Auth type: `offline` or `microsoft`. Default: `offline`. |
| `--version <ver>` | Minecraft version. Default: auto-detect. |
| `--watch <dir>` | Directory to watch for snippets. May be specified multiple times. |
| `--load <file>` | Load a specific snippet file at startup. May be specified multiple times. |
| `--debounce <ms>` | File change debounce in ms. Default: `300`. |

**Examples:**

```bash
# Watch a directory
overflayer --host play.example.com --username CoolBot --auth offline --watch ./snippets/

# Load specific files
overflayer --host localhost --username Bot --load patrol.js --load auto-eat.js

# Microsoft auth
overflayer --host hypixel.net --username you@email.com --auth microsoft --watch ./snippets/
```

The CLI logs snippet load/unload/error events to stdout with timestamps and snippet IDs.

---

## File Watching

When `overflayer.watch(dir)` is active:

```
snippets/
  greeter.js     → loaded as id 'greeter'
  auto-eat.js    → loaded as id 'auto-eat'
  _disabled.js   → ignored (underscore prefix, configurable)
```

The snippet ID is the filename without the `.js` extension. If two watched directories contain a file with the same name, the later-loaded one wins and emits a warning.

File change events are debounced (default 300ms) to avoid partial-write reloads during saves.

---

## Error Handling

**Synchronous load errors** (syntax errors, immediate throws) cause `load()` to reject. The snippet is not registered.

```js
try {
  await ov.load('broken', './broken.js')
} catch (err) {
  console.error('Failed to load:', err)
}
```

**Runtime errors** (errors thrown inside event listeners or `run()` callbacks) are caught per-handler, routed to `options.errorHandler`, and do not affect other snippets or the bot.

**Cancellation** (`ScopeDisposedError`) is not an error. It is silently swallowed when a `sleep()` is interrupted by unload. Do not catch it unless you need cleanup logic on cancellation.

```js
run(async () => {
  try {
    await sleep(10000)
  } catch (e) {
    if (e instanceof ScopeDisposedError) {
      // snippet unloaded mid-sleep — fine, no action needed
      return
    }
    throw e
  }
})
```

`ScopeDisposedError` is exported from the package:

```js
const { ScopeDisposedError } = require('overflayer')
```

---

## Events

`Overflayer` extends `EventEmitter`.

| Event | Args | Description |
|---|---|---|
| `load` | `(id, source)` | Fired after a snippet is successfully loaded. |
| `unload` | `(id)` | Fired after a snippet is unloaded and its scope disposed. |
| `reload` | `(id, source)` | Fired after a snippet is reloaded. Fired after the new load completes. |
| `error` | `(id, error)` | Fired when a snippet's runtime handler throws. Also calls `options.errorHandler`. |
| `watch:add` | `(id, path)` | File watcher detected a new file. |
| `watch:change` | `(id, path)` | File watcher detected a change. |
| `watch:remove` | `(id, path)` | File watcher detected a deletion. |

---

## Implementation Notes

This section is a spec for implementers. It describes the required internal architecture.

### Package structure

```
overflayer/
  index.js          — exports Overflayer class, ScopeDisposedError
  lib/
    CleanupScope.js — lifecycle + AbortController
    BotProxy.js     — Proxy factory
    runner.js       — snippet execution via new Function()
    watcher.js      — chokidar wrapper
    utils.js        — sleep, interval, run factories
  bin/
    overflayer.js   — CLI entry point
```

### CleanupScope

```js
class CleanupScope extends EventEmitter {
  // Private:
  //   #handlers: Array<() => void>  — cleanup functions, run LIFO on dispose
  //   #controller: AbortController
  //   #disposed: boolean
  //   #pendingTasks: number         — count of unresolved run() promises

  register(fn)     // add a cleanup handler; if already disposed, call fn() immediately
  dispose()        // abort signal, run all handlers LIFO, emit 'dispose'
  get signal()     // AbortSignal
  get disposed()   // boolean
  get pendingTasks() // number

  trackTask(promise) // increment pendingTasks, decrement on settle
}
```

`dispose()` must be synchronous. Each handler is called in a try/catch — exceptions are logged but do not halt cleanup.

### BotProxy

A `Proxy` wrapping the real bot. The `get` trap intercepts:

- `on` / `addListener` — wraps handler in `wrapHandler(fn, scope)`, registers `bot.removeListener` in scope, calls `bot.on`.
- `once` — same as `on` but uses a one-time wrapper that self-removes from the scope registry on first call.
- `removeAllListeners` — only removes listeners registered by this scope (not all listeners globally).
- `end` / `quit` — throw `Error('bot.end() is not available in snippet scope')`.

All other properties are forwarded to the real bot with `Reflect.get`. Returned functions are bound to the real bot to prevent `this` pointing at the proxy.

The proxy maintains a `Map<eventName, Set<wrappedFn>>` for its own listener tracking.

### Handler wrapping

```js
function wrapHandler(fn, scope) {
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
```

### Snippet runner

Snippets are executed via `new Function`. Blocked globals are passed as parameter names receiving `undefined`.

```js
const BLOCKED = ['require', 'module', 'exports', 'process', 'global', '__dirname', '__filename']

function runSnippet(code, globals) {
  const keys = [...Object.keys(globals), ...BLOCKED]
  const values = [...Object.values(globals), ...BLOCKED.map(() => undefined)]
  const fn = new Function(...keys, `"use strict";\n${code}`)
  return fn(...values)
}
```

`globals` contains: `bot` (proxy), `sleep`, `interval`, `run`, `signal`, `Vec3`, and all pathfinder goal classes (if available). Plus any `options.inject` values.

`runSnippet` is synchronous. Async work kicked off inside the snippet is fire-and-forget from the runner's perspective — `run()` handles tracking.

### sleep / interval / run factories

These close over the `CleanupScope` instance:

```js
function createUtils(scope) {
  function sleep(ms) {
    return new Promise((resolve, reject) => {
      if (scope.signal.aborted) return reject(new ScopeDisposedError())
      const id = setTimeout(resolve, ms)
      const onAbort = () => { clearTimeout(id); reject(new ScopeDisposedError()) }
      scope.signal.addEventListener('abort', onAbort, { once: true })
      scope.register(() => {
        clearTimeout(id)
        scope.signal.removeEventListener('abort', onAbort)
      })
    })
  }

  function interval(ms, fn) {
    const id = setInterval(() => {
      if (scope.disposed) { clearInterval(id); return }
      try { fn() } catch (e) { scope.emit('error', e) }
    }, ms)
    scope.register(() => clearInterval(id))
  }

  function run(asyncFn) {
    const p = Promise.resolve().then(() => asyncFn()).catch(err => {
      if (err instanceof ScopeDisposedError) return
      scope.emit('error', err)
    })
    scope.trackTask(p)
  }

  return { sleep, interval, run }
}
```

### Pathfinder cleanup

If `mineflayer-pathfinder` is loaded on the bot, register a pathfinder cleanup hook when a snippet scope is created:

```js
if (bot.pathfinder) {
  scope.register(() => {
    try { bot.pathfinder.setGoal(null) } catch {}
  })
}
```

This is registered once per scope creation, not per `goto` call.

### Overflayer.load internals

1. If an existing snippet with this `id` exists: call `unload(id)` synchronously.
2. Create a new `CleanupScope`.
3. Create a bot proxy and utils from the scope.
4. Read file from disk if source is a path; otherwise use source string as code.
5. Assemble globals object: default globals + `options.inject`.
6. Call `runSnippet(code, globals)` inside a try/catch. On throw: `scope.dispose()`, re-throw.
7. Store `{ scope, source, botProxy, loadedAt }` in the snippet registry keyed by `id`.
8. Emit `'load'` event.

### Watcher internals

Uses [chokidar](https://github.com/paulmillr/chokidar).

```js
chokidar.watch(dir, { ignoreInitial: !autoLoad, ignored })
  .on('add',    path => ov.load(idFromPath(path), path))
  .on('change', path => ov.load(idFromPath(path), path))  // load() handles unload+reload
  .on('unlink', path => ov.unload(idFromPath(path)))
```

`idFromPath` strips the directory prefix and `.js` extension.

File changes are debounced by `options.watchDebounce` ms per file path.

### CLI internals

Uses [commander](https://github.com/tj/commander.js).

Boot sequence:

1. Parse args.
2. `mineflayer.createBot(...)`.
3. `new Overflayer(bot, { errorHandler: cliErrorLogger })`.
4. On `bot.once('spawn')`: load any `--load` files, then start watchers for any `--watch` dirs.
5. Pipe `ov` events to stdout with timestamps.
6. Handle `SIGINT` / `SIGTERM`: call `bot.quit()` then `process.exit(0)`.

### Dependencies

```json
{
  "dependencies": {
    "chokidar": "^3.6.0",
    "commander": "^12.0.0",
    "vec3": "^0.1.10"
  },
  "peerDependencies": {
    "mineflayer": ">=4.0.0"
  },
  "optionalPeerDependencies": {
    "mineflayer-pathfinder": ">=2.0.0"
  }
}
```

`mineflayer-pathfinder` is optional. If not installed, pathfinder goal globals are `undefined` and the pathfinder cleanup hook is skipped.

---

## Not in v1

The following are intentionally out of scope for the initial release:

**Resource arbitration / claims** — cooperative locking for movement, combat, inventory. Future: `await scope.claim('movement')`.

**State persistence across reloads** — snippets cannot yet serialize/restore state. Future: `scope.useState(key, default)`.

**Hardened sandbox** — the current model is developer containment. Future hardened execution could use worker threads or vm2.

**Snippet packs** — bundling multiple snippets into a named, versioned group.

**Inter-snippet communication** — no shared bus or pub/sub between snippets in v1.
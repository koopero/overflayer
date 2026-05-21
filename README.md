# Overflayer

> Write bot logic as snippets. Overflayer keeps the bot connected while your code reloads.

Overflayer is a Mineflayer bot manager with a web UI, hot-reloading snippets, a state system, and an MCP server for AI-assisted control.

---

## Getting Started

**Prerequisites:** Node.js >= 18, a running Minecraft server.

```bash
npm install
npm run dev
```

The web UI runs at `http://localhost:3000`. Open it to see your bots.

---

## Configuration

Edit `config.yaml` before starting:

```yaml
server:
  host: localhost
  port: 25565
  version: auto        # or e.g. "1.20.4"

snippet_dirs:
  - path: ./snippets/shared        # read-only catalog
  - path: ./tmp/local_snippets
    writable: true                 # snippets here can be created/edited via MCP

players:
  - username: January
    auth: offline
    load: []           # snippet IDs to load on spawn
  - username: February
    auth: offline
    load: []
```

Each entry under `players` spawns one bot. Bots stay connected across restarts of the web server.

**`snippet_dirs`** — directories scanned for `.js` snippet files. Each file becomes a catalog entry; the ID is the filename without `.js`. Directories marked `writable: true` can have snippets written to them via the MCP server.

---

## Web UI

The web UI at `http://localhost:3000` shows a card for each bot:

- **Status** — health, food, position
- **Inventory** — current items with counts
- **Active snippet** — ID, last report, state values with editable fields
- **Pre-configure** — set state on a snippet before loading it. Pick a snippet from the catalog, fill in the fields, and click Apply. The values persist so they're ready when the snippet loads.
- **Catalog** — all available snippets

---

## Writing Snippets

Snippets are plain `.js` files. No exports, no imports — globals are injected automatically.

```js
// snippets/greeter.js
bot.on('chat', (username, message) => {
  if (username === bot.username) return
  if (message === 'hi') bot.chat(`Hello, ${username}!`)
})
```

**Long-running loop:**

```js
run(async () => {
  while (!signal.aborted) {
    bot.chat(`I am at ${bot.entity.position}`)
    await sleep(10000)
  }
})
```

**Pathfinding:**

```js
run(async () => {
  const target = new Vec3(100, 64, 200)
  await bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, 2))
  bot.chat('Arrived!')
})
```

### Injected Globals

| Global | Description |
|---|---|
| `bot` | The Mineflayer bot. Listeners and timers registered here are cleaned up automatically on unload. |
| `sleep(ms)` | Cancellable sleep. Throws `ScopeDisposedError` if the snippet is unloaded mid-sleep. |
| `interval(ms, fn)` | Scope-tracked `setInterval`. Cleared automatically on unload. |
| `run(asyncFn)` | Run a top-level async function with error capture and cancellation wiring. |
| `signal` | `AbortSignal` — aborted when the snippet is unloaded. Pass to APIs that accept it. |
| `report(payload)` | Send a status update visible in the web UI. |
| `stop(reason)` | Unload this snippet and clear its state. |
| `stateConfigure(key, opts)` | Declare a state variable. See [State](#state). |
| `stateGet(key)` | Read a state value. |
| `stateSet(key, value)` | Write a state value. |
| `snippetLoad(id, state?)` | Load another snippet by catalog ID, optionally setting initial state. |
| `snippetUnload(id?, opts?)` | Unload a snippet. Defaults to self with `keepState: true`. |
| `Vec3` | From `vec3`. |
| `GoalNear` | From `mineflayer-pathfinder` (if installed). |
| `GoalBlock` | From `mineflayer-pathfinder`. |
| `GoalXZ` | From `mineflayer-pathfinder`. |
| `GoalY` | From `mineflayer-pathfinder`. |
| `GoalFollow` | From `mineflayer-pathfinder`. |
| `GoalInvert` | From `mineflayer-pathfinder`. |
| `ScopeDisposedError` | Error class thrown by `sleep()` on unload. |

`require`, `module`, `exports`, `process`, `global`, `__dirname`, and `__filename` are not available in snippet scope.

---

## State

Snippets can declare typed, persistent state variables. State survives snippet reloads and handoffs between snippets.

```js
stateConfigure('target_player', { type: 'player', export: true })
stateConfigure('radius',        { type: 'number', export: true, default: 5 })

run(async () => {
  const name = stateGet('target_player')
  const r    = stateGet('radius')
  // ...
})
```

**`stateConfigure(key, opts)`**

| Option | Values | Description |
|---|---|---|
| `type` | `'string'`, `'number'`, `'boolean'`, `'vec3'`, `'player'` | Type used for UI rendering and validation. |
| `export` | `true` / `false` | If true, the value is shown and editable in the web UI. |
| `default` | any | Initial value if none has been set. |

**Vec3 state** is stored as `{ x, y, z }` and renders as three coordinate fields in the UI.

**Pre-configuring unloaded snippets:** In the web UI, use the Pre-configure panel to set state on a snippet before it's loaded. Values are waiting when the snippet starts.

---

## Snippet Chaining

Snippets can hand off control to each other without any external coordination.

```js
// gather.js — mine until goal reached, then return to base
stateConfigure('next_snippet', { type: 'string', export: true, default: 'provision' })
stateConfigure('goal',         { type: 'number', export: true, default: 16 })

run(async () => {
  while (!signal.aborted) {
    // ... mine ...
    if (goalReached) {
      await snippetLoad(stateGet('next_snippet'))
      snippetUnload()   // keepState: true by default — state survives the handoff
      return
    }
  }
})
```

```js
// provision.js — resupply, then return to mining
stateConfigure('next_snippet', { type: 'string', export: true })

run(async () => {
  // ... chest interaction ...
  const next = stateGet('next_snippet')
  if (next) await snippetLoad(next)
  snippetUnload()
})
```

**`snippetLoad(id, state?)`** — loads a snippet from the catalog. Optionally sets initial state:

```js
await snippetLoad('provision', { output_chest: { x: -216, y: 71, z: 100 } })
```

**`snippetUnload(id?, { keepState })`** — unloads a snippet.
- Called with no arguments: unloads the current snippet.
- `keepState: true` (default): state is preserved for the next load. Use this for handoffs.
- `keepState: false`: state is deleted. Use `stop(reason)` for a clean exit.

---

## MCP Server

Overflayer ships an MCP server that lets AI assistants (like Claude) observe and control bots directly.

**Setup** — add `.mcp.json` to the project root (already included):

```json
{
  "mcpServers": {
    "overflayer": {
      "command": "node",
      "args": ["bin/overflayer-mcp.js"],
      "env": { "OVERFLAYER_URL": "http://localhost:3000" }
    }
  }
}
```

Open Claude Code in this directory and the MCP server connects automatically.

**Available tools:**

| Tool | Description |
|---|---|
| `list_players` | List all bots with status, position, health, inventory, and active snippets. |
| `get_player` | Get details for a specific bot. |
| `get_recent_events` | Stream of recent events (load, unload, report, state changes). |
| `list_catalog` | List all available snippets. |
| `read_snippet` | Read snippet source. |
| `save_snippet` | Write a snippet to a writable catalog directory. |
| `apply_snippet` | Load a snippet onto a bot by catalog ID. |
| `unload_snippet` | Unload a snippet from a bot. |
| `set_state` | Set a state value on a bot's snippet (or pre-configure an unloaded snippet). |
| `list_snippet_dirs` | List configured snippet directories. |
| `get_viewer_url` | Get the prismarine-viewer URL for a bot. |
| `read_snippet_globals_docs` | Read documentation for all snippet globals. |

---

## Snippets and the Catalog

All `.js` files in `snippet_dirs` are available in the catalog. The snippet ID is the filename without the extension.

```
snippets/
  shared/
    goto-base.js      → id: 'goto-base'
    auto-eat.js       → id: 'auto-eat'
  patroller/
    patrol.js         → id: 'patrol'
tmp/local_snippets/
    gather_iron_ore.js → id: 'gather_iron_ore'   (writable)
    prepare_worker.js  → id: 'prepare_worker'     (writable)
```

Snippets in `writable` directories can be created and edited via the MCP server. Snippets in non-writable directories are read-only from the MCP perspective (but can be edited directly on disk).

When a snippet file changes on disk, Overflayer hot-reloads it on any bot that currently has it loaded.

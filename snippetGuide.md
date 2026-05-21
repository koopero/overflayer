# Snippet Guide

Patterns and hard-won lessons extracted from the original snippet set.

---

## Always guard against self-echo

```js
bot.on('chat', (username, message) => {
  if (username === bot.username) return
  // ...
})
```

The bot receives its own chat messages. Without this guard, behaviors that
reply to chat will trigger themselves and loop.

---

## The standard async loop

```js
run(async () => {
  while (!signal.aborted) {
    // ... do work ...
    await sleep(2000)
  }
})
```

`signal.aborted` becomes true when the behavior is unloaded. The loop exits
cleanly on the next iteration. Any `await` inside the loop will also throw
`ScopeDisposedError` when the behavior is unloaded mid-sleep — catch that
separately (see below).

---

## ScopeDisposedError must be caught before other errors

```js
try {
  await bot.pathfinder.goto(goal)
} catch (err) {
  if (err instanceof ScopeDisposedError) return   // behavior was unloaded mid-navigation — exit silently
  report({ kind: 'pathfinder-error', message: String(err.message || err) })
  await sleep(1000)
}
```

If you don't check for `ScopeDisposedError` first, your error handler runs
after the behavior is already gone, producing noise or double-execution. This
check must come before any other error handling in any async pathfinder call.

---

## Guard for pathfinder availability

```js
if (!bot.pathfinder || !GoalNear) {
  report({ kind: 'fatal', reason: 'mineflayer-pathfinder is not loaded on this bot' })
  return stop('no-pathfinder')
}
```

Pathfinder is an optional plugin. Check at the top of any navigation behavior
and fail fast. Same pattern applies to `GoalFollow`, `GoalBlock`, etc.

---

## Guard for bot not yet spawned

```js
if (!bot.entity) {
  report({ kind: 'fatal', reason: 'bot has no entity (not spawned yet)' })
  return stop('not-spawned')
}
```

`bot.entity` is null until the bot has spawned into the world. Behaviors that
need position (navigation, scatter) must check this.

---

## Player visible vs. player known

```js
const target = bot.players[targetName]
if (!target?.entity) {
  // Player is on the server but outside render distance — can't navigate to them.
  await sleep(2000)
  continue
}
const { x, y, z } = target.entity.position
```

A player can appear in `bot.players` without having an `entity` (outside
render distance or riding a vehicle). Always check `?.entity` before accessing
`.position`. Poll and retry rather than erroring out — they may come into view.

---

## Use `report()` for structured status, not `bot.chat()`

```js
report({ kind: 'navigating', target: targetName, distance: dist, to: { x, y, z } })
report({ kind: 'arrived', attempt, traveled, at: { x, y, z } })
report({ kind: 'idle', reason: 'no target set' })
```

Use consistent `kind` strings so events are filterable in the UI and by the
MCP `get_recent_events` tool. Reserve `bot.chat()` for things the player
actually needs to see in-game.

---

## stop() for one-shot behaviors

```js
// At the end of successful completion:
return stop('arrived')

// At the end of exhausted retries:
stop('gave-up')
```

One-shot behaviors (do a thing, finish) should call `stop()` when done rather
than just returning. This emits a `stop` event so the caller knows the behavior
completed, and triggers an `unload` to clean up.

---

## Max attempts guard for retry loops

```js
const MAX_ATTEMPTS = 6
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  if (signal.aborted) return
  // ... try ...
}
report({ kind: 'gave-up', attempts: MAX_ATTEMPTS })
stop('gave-up')
```

Any behavior that retries on failure needs a ceiling. Always check
`signal.aborted` inside the loop so unload doesn't have to wait for all
attempts to exhaust.

---

## Vec3 position math

```js
const origin = bot.entity.position.clone()          // snapshot — position object is mutable
const angle  = Math.random() * Math.PI * 2
const target = origin.offset(Math.cos(angle) * DISTANCE, 0, Math.sin(angle) * DISTANCE)
const dist   = Math.hypot(here.x - origin.x, here.z - origin.z)  // 2D horizontal distance
```

`bot.entity.position` is a live reference — `.clone()` immediately if you need
a snapshot. Use `.offset(dx, dy, dz)` for relative positions. `Math.hypot` for
horizontal distance (ignore Y).

---

## Sleep after arrival to prevent jitter

```js
if (dist <= radius) {
  report({ kind: 'arrived', ... })
  await sleep(1000)   // without this, the loop re-checks immediately and re-navigates
  continue
}
```

After arriving at a moving target, sleep briefly before re-evaluating. Without
it the loop spins and hammers pathfinder with redundant tiny goals.

---

## Eating sequence

```js
const EDIBLE = ['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'apple', 'carrot', 'baked_potato']

if (bot.food < 16) {
  const food = bot.inventory.items().find(i => EDIBLE.some(name => i.name.includes(name)))
  if (food) {
    try {
      await bot.equip(food, 'hand')
      await bot.consume()
    } catch (_) {
      // interrupted, already consumed, slot changed — safe to ignore and retry next tick
    }
  }
}
```

Use `.includes()` not strict equality on item names — Minecraft prefixes many
foods (e.g. `golden_apple`, `enchanted_golden_apple`). Wrap `equip`+`consume`
in try/catch; `equip` can fail if the item disappears between the find and
equip. Threshold of 16 leaves headroom before starvation damage.

---

## Interval for fire-and-forget periodic work

```js
interval(60_000, () => {
  const { x, y, z } = bot.entity.position
  bot.chat(`alive at ${x.toFixed(0)} ${y.toFixed(0)} ${z.toFixed(0)}`)
  report({ kind: 'heartbeat', pos: { x, y, z }, health: bot.health, food: bot.food })
})
```

Use `interval()` (not `while + sleep`) for periodic actions that don't need
loop control. It's registered with the scope and auto-cancelled on unload.

---

## Chat command prefix pattern

```js
bot.on('chat', (username, message) => {
  if (username === bot.username) return
  if (!message.startsWith('!cmd ')) return
  const arg = message.slice(5)
  // ...
})
```

Prefix with `!` to distinguish commands from conversation. Use `startsWith`
then `slice` rather than splitting, so the argument can contain spaces.

---

## declareState at the top, stateGet inside the loop

```js
declareState('target', { type: 'player', export: true, default: 'rotiboater' })

run(async () => {
  while (!signal.aborted) {
    const targetName = stateGet('target')   // re-read each iteration — value may change at runtime
    // ...
  }
})
```

Declare state keys once at the top of the behavior. Read them inside the loop
so that changes pushed via `set_state` take effect on the next iteration
without reloading the behavior.

---

## Waypoint cycling

```js
const WAYPOINTS = [new Vec3(10, 64, 10), new Vec3(-10, 64, 10), ...]
let i = 0
while (!signal.aborted) {
  await bot.pathfinder.goto(new GoalNear(WAYPOINTS[i].x, WAYPOINTS[i].y, WAYPOINTS[i].z, 1))
  await sleep(3000)
  i = (i + 1) % WAYPOINTS.length
}
```

Standard modulo cycle. Sleep between waypoints so the bot doesn't immediately
charge to the next one — gives it (and pathfinder) a moment to settle.

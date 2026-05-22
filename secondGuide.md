# Second Snippet Guide

Hacks and hard-won lessons from the iron-pickaxe production pipeline (tmp/local_snippets).

---

## Registry lookups: items vs. blocks are separate

```js
const reg = bot.registry
const FURNACE_BLOCK_ID = reg.blocksByName['furnace']?.id   // for findBlock / blockAt
const FURNACE_ITEM_ID  = reg.itemsByName['furnace']?.id    // for inventory checks / craft
```

Block IDs and item IDs are different numbers. A furnace in the world uses `blocksByName`;
a furnace in inventory uses `itemsByName`. Always use `?.id` — the name may not exist in
the registry for this MC version.

---

## Crafting: navigate first, then craft

```js
const tableBlock = bot.findBlock({ matching: TABLE_BLOCK_ID, maxDistance: 32 })
if (bot.pathfinder && GoalNear) {
  await bot.pathfinder.goto(new GoalNear(tableBlock.position.x, tableBlock.position.y, tableBlock.position.z, 2))
}
const recipes = bot.recipesFor(ITEM_ID, null, 1, tableBlock)  // pass tableBlock for 3×3
if (!recipes.length) { report({ kind: 'fatal', reason: 'no recipe found' }); return }
await bot.craft(recipes[0], count, tableBlock)
```

`bot.craft` silently fails or errors if you're not within range. Navigate before calling it.
Pass `null` as the table argument for 2×2 recipes (planks, sticks); pass the block for 3×3.

---

## ensureTable() pattern for placing a crafting table on demand

```js
async function ensureTable () {
  let block = TABLE_BLOCK_ID ? bot.findBlock({ matching: TABLE_BLOCK_ID, maxDistance: 32 }) : null
  if (block) return block
  const item = bot.inventory.items().find(i => i.type === TABLE_ITEM_ID)
  if (!item) return null
  await bot.equip(item, 'hand')
  const pos = bot.entity.position.floored()
  for (const dir of [new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(0,0,-1)]) {
    const ground = bot.blockAt(pos.plus(dir).offset(0,-1,0))
    const space  = bot.blockAt(pos.plus(dir))
    if (ground?.boundingBox === 'block' && space?.name === 'air') {
      try { await bot.placeBlock(ground, new Vec3(0,1,0)); await sleep(200); return bot.findBlock({ matching: TABLE_BLOCK_ID, maxDistance: 6 }) }
      catch (err) { if (err instanceof ScopeDisposedError) return null }
    }
  }
  return null
}
```

`ground?.boundingBox === 'block'` is the correct check for a solid placeable surface.
`space?.name === 'air'` confirms the target cell is clear.

---

## Furnace placement needs TWO air blocks (height 2)

```js
// Crafting table: only needs 1 air block
if (ground?.boundingBox === 'block' && space?.name === 'air') { ... }

// Furnace: needs 2 clear blocks (furnace is 1-tall but the player must stand next to it)
const space1 = bot.blockAt(target)
const space2 = bot.blockAt(target.offset(0,1,0))
if (ground?.boundingBox === 'block' && space1?.name === 'air' && space2?.name === 'air') { ... }
```

Also, placing a furnace underground in a tunnel can fail because it tries to face it. Use
`GoalXZ` to step away from a shaft before placing:

```js
const { x, z } = bot.entity.position
await bot.pathfinder.goto(new GoalXZ(x + 6, z + 6))
```

---

## Chest interaction: always close(), slice to chest-only slots

```js
const chest = await bot.openChest(chestBlock)
try {
  // chest.slots includes BOTH the chest and the bot's own inventory.
  // Slice to only the chest portion:
  const chestOnly = chest.slots.slice(0, chest.inventoryStart ?? 27).filter(Boolean)
  const item = chestOnly.find(i => i.name === 'iron_pickaxe')
  if (item) await chest.withdraw(item.type, item.metadata ?? null, 1)
                                          // ^^^ always null, never undefined
} finally {
  chest.close()   // always — chest stays open server-side if you don't close it
}
```

---

## Opening chests reliably: unequip, face, retry

`bot.openChest` fails when the bot isn't close enough, when physics hasn't settled, or when
a tool is equipped (the server may interpret the right-click as block placement). Retry pattern:

```js
async function openChestWithRetry (block, maxAttempts = 4) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await goto(block.position.x, block.position.y, block.position.z, 1, 90000)
    if (bot.entity.position.distanceTo(block.position) > 5) return null  // truly unreachable
    try { await bot.unequip('hand') } catch (_) {}   // empty hand before opening
    await sleep(100)
    try { await bot.lookAt(new Vec3(block.position.x + 0.5, block.position.y + 0.5, block.position.z + 0.5), true) } catch (_) {}
    await sleep(300)
    try { return await bot.openChest(block) }
    catch (e) {
      if (e instanceof ScopeDisposedError) throw e
      await sleep(500 * attempt)
    }
  }
  return null
}
```

---

## Furnace smelting timing and fuel math

```js
const SMELT_TIME_PER_ITEM_MS = 12000
const BUFFER_MS = 5000
await sleep(count * SMELT_TIME_PER_ITEM_MS + BUFFER_MS)

// Fuel units needed: each log = 1.5 smelts, each plank = 0.5 smelts
const fuelNeeded = Math.ceil(count / 1.5)
```

Fuel priority: `coal` → `charcoal` → classic named logs → any `_log` → any `_planks`.
Classic logs (`oak_log`, `birch_log`, etc.) are safe across versions; newer types
(mangrove, cherry) may not be registered as fuel in older server versions.

```js
const pickFuel = () =>
  bot.inventory.items().find(i => ['coal','charcoal'].includes(i.name)) ||
  bot.inventory.items().find(i => CLASSIC_LOGS.includes(i.name)) ||
  bot.inventory.items().find(i => i.name?.endsWith('_log')) ||
  bot.inventory.items().find(i => i.name?.endsWith('_planks'))
```

---

## Always wrap pathfinder and openChest in a timeout

Neither `bot.pathfinder.goto()` nor `bot.openFurnace/openChest` have built-in timeouts.
They can hang indefinitely if the server doesn't respond or the path is impossible.

```js
async function withTimeout (promise, ms = 5000) {
  return Promise.race([
    promise,
    sleep(ms).then(() => { throw new Error('timeout') })
  ])
}

// Usage:
try { await withTimeout(bot.pathfinder.goto(goal), 30000) }
catch (err) {
  if (err instanceof ScopeDisposedError) throw err
  try { bot.pathfinder.setGoal(null) } catch (_) {}
  // continue / retry
}
```

Always call `bot.pathfinder.setGoal(null)` after a timeout to abort the ongoing navigation.

---

## Don't dig ore above or below you through terrain

`bot.dig()` can hang if there's no line of sight to the block (e.g., ore embedded in the
ceiling directly above). Check Y level before attempting a direct dig:

```js
const sameLevel = Math.abs(pos.y - Math.floor(bot.entity.position.y)) <= 1
const dist = bot.entity.position.distanceTo(new Vec3(pos.x+0.5, pos.y+0.5, pos.z+0.5))
if (sameLevel && dist <= 4.0) {
  await bot.dig(block, true)  // true = forceLook — bot faces the block before digging
}
```

The `true` (forceLook) parameter on `bot.dig` is important — without it the bot may fail
if it isn't already looking at the block.

---

## findBlocks (plural) + random selection to spread bots across a vein

```js
// Bad: every bot mines the same block
const block = bot.findBlock({ matching: isOre, maxDistance: 32 })

// Good: pick randomly from nearest N to spread bots
const positions = bot.findBlocks({ matching: isOre, maxDistance: 32, count: 8 })
const pos = positions[Math.floor(Math.random() * positions.length)]
```

`bot.findBlocks` (plural, with `count`) returns up to N positions. Picking randomly
prevents all bots from queuing up on the same block.

---

## Blacklist unreachable positions

```js
const skipSet = new Set()   // Set<"x,y,z">

const block = bot.findBlock({
  matching: b => isOre(b) && !skipSet.has(`${b.position.x},${b.position.y},${b.position.z}`),
  maxDistance: 32
})
// ... try to reach it ...
if (!reached) skipSet.add(`${pos.x},${pos.y},${pos.z}`)

// Clear when moving to a new area:
skipSet.clear()
```

Without this, the bot will retry the same unreachable block on every loop iteration.
Clear the set after a wander or area change.

---

## Canopy logs: check distance after navigation, not before

```js
const logBlock = bot.findBlock({ matching: b => isLog(b), maxDistance: 64 })
await goto(logBlock.position.x, logBlock.position.y, logBlock.position.z, 3)
const dist = bot.entity.position.distanceTo(logBlock.position)
if (dist > 5) {
  // Pathfinder reached the XZ goal but the log is up in the canopy.
  // Blacklist and try another log.
  skipSet.add(`${logBlock.position.x},${logBlock.position.y},${logBlock.position.z}`)
}
```

`bot.findBlock` finds logs at any Y level including treetops. Pathfinder can navigate to
the base of the tree but can't reach a log at y=72. The only reliable check is post-navigation
distance.

---

## Expanding search radius + wandering when area is exhausted

```js
let searchStreak = 0

// In loop:
const radius = searchStreak < 3 ? 16 : searchStreak < 6 ? 32 : 48
const block = bot.findBlock({ matching: isOre, maxDistance: radius })
if (!block) {
  searchStreak++
  if (searchStreak >= 6) {
    // Wander to a new area and reset
    const me = bot.entity.position
    const wx = me.x + (Math.random() - 0.5) * 40
    const wz = me.z + (Math.random() - 0.5) * 40
    await goto(wx, me.y, wz, 3, 15000)
    skipSet.clear()
    searchStreak = 2
  }
  continue
}
searchStreak = 0
```

---

## snippetLoad + snippetUnload for hand-off chains

```js
// Hand off to another snippet without losing state:
await snippetLoad('next-task')
snippetUnload()   // unloads self; keepState defaults to true so coords etc. survive
```

Load the next snippet BEFORE unloading self — `snippetUnload` is deferred to the next
microtask, so the new snippet starts before self exits.

---

## GoalY and GoalXZ for directional movement

```js
// Climb to surface level (useful before accessing surface chests):
if (bot.entity.position.y < 65 && GoalY) {
  await Promise.race([
    bot.pathfinder.goto(new GoalY(68)),
    sleep(25000).then(() => { throw new Error('surface-timeout') })
  ]).catch(() => { try { bot.pathfinder.setGoal(null) } catch (_) {} })
}

// Move horizontally without caring about Y (escape a shaft, find flat ground):
await bot.pathfinder.goto(new GoalXZ(x + 6, z + 6))
```

---

## pathfinder.movements configuration for underground work

```js
if (bot.pathfinder?.movements) {
  bot.pathfinder.movements.canDig        = true    // allow digging through terrain
  bot.pathfinder.movements.digCost       = 30      // higher = less eager to dig walls
  bot.pathfinder.movements.maxDropDown   = 3       // don't fall more than 3 blocks
  bot.pathfinder.movements.allowParkour  = false   // avoid risky jumps underground
  bot.pathfinder.movements.scaffoldingBlocks = []  // don't use inventory blocks as scaffolding
}
```

Reset these after underground work if the bot returns to surface tasks — the defaults
are tuned for overworld navigation, not cave mining.

---

## Sign NBT is never available programmatically

`bot.blockAt(pos).nbt` returns `null` for signs, even after navigating next to them and
waiting. Servers only transmit block entity data to clients via `tile_entity_data` packets,
and signs with no text send no packet at all. Empty signs cannot be read. Signs with text
may or may not have their NBT in `block.nbt` depending on when the chunk loaded — it is
not reliably available.

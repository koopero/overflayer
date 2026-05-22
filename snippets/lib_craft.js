// Library snippet. Attaches crafting/navigation/inventory helpers to `bot.kit`.
// The attachment happens at the top level so it's set synchronously during
// snippetLoad — consumers can use `bot.kit` immediately after awaiting the load.
// Stays loaded indefinitely so its scope-bound `sleep` and `signal` remain
// valid for the closures captured by the helpers.
//
// Consumer pattern:
//   if (!bot.kit) await snippetLoad('lib_craft')
//   const k = bot.kit
//   await k.goHome()
//   await k.craft('iron_pickaxe', 1)

declareState('home',        { type: 'vec3', export: true })
declareState('furnacePos',  { type: 'vec3', export: true })
declareState('tablePos',    { type: 'vec3', export: true })
declareState('outputChest', { type: 'vec3', export: true })

const reg = bot.registry
const iid = n => reg.itemsByName[n]?.id
const bid = n => reg.blocksByName[n]?.id

const LOG_NAMES = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log']
const PLANK_NAMES = LOG_NAMES.map(n => n.replace('_log', '_planks'))

const invItems = () => bot.inventory.items()
const invCount = (nameOrId) => {
  const items = invItems()
  if (typeof nameOrId === 'string') {
    return items.filter(i => i.name === nameOrId).reduce((s, i) => s + i.count, 0)
  }
  if (nameOrId == null) return 0
  return items.filter(i => i.type === nameOrId).reduce((s, i) => s + i.count, 0)
}
const invCountAny = (names) =>
  invItems().filter(i => names.includes(i.name)).reduce((s, i) => s + i.count, 0)

async function withTimeout (p, ms) {
  return Promise.race([p, sleep(ms).then(() => { throw new Error('timeout') })])
}

async function goto (x, y, z, opts = {}) {
  const { radius = 2, timeout = 30000 } = opts
  if (!bot.pathfinder || !GoalNear) return false
  try {
    await withTimeout(bot.pathfinder.goto(new GoalNear(x, y, z, radius)), timeout)
    return true
  } catch (e) {
    if (e instanceof ScopeDisposedError) throw e
    return false
  }
}

function stationPos (role) {
  const key = role === 'home'    ? 'home'
            : role === 'furnace' ? 'furnacePos'
            : role === 'table'   ? 'tablePos'
            : role === 'output'  ? 'outputChest'
            : null
  return key ? stateGet(key) : null
}

async function goHome (opts) {
  const p = stateGet('home')
  if (!p) return false
  return goto(p.x, p.y, p.z, opts)
}

async function goToStation (role, opts) {
  const p = stationPos(role)
  if (!p) return false
  return goto(p.x, p.y, p.z, opts)
}

function freshBlock (pos, expectedName) {
  if (!pos) return null
  const b = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
  if (!b || b.name === 'air') return null
  if (expectedName && b.name !== expectedName) return null
  return b
}

function findTable () {
  const tracked = freshBlock(stateGet('tablePos'), 'crafting_table')
  if (tracked) return tracked
  const id = bid('crafting_table')
  return id ? bot.findBlock({ matching: id, maxDistance: 32 }) : null
}

function findFurnace () {
  const tracked = freshBlock(stateGet('furnacePos'), 'furnace')
  if (tracked) return tracked
  const id = bid('furnace')
  return id ? bot.findBlock({ matching: id, maxDistance: 64 }) : null
}

function findHomeChest ()   { return freshBlock(stateGet('home'),        'chest') }
function findOutputChest () { return freshBlock(stateGet('outputChest'), 'chest') }

async function craft (itemName, qty = 1, opts = {}) {
  const { needsTable = true } = opts
  const id = iid(itemName)
  if (id == null) return false
  let table = null
  if (needsTable) {
    table = findTable()
    if (!table) return false
    await goto(table.position.x, table.position.y, table.position.z, { radius: 2 })
    table = findTable()
    if (!table) return false
  }
  const recipes = bot.recipesFor(id, null, 1, table)
  if (!recipes.length) return false
  try { await bot.craft(recipes[0], qty, table); return true }
  catch (e) { if (e instanceof ScopeDisposedError) throw e; return false }
}

async function ensure (itemName, min, opts) {
  const have = invCount(itemName)
  if (have >= min) return true
  return craft(itemName, min - have, opts)
}

async function ensurePlanks (minPlanks = 4) {
  if (invCountAny(PLANK_NAMES) >= minPlanks) return true
  for (const log of LOG_NAMES) {
    const n = invCount(log)
    if (!n) continue
    await craft(log.replace('_log', '_planks'), n, { needsTable: false })
    if (invCountAny(PLANK_NAMES) >= minPlanks) return true
  }
  return invCountAny(PLANK_NAMES) >= minPlanks
}

async function ensureSticks (minSticks = 4) {
  if (invCount('stick') >= minSticks) return true
  if (invCountAny(PLANK_NAMES) < 2) await ensurePlanks(2)
  await craft('stick', Math.ceil((minSticks - invCount('stick')) / 4), { needsTable: false })
  return invCount('stick') >= minSticks
}

async function smelt (oreName, qty, opts = {}) {
  const furnaceBlock = findFurnace()
  if (!furnaceBlock) return 0
  await goto(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, { radius: 2 })
  const fresh = findFurnace()
  if (!fresh) return 0

  const oreItem = invItems().find(i => i.name === oreName)
  if (!oreItem) return 0

  let fuelItem = opts.fuel ? invItems().find(i => i.name === opts.fuel) : null
  if (!fuelItem) {
    fuelItem = invItems().find(i => LOG_NAMES.includes(i.name))
            ?? invItems().find(i => i.name?.endsWith('_planks'))
  }
  if (!fuelItem) return 0

  const n     = Math.min(qty, oreItem.count)
  const fuelN = Math.max(1, Math.min(fuelItem.count, Math.ceil(n / 1.5)))

  let f
  try { f = await withTimeout(bot.openFurnace(fresh), 5000) }
  catch (e) { if (e instanceof ScopeDisposedError) throw e; return 0 }

  // Map ore -> ingot name so we can measure actual yield (not the requested qty).
  const ingotName =
    oreName === 'raw_iron'    ? 'iron_ingot' :
    oreName === 'raw_copper'  ? 'copper_ingot' :
    oreName === 'raw_gold'    ? 'gold_ingot' :
    oreName.endsWith('_ore')  ? oreName.replace('_ore', '_ingot') :
    null
  const before = ingotName ? invCount(ingotName) : 0

  try {
    await f.putInput(oreItem.type, oreItem.metadata ?? null, n)
    await f.putFuel(fuelItem.type, fuelItem.metadata ?? null, fuelN)
    // Poll: drain the output slot as smelts complete, exit when we've got `n` or time runs out.
    const deadline = Date.now() + (n * 12000 + 6000)
    while (Date.now() < deadline) {
      await sleep(800)
      if (f.outputItem()) {
        try { await f.takeOutput() } catch (_) {}
      }
      if (ingotName && invCount(ingotName) - before >= n) break
    }
    return ingotName ? invCount(ingotName) - before : (f.outputItem() ? n : 0)
  } catch (e) {
    if (e instanceof ScopeDisposedError) { try { f.close() } catch (_) {}; throw e }
    return ingotName ? invCount(ingotName) - before : 0
  } finally { try { f.close() } catch (_) {} }
}

async function equipBest (preferList, slot = 'hand') {
  for (const name of preferList) {
    const item = invItems().find(i => i.name === name)
    if (item) { try { await bot.equip(item, slot) } catch (_) {}; return item }
  }
  return null
}

const PICK_ORDER   = ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe','stone_pickaxe','wooden_pickaxe','golden_pickaxe']
const SWORD_ORDER  = ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword','golden_sword']
const SHOVEL_ORDER = ['netherite_shovel','diamond_shovel','iron_shovel','stone_shovel','wooden_shovel','golden_shovel']

const equipBestPickaxe = () => equipBest(PICK_ORDER)
const equipBestSword   = () => equipBest(SWORD_ORDER)
const equipBestShovel  = () => equipBest(SHOVEL_ORDER)

async function openChestAt (pos) {
  if (!pos) return null
  const cb = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
  if (cb?.name !== 'chest') return null
  try { return await withTimeout(bot.openChest(cb), 5000) }
  catch (e) { if (e instanceof ScopeDisposedError) throw e; return null }
}

async function takeFromHome (filter) {
  const home = stateGet('home')
  if (!home) return []
  await goto(home.x, home.y, home.z, { radius: 1 })
  try { await bot.unequip('hand') } catch (_) {}
  const chest = await openChestAt(home)
  if (!chest) return []
  const taken = []
  try {
    const slots = chest.slots.slice(0, chest.inventoryStart ?? 27).filter(Boolean)
    for (const s of slots) {
      if (filter(s)) {
        try { await chest.withdraw(s.type, s.metadata ?? null, s.count); taken.push(s) }
        catch (_) {}
      }
    }
  } finally { try { chest.close() } catch (_) {} }
  return taken
}

const STANDARD_KIT = [
  { name: 'iron_pickaxe', count: 2 },
  { name: 'iron_sword',   count: 2 },
  { name: 'iron_shovel',  count: 2 },
  { name: 'bread',        count: 64 },
]

function kitMissing () {
  return STANDARD_KIT
    .map(k => ({ name: k.name, have: invCount(k.name), need: k.count, short: k.count - invCount(k.name) }))
    .filter(k => k.short > 0)
}

bot.kit = {
  iid, bid,
  LOG_NAMES, PLANK_NAMES,
  invItems, invCount, invCountAny,
  withTimeout, goto, goHome, goToStation, stationPos,
  findTable, findFurnace, findHomeChest, findOutputChest, openChestAt,
  craft, ensure, ensurePlanks, ensureSticks, smelt,
  equipBest, equipBestPickaxe, equipBestSword, equipBestShovel,
  PICK_ORDER, SWORD_ORDER, SHOVEL_ORDER,
  takeFromHome,
  STANDARD_KIT, kitMissing,
}

run(async () => {
  report({ kind: 'ready' })
  // Keep the scope alive so the helpers' closures over sleep/signal stay valid.
  while (!signal.aborted) await sleep(60000)
})

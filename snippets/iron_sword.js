// One-shot: craft an iron sword. Waits for an iron pickaxe (bootstrap provides one),
// then mines 2 more iron ore, smelts, and crafts the sword.
// Reads furnacePos and tablePos from state (set by recharge).
declareState('furnacePos', { type: 'vec3', export: true })
declareState('tablePos',   { type: 'vec3', export: true })

run(async () => {
  const reg = bot.registry
  const iid = n => reg.itemsByName[n]?.id
  const bid = n => reg.blocksByName[n]?.id

  const IRON_SWORD    = iid('iron_sword')
  const IRON_INGOT    = iid('iron_ingot')
  const STICK_ID      = iid('stick')
  const TABLE_BLOCK   = bid('crafting_table')
  const FURNACE_BLOCK = bid('furnace')

  const LOG_NAMES = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log']

  const inv    = () => bot.inventory.items()
  const count  = id => id == null ? 0 : inv().filter(i => i.type === id).reduce((s,i) => s+i.count, 0)
  const hasPick = () => inv().find(i => i.name === 'iron_pickaxe')
  const rawIron = () => count(iid('raw_iron')) + count(iid('iron_ore'))

  async function withTimeout(p, ms) {
    return Promise.race([p, sleep(ms).then(() => { throw new Error('timeout') })])
  }

  async function goto(x, y, z, r = 2, ms = 30000) {
    if (!bot.pathfinder || !GoalNear) return
    try { await withTimeout(bot.pathfinder.goto(new GoalNear(x, y, z, r)), ms) }
    catch (e) { if (e instanceof ScopeDisposedError) throw e }
  }

  function freshBlock(pos) {
    if (!pos) return null
    const b = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
    return b?.name !== 'air' ? b : null
  }

  // Already done?
  if (inv().find(i => i.name === 'iron_sword')) {
    report({ kind: 'done', reason: 'already have iron sword' })
    return stop('done')
  }

  // Wait for iron pickaxe from bootstrap
  report({ kind: 'waiting', for: 'iron_pickaxe' })
  while (!signal.aborted && !hasPick()) {
    await sleep(5000)
  }
  if (signal.aborted) return
  report({ kind: 'have-pickaxe' })

  const pick = hasPick()
  if (pick) try { await bot.equip(pick, 'hand') } catch (_) {}

  if (bot.pathfinder?.movements) {
    bot.pathfinder.movements.canDig = true
    bot.pathfinder.movements.maxDropDown = 4
  }

  // Mine 2 iron ore
  report({ kind: 'mining-iron' })
  const isOre = b => b.name === 'iron_ore' || b.name === 'deepslate_iron_ore'
  while (!signal.aborted && rawIron() < 2) {
    const b = bot.findBlock({ matching: isOre, maxDistance: 64 })
    if (!b) { report({ kind: 'searching', for: 'iron' }); await sleep(3000); continue }
    await goto(b.position.x, b.position.y, b.position.z, 3, 20000)
    if (signal.aborted) return
    const block = bot.blockAt(b.position)
    if (!block || block.name === 'air') continue
    const p = hasPick()
    if (p) try { await bot.equip(p, 'hand') } catch (_) {}
    try { await bot.dig(block, true); await sleep(300) }
    catch (e) { if (e instanceof ScopeDisposedError) return; await sleep(500) }
  }
  if (signal.aborted) return
  report({ kind: 'have-iron', count: rawIron() })

  // Find furnace
  const furnaceBlock = freshBlock(stateGet('furnacePos'))
    ?? (FURNACE_BLOCK ? bot.findBlock({ matching: FURNACE_BLOCK, maxDistance: 128 }) : null)
  if (!furnaceBlock) { report({ kind: 'fatal', reason: 'furnace not found' }); return }

  await goto(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2, 60000)
  if (signal.aborted) return

  const oreItem  = inv().find(i => i.name === 'raw_iron' || i.name === 'iron_ore')
  const fuelItem = inv().find(i => LOG_NAMES.includes(i.name)) || inv().find(i => i.name?.endsWith('_planks'))
  if (!oreItem)  { report({ kind: 'fatal', reason: 'no ore to smelt' }); return }
  if (!fuelItem) { report({ kind: 'fatal', reason: 'no fuel' }); return }

  const smeltQty = Math.min(2, oreItem.count)
  const fuelQty  = Math.max(1, Math.ceil(smeltQty / 1.5))
  report({ kind: 'smelting', qty: smeltQty, fuel: fuelItem.name })

  let furnace
  try { furnace = await withTimeout(bot.openFurnace(furnaceBlock), 5000) }
  catch (e) { if (e instanceof ScopeDisposedError) throw e; report({ kind: 'fatal', reason: 'cannot open furnace' }); return }

  try {
    await furnace.putInput(oreItem.type, oreItem.metadata ?? null, smeltQty)
    await furnace.putFuel(fuelItem.type, fuelItem.metadata ?? null, Math.min(fuelQty, fuelItem.count))
    await sleep(smeltQty * 12000 + 3000)
    if (furnace.outputItem()) await furnace.takeOutput()
    report({ kind: 'smelted', ingots: count(IRON_INGOT) })
  } catch (e) {
    if (e instanceof ScopeDisposedError) { try { furnace.close() } catch (_) {}; return }
    report({ kind: 'smelt-error', message: e.message })
  } finally {
    try { furnace.close() } catch (_) {}
  }
  if (signal.aborted) return

  if (count(IRON_INGOT) < 2) { report({ kind: 'fatal', reason: `only ${count(IRON_INGOT)} ingots` }); return }

  // Find crafting table
  const tableBlock = freshBlock(stateGet('tablePos'))
    ?? (TABLE_BLOCK ? bot.findBlock({ matching: TABLE_BLOCK, maxDistance: 32 }) : null)
  if (!tableBlock) { report({ kind: 'fatal', reason: 'crafting table not found' }); return }

  await goto(tableBlock.position.x, tableBlock.position.y, tableBlock.position.z, 2, 30000)
  if (signal.aborted) return

  // Craft sticks if needed
  if (count(STICK_ID) < 1) {
    const r = bot.recipesFor(STICK_ID, null, 1, null)
    if (r.length) try { await bot.craft(r[0], 1, null) } catch (e) { if (e instanceof ScopeDisposedError) return }
  }

  // Craft iron sword
  if (!IRON_SWORD) { report({ kind: 'fatal', reason: 'iron_sword not in registry' }); return }
  const r = bot.recipesFor(IRON_SWORD, null, 1, tableBlock)
  if (!r.length) { report({ kind: 'fatal', reason: 'no iron sword recipe' }); return }
  try { await bot.craft(r[0], 1, tableBlock) }
  catch (e) { if (e instanceof ScopeDisposedError) return; report({ kind: 'craft-error', message: e.message }); return }

  const sword = inv().find(i => i.name === 'iron_sword')
  if (!sword) { report({ kind: 'fatal', reason: 'no sword after craft' }); return }
  try { await bot.equip(sword, 'hand') } catch (_) {}
  report({ kind: 'done', item: 'iron_sword' })
  stop('done')
})

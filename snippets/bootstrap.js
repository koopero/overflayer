// One-shot: acquire an iron pickaxe from scratch.
// Checks input chest first; otherwise gathers, crafts, and smelts the whole chain.
// Reads inputChest from player state (set by recharge).
declareState('inputChest', { type: 'vec3', export: true })

run(async () => {
  const reg = bot.registry
  const bid = n => reg.blocksByName[n]?.id
  const iid = n => reg.itemsByName[n]?.id

  const IRON_PICKAXE   = iid('iron_pickaxe')
  const STONE_PICKAXE  = iid('stone_pickaxe')
  const WOODEN_PICKAXE = iid('wooden_pickaxe')
  const TABLE_ITEM     = iid('crafting_table')
  const TABLE_BLOCK    = bid('crafting_table')
  const FURNACE_BLOCK  = bid('furnace')
  const RAW_IRON       = iid('raw_iron')
  const IRON_INGOT     = iid('iron_ingot')
  const STICK          = iid('stick')
  const COBBLE         = iid('cobblestone')

  const LOG_NAMES  = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log']
  const STONE_NAMES = ['stone','granite','diorite','andesite']
  const logIds   = new Set(LOG_NAMES.map(bid).filter(Boolean))
  const stoneIds = new Set(STONE_NAMES.map(bid).filter(Boolean))
  const PICK_ORDER = ['diamond_pickaxe','iron_pickaxe','stone_pickaxe','wooden_pickaxe','golden_pickaxe']

  const inv    = () => bot.inventory.items()
  const count  = id  => id == null ? 0 : inv().filter(i => i.type === id).reduce((s,i) => s+i.count, 0)
  const countN = ns  => inv().filter(i => ns.includes(i.name)).reduce((s,i) => s+i.count, 0)
  const planks = ()  => inv().filter(i => i.name.endsWith('_planks')).reduce((s,i) => s+i.count, 0)
  const rawIron = () => count(RAW_IRON) + count(iid('iron_ore'))

  async function withTimeout (p, ms) {
    return Promise.race([p, sleep(ms).then(() => { throw new Error('timeout') })])
  }

  async function goto (x, y, z, r = 2, ms = 30000) {
    if (!bot.pathfinder || !GoalNear) return
    try { await withTimeout(bot.pathfinder.goto(new GoalNear(x, y, z, r)), ms) }
    catch (e) { if (e instanceof ScopeDisposedError) throw e }
  }

  async function equipBest () {
    for (const name of PICK_ORDER) {
      const item = inv().find(i => i.name === name)
      if (item) { try { await bot.equip(item, 'hand') } catch (_) {}; return item }
    }
    return null
  }

  async function ensureTable () {
    let b = TABLE_BLOCK ? bot.findBlock({ matching: TABLE_BLOCK, maxDistance: 16 }) : null
    if (b) return b
    let item = inv().find(i => i.type === TABLE_ITEM)
    if (!item) {
      const r = bot.recipesFor(TABLE_ITEM, null, 1, null)
      if (!r.length) return null
      try { await bot.craft(r[0], 1, null) } catch (e) { if (e instanceof ScopeDisposedError) throw e }
      item = inv().find(i => i.type === TABLE_ITEM)
    }
    if (!item) return null
    await bot.equip(item, 'hand')
    const pos = bot.entity.position.floored()
    for (const dir of [new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(0,0,-1)]) {
      const ground = bot.blockAt(pos.plus(dir).offset(0,-1,0))
      const space  = bot.blockAt(pos.plus(dir))
      if (ground?.boundingBox === 'block' && space?.name === 'air') {
        try {
          await bot.placeBlock(ground, new Vec3(0,1,0))
          await sleep(200)
          return bot.findBlock({ matching: TABLE_BLOCK, maxDistance: 6 })
        } catch (e) { if (e instanceof ScopeDisposedError) throw e }
      }
    }
    return null
  }

  async function craftItem (itemId, qty, needTable = true) {
    const table = needTable ? await ensureTable() : null
    if (needTable && !table) { report({ kind: 'no-table' }); return false }
    if (table) await goto(table.position.x, table.position.y, table.position.z)
    if (signal.aborted) return false
    const r = bot.recipesFor(itemId, null, 1, table)
    if (!r.length) { report({ kind: 'no-recipe', for: itemId }); return false }
    try { await bot.craft(r[0], qty, table); return true }
    catch (e) { if (e instanceof ScopeDisposedError) throw e; return false }
  }

  // Allow digging through terrain
  if (bot.pathfinder?.movements) {
    bot.pathfinder.movements.canDig      = true
    bot.pathfinder.movements.maxDropDown = 4
    bot.pathfinder.movements.allowParkour = false
  }

  // --- 0. Surface first if underground ---
  const deepUnderground = bot.entity.position.y < 55
  const noLogsNear = !bot.findBlock({ matching: b => logIds.has(b.type), maxDistance: 64 })
  if ((deepUnderground || noLogsNear) && bot.pathfinder && GoalY) {
    report({ kind: 'surfacing', y: Math.floor(bot.entity.position.y) })
    try {
      await withTimeout(bot.pathfinder.goto(new GoalY(80)), 45000)
    } catch (e) {
      if (e instanceof ScopeDisposedError) throw e
      try { bot.pathfinder.setGoal(null) } catch (_) {}
    }
  }
  if (signal.aborted) return

  // --- 1. Already equipped? ---
  if (count(IRON_PICKAXE) > 0) {
    await equipBest()
    report({ kind: 'done', reason: 'already have iron pickaxe' })
    return stop('done')
  }

  // --- 2. Check input chest ---
  const inputPos = stateGet('inputChest')
  if (inputPos) {
    const cb = bot.blockAt(new Vec3(inputPos.x, inputPos.y, inputPos.z))
    if (cb?.name === 'chest') {
      report({ kind: 'checking-chest' })
      await goto(inputPos.x, inputPos.y, inputPos.z, 1, 60000)
      if (signal.aborted) return
      try { await bot.unequip('hand') } catch (_) {}
      await sleep(200)
      let chest
      try { chest = await withTimeout(bot.openChest(cb), 5000) } catch (e) { if (e instanceof ScopeDisposedError) throw e }
      if (chest) {
        try {
          const slots = chest.slots.slice(0, chest.inventoryStart ?? 27).filter(Boolean)
          const pick  = slots.find(i => i.name === 'iron_pickaxe')
          if (pick) {
            await chest.withdraw(pick.type, pick.metadata ?? null, 1)
            await equipBest()
            report({ kind: 'done', source: 'chest' })
            chest.close()
            return stop('done')
          }
        } finally { try { chest.close() } catch (_) {} }
      }
    }
  }

  report({ kind: 'bootstrapping' })

  // --- 2. Gather logs ---
  let logStreak = 0
  while (!signal.aborted && countN(LOG_NAMES) < 6) {
    const b = bot.findBlock({ matching: b => logIds.has(b.type), maxDistance: 64 })
    if (!b) {
      logStreak++
      report({ kind: 'searching', for: 'logs', streak: logStreak })
      if (logStreak >= 3 && bot.pathfinder && GoalNear) {
        const me = bot.entity.position
        const wx = me.x + (Math.random() - 0.5) * 100
        const wz = me.z + (Math.random() - 0.5) * 100
        report({ kind: 'wandering', to: { x: Math.round(wx), z: Math.round(wz) } })
        await goto(wx, me.y, wz, 5, 25000)
        logStreak = 0
      } else {
        await sleep(3000)
      }
      continue
    }
    logStreak = 0
    report({ kind: 'chopping', at: b.position })
    await goto(b.position.x, b.position.y, b.position.z, 3)
    if (signal.aborted) return
    try { await bot.dig(b); await sleep(400) }
    catch (e) { if (e instanceof ScopeDisposedError) return; await sleep(500) }
  }
  if (signal.aborted) return

  // --- 3. Craft planks → sticks → wooden pickaxe ---
  for (const log of LOG_NAMES) {
    const logId = iid(log); const plankId = iid(log.replace('_log', '_planks'))
    if (!logId || !plankId) continue
    const n = count(logId); if (!n) continue
    const r = bot.recipesFor(plankId, null, 1, null)
    if (r.length) try { await bot.craft(r[0], n, null) } catch (e) { if (e instanceof ScopeDisposedError) return }
  }
  if (signal.aborted) return

  if (!inv().find(i => i.name.endsWith('_pickaxe'))) {
    // Need sticks first (2x2, no table)
    if (count(STICK) < 2 && planks() >= 2) {
      const r = bot.recipesFor(STICK, null, 1, null)
      if (r.length) try { await bot.craft(r[0], 1, null) } catch (e) { if (e instanceof ScopeDisposedError) return }
    }
    report({ kind: 'crafting', item: 'wooden_pickaxe' })
    await craftItem(WOODEN_PICKAXE, 1)
  }

  // --- 4. Mine cobblestone ---
  await equipBest()
  while (!signal.aborted && count(COBBLE) < 8) {
    const b = bot.findBlock({ matching: b => stoneIds.has(b.type), maxDistance: 32 })
    if (!b) { report({ kind: 'searching', for: 'stone' }); await sleep(3000); continue }
    report({ kind: 'mining', block: 'stone', at: b.position })
    await goto(b.position.x, b.position.y, b.position.z, 3)
    if (signal.aborted) return
    const block = bot.blockAt(b.position)
    if (!block || block.name === 'air') continue
    try { await bot.dig(block, true); await sleep(300) }
    catch (e) { if (e instanceof ScopeDisposedError) return; await sleep(500) }
  }
  if (signal.aborted) return

  // --- 5. Craft stone pickaxe ---
  report({ kind: 'crafting', item: 'stone_pickaxe' })
  if (count(STICK) < 2) {
    const r = bot.recipesFor(STICK, null, 1, null)
    if (r.length) try { await bot.craft(r[0], 1, null) } catch (e) { if (e instanceof ScopeDisposedError) return }
  }
  await craftItem(STONE_PICKAXE, 1)
  await equipBest()

  // --- 6. Mine iron ore ---
  const isOre = b => b.name === 'iron_ore' || b.name === 'deepslate_iron_ore'
  while (!signal.aborted && rawIron() < 3) {
    const b = bot.findBlock({ matching: isOre, maxDistance: 48 })
    if (!b) { report({ kind: 'searching', for: 'iron' }); await sleep(3000); continue }
    report({ kind: 'mining', block: b.name, at: b.position })
    await goto(b.position.x, b.position.y, b.position.z, 3, 20000)
    if (signal.aborted) return
    const sameY = Math.abs(b.position.y - Math.floor(bot.entity.position.y)) <= 1
    const dist  = bot.entity.position.distanceTo(b.position.offset(0.5, 0.5, 0.5))
    if (!sameY && dist > 3.5) { await sleep(500); continue }
    const block = bot.blockAt(b.position)
    if (!block || block.name === 'air') continue
    await equipBest()
    try { await bot.dig(block, true); await sleep(300) }
    catch (e) { if (e instanceof ScopeDisposedError) return; await sleep(500) }
  }
  if (signal.aborted) return
  report({ kind: 'have-iron', count: rawIron() })

  // --- 7. Navigate to station furnace ---
  const furnaceBlock = FURNACE_BLOCK ? bot.findBlock({ matching: FURNACE_BLOCK, maxDistance: 128 }) : null
  if (!furnaceBlock) { report({ kind: 'fatal', reason: 'furnace not found — run recharge first' }); return }
  report({ kind: 'navigating', to: 'furnace' })
  await goto(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2, 90000)
  if (signal.aborted) return

  // --- 8. Smelt iron ---
  const oreItem  = inv().find(i => i.name === 'raw_iron' || i.name === 'iron_ore')
  const fuelItem = inv().find(i => LOG_NAMES.includes(i.name)) ||
                   inv().find(i => i.name?.endsWith('_planks'))
  if (!oreItem)  { report({ kind: 'fatal', reason: 'no ore to smelt' }); return }
  if (!fuelItem) { report({ kind: 'fatal', reason: 'no fuel' }); return }

  const smeltQty  = Math.min(3, oreItem.count)
  const fuelQty   = Math.min(Math.ceil(smeltQty / 1.5), fuelItem.count)
  report({ kind: 'smelting', qty: smeltQty, fuel: fuelItem.name })

  let furnace
  try { furnace = await withTimeout(bot.openFurnace(furnaceBlock), 5000) }
  catch (e) { if (e instanceof ScopeDisposedError) throw e; report({ kind: 'fatal', reason: 'cannot open furnace' }); return }

  try {
    await furnace.putInput(oreItem.type, oreItem.metadata ?? null, smeltQty)
    await furnace.putFuel(fuelItem.type, fuelItem.metadata ?? null, fuelQty)
    await sleep(smeltQty * 12000 + 3000)
    const out = furnace.outputItem()
    if (out) { await furnace.takeOutput(); report({ kind: 'smelted', ingots: count(IRON_INGOT) }) }
    else     { report({ kind: 'fatal', reason: 'no output — check fuel/ore' }); return }
  } catch (e) {
    if (e instanceof ScopeDisposedError) { try { furnace.close() } catch (_) {}; return }
    report({ kind: 'smelt-error', message: e.message }); return
  } finally { try { furnace.close() } catch (_) {} }

  // --- 9. Craft iron pickaxe ---
  if (count(STICK) < 2) {
    const r = bot.recipesFor(STICK, null, 1, null)
    if (r.length) try { await bot.craft(r[0], 1, null) } catch (e) { if (e instanceof ScopeDisposedError) return }
  }
  report({ kind: 'crafting', item: 'iron_pickaxe' })
  const ok = await craftItem(IRON_PICKAXE, 1)
  if (!ok) { report({ kind: 'fatal', reason: 'iron pickaxe craft failed' }); return }

  await equipBest()
  report({ kind: 'done', item: 'iron_pickaxe' })
  stop('done')
})

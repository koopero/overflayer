// Bootstrap: full self-contained state machine.
// Progresses through: surface → logs → table → stone(surface) → pickaxe → iron → smelt → iron_pickaxe
// Reads inputChest from state (set by recharge) if available.
// Calls stop('done') on success; never needs external snippet swaps.

declareState('inputChest',  { type: 'vec3', export: true })
declareState('furnacePos',  { type: 'vec3', export: true })
declareState('tablePos',    { type: 'vec3', export: true })

run(async () => {
  if (!bot.kit) await snippetLoad('lib_craft')
  const k = bot.kit

  const reg = bot.registry
  const bid = n => reg.blocksByName[n]?.id
  const iid = n => reg.itemsByName[n]?.id

  const IRON_PICKAXE   = iid('iron_pickaxe')
  const STONE_PICKAXE  = iid('stone_pickaxe')
  const WOODEN_PICKAXE = iid('wooden_pickaxe')
  const FURNACE_BLOCK  = bid('furnace')
  const RAW_IRON       = iid('raw_iron')
  const IRON_INGOT     = iid('iron_ingot')

  const LOG_NAMES   = k.LOG_NAMES
  const STONE_NAMES = ['stone', 'granite', 'diorite', 'andesite']

  const logIds   = new Set(LOG_NAMES.map(bid).filter(Boolean))
  const stoneIds = new Set(STONE_NAMES.map(bid).filter(Boolean))

  const inv      = () => bot.inventory.items()
  const count    = id => id == null ? 0 : inv().filter(i => i.type === id).reduce((s,i) => s+i.count, 0)
  const countN   = ns => inv().filter(i => ns.includes(i.name)).reduce((s,i) => s+i.count, 0)
  const rawIron  = () => count(RAW_IRON) + count(iid('iron_ore'))
  const PICK_ORDER = ['diamond_pickaxe','iron_pickaxe','stone_pickaxe','wooden_pickaxe','golden_pickaxe']

  // ── helpers ────────────────────────────────────────────────────────────────

  if (bot.pathfinder?.movements) {
    bot.pathfinder.movements.canDig     = true
    bot.pathfinder.movements.digCost    = 128        // high cost — prefer routing around
    bot.pathfinder.movements.maxDropDown = 4
    bot.pathfinder.movements.allowSprinting = true
  }

  async function surface () {
    if (bot.entity.position.y >= 62) return
    report({ kind: 'surfacing', y: Math.floor(bot.entity.position.y) })
    try { await k.withTimeout(bot.pathfinder.goto(new GoalY(70)), 60000) } catch (_) {}
  }


  async function ensureBestPick () {
    for (const name of PICK_ORDER) {
      const item = inv().find(i => i.name === name)
      if (item) { try { await bot.equip(item, 'hand') } catch (_) {}; return item }
    }
    return null
  }

  // ── STEP 0: Already done? ──────────────────────────────────────────────────
  if (count(IRON_PICKAXE) > 0) {
    await ensureBestPick()
    report({ kind: 'done', reason: 'already have iron pickaxe' })
    return stop('done')
  }

  // ── STEP 1: Surface ────────────────────────────────────────────────────────
  await surface()
  if (signal.aborted) return

  // ── STEP 2: Check input chest ──────────────────────────────────────────────
  const inputPos = stateGet('inputChest')
  if (inputPos) {
    const cb = bot.blockAt(new Vec3(inputPos.x, inputPos.y, inputPos.z))
    if (cb?.name === 'chest') {
      report({ kind: 'checking-chest' })
      await k.goto(inputPos.x, inputPos.y, inputPos.z, { radius: 1, timeout: 60000 })
      if (!signal.aborted) {
        try { await bot.unequip('hand') } catch (_) {}
        await new Promise(r => setTimeout(r, 200))
        let chest
        try { chest = await k.withTimeout(bot.openChest(cb), 5000) } catch (_) {}
        if (chest) {
          try {
            const slots = chest.slots.slice(0, chest.inventoryStart ?? 27).filter(Boolean)
            const pick  = slots.find(i => i.name === 'iron_pickaxe')
            if (pick) {
              await chest.withdraw(pick.type, pick.metadata ?? null, 1)
              await ensureBestPick()
              report({ kind: 'done', source: 'chest' })
              chest.close()
              return stop('done')
            }
          } finally { try { chest.close() } catch (_) {} }
        }
      }
    }
  }

  report({ kind: 'bootstrapping' })

  // ── STEP 3: Gather logs ────────────────────────────────────────────────────
  let logStreak = 0
  while (!signal.aborted && countN(LOG_NAMES) < 6) {
    const b = bot.findBlock({ matching: b => logIds.has(b.type), maxDistance: 64 })
    if (!b) {
      logStreak++
      if (logStreak >= 3) {
        const me = bot.entity.position
        const wx = me.x + (Math.random() - 0.5) * 100
        const wz = me.z + (Math.random() - 0.5) * 100
        report({ kind: 'wandering', to: { x: Math.round(wx), z: Math.round(wz) } })
        await k.goto(wx, me.y, wz, { radius: 5, timeout: 25000 })
        logStreak = 0
      } else {
        report({ kind: 'searching', for: 'logs' })
        await new Promise(r => setTimeout(r, 3000))
      }
      continue
    }
    logStreak = 0
    report({ kind: 'chopping', at: b.position })
    await k.goto(b.position.x, b.position.y, b.position.z, { radius: 3, timeout: 20000 })
    if (signal.aborted) return
    try { await bot.dig(b); await new Promise(r => setTimeout(r, 400)) }
    catch (e) { if (e instanceof ScopeDisposedError) return; await new Promise(r => setTimeout(r, 500)) }
  }
  if (signal.aborted) return

  // ── STEP 4: Craft planks → sticks → wooden pickaxe ────────────────────────
  for (const log of LOG_NAMES) {
    const logId   = iid(log)
    const plankId = iid(log.replace('_log', '_planks'))
    if (!logId || !plankId) continue
    const n = count(logId); if (!n) continue
    const r = bot.recipesFor(plankId, null, 1, null)
    if (r.length) try { await bot.craft(r[0], n, null) } catch (e) { if (e instanceof ScopeDisposedError) return }
  }
  if (signal.aborted) return

  if (!inv().find(i => i.name.endsWith('_pickaxe'))) {
    if (k.invCountAny(k.PLANK_NAMES) >= 2) {
      const r = bot.recipesFor(iid('stick'), null, 1, null)
      if (r.length) try { await bot.craft(r[0], 1, null) } catch (_) {}
    }
    report({ kind: 'crafting', item: 'wooden_pickaxe' })
    await k.craft('wooden_pickaxe', 1, { needsTable: false })
      .catch(() => {
        // Fallback: need table first
      })
  }

  // ── STEP 5: Surface stone — prefer exposed cliff/hillside blocks ───────────
  await ensureBestPick()
  let stoneStreak = 0
  while (!signal.aborted && k.invCount('cobblestone') < 8) {
    const stonePos = k.findSurfaceStone(48)
    if (!stonePos) {
      stoneStreak++
      report({ kind: 'searching', for: 'surface-stone', streak: stoneStreak })
      if (stoneStreak >= 3) {
        // Wander a bit to expose new chunks
        const me = bot.entity.position
        await k.goto(me.x + (Math.random()-0.5)*60, me.y, me.z + (Math.random()-0.5)*60, { radius: 5, timeout: 20000 })
        stoneStreak = 0
      } else {
        await new Promise(r => setTimeout(r, 2000))
      }
      continue
    }
    stoneStreak = 0
    report({ kind: 'mining-stone', at: stonePos, cobble: k.invCount('cobblestone') })
    await k.goto(stonePos.x, stonePos.y, stonePos.z, { radius: 2, timeout: 15000 })
    if (signal.aborted) return
    const block = bot.blockAt(stonePos)
    if (!block || block.name === 'air') continue
    await ensureBestPick()
    try { await bot.dig(block, true); await new Promise(r => setTimeout(r, 300)) }
    catch (e) { if (e instanceof ScopeDisposedError) return; await new Promise(r => setTimeout(r, 500)) }
  }
  if (signal.aborted) return

  // ── STEP 6: Craft stone pickaxe (needs table) ──────────────────────────────
  report({ kind: 'crafting', item: 'stone_pickaxe' })
  await k.ensureSticks(2)
  await k.craft('stone_pickaxe', 1)
  await ensureBestPick()

  // ── STEP 7: Mine iron ore ──────────────────────────────────────────────────
  const isOre = b => b.name === 'iron_ore' || b.name === 'deepslate_iron_ore'
  // Iron ore is usually underground — this is the ONE place we allow going down,
  // but we descend purposefully near our current position, not via pathfinder.
  while (!signal.aborted && rawIron() < 3) {
    const b = bot.findBlock({ matching: isOre, maxDistance: 48 })
    if (!b) { report({ kind: 'searching', for: 'iron' }); await new Promise(r => setTimeout(r, 3000)); continue }
    report({ kind: 'mining', block: b.name, at: b.position })
    await k.goto(b.position.x, b.position.y, b.position.z, { radius: 3, timeout: 20000 })
    if (signal.aborted) return
    const sameY = Math.abs(b.position.y - Math.floor(bot.entity.position.y)) <= 1
    const dist  = bot.entity.position.distanceTo(b.position.offset(0.5, 0.5, 0.5))
    if (!sameY && dist > 3.5) { await new Promise(r => setTimeout(r, 500)); continue }
    const block = bot.blockAt(b.position)
    if (!block || block.name === 'air') continue
    await ensureBestPick()
    try { await bot.dig(block, true); await new Promise(r => setTimeout(r, 300)) }
    catch (e) { if (e instanceof ScopeDisposedError) return; await new Promise(r => setTimeout(r, 500)) }
  }
  if (signal.aborted) return
  report({ kind: 'have-iron', count: rawIron() })

  // After going underground for iron, surface again before smelting
  await surface()
  if (signal.aborted) return

  // ── STEP 8: Find furnace ───────────────────────────────────────────────────
  const furnaceBlock = FURNACE_BLOCK ? bot.findBlock({ matching: FURNACE_BLOCK, maxDistance: 128 }) : null
  if (!furnaceBlock) {
    report({ kind: 'fatal', reason: 'furnace not found — run recharge first' })
    return
  }
  report({ kind: 'navigating', to: 'furnace' })
  // Navigate to furnace without digging (to preserve iron)
  if (bot.pathfinder?.movements) bot.pathfinder.movements.canDig = false
  await k.goto(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, { radius: 2, timeout: 90000 })
  if (bot.pathfinder?.movements) bot.pathfinder.movements.canDig = true
  if (signal.aborted) return

  // ── STEP 9: Smelt iron ─────────────────────────────────────────────────────
  const oreItem  = inv().find(i => i.name === 'raw_iron' || i.name === 'iron_ore')
  const fuelItem = inv().find(i => LOG_NAMES.includes(i.name))
                ?? inv().find(i => i.name?.endsWith('_planks'))
  if (!oreItem)  { report({ kind: 'fatal', reason: 'no ore to smelt' }); return }
  if (!fuelItem) { report({ kind: 'fatal', reason: 'no fuel' }); return }

  const smeltQty = Math.min(3, oreItem.count)
  const fuelQty  = Math.min(Math.ceil(smeltQty / 1.5), fuelItem.count)
  report({ kind: 'smelting', qty: smeltQty })

  let furnace
  try { furnace = await k.withTimeout(bot.openFurnace(furnaceBlock), 5000) }
  catch (e) { if (e instanceof ScopeDisposedError) throw e; report({ kind: 'fatal', reason: 'cannot open furnace' }); return }

  try {
    await furnace.putInput(oreItem.type, oreItem.metadata ?? null, smeltQty)
    await furnace.putFuel(fuelItem.type, fuelItem.metadata ?? null, fuelQty)
    await new Promise(r => setTimeout(r, smeltQty * 12000 + 3000))
    const out = furnace.outputItem()
    if (out) { await furnace.takeOutput(); report({ kind: 'smelted', ingots: count(IRON_INGOT) }) }
    else      { report({ kind: 'fatal', reason: 'no output — check fuel/ore' }); return }
  } catch (e) {
    if (e instanceof ScopeDisposedError) { try { furnace.close() } catch (_) {}; return }
    report({ kind: 'smelt-error', message: e.message }); return
  } finally { try { furnace.close() } catch (_) {} }

  // ── STEP 10: Craft iron pickaxe ────────────────────────────────────────────
  await k.ensureSticks(2)
  report({ kind: 'crafting', item: 'iron_pickaxe' })
  const ok = await k.craft('iron_pickaxe', 1)
  if (!ok) { report({ kind: 'fatal', reason: 'iron pickaxe craft failed' }); return }

  await ensureBestPick()
  report({ kind: 'done', item: 'iron_pickaxe' })
  stop('done')
})

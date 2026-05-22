// Navigate to existing tablePos, craft wooden pickaxe + 2 chests, then mine cobble + craft furnace.
// Sets furnacePos, outputChest, home in state.
run(async () => {
  if (!bot.kit) await snippetLoad('lib_craft')
  const k = bot.kit

  if (bot.pathfinder?.movements) {
    bot.pathfinder.movements.canDig = true
    bot.pathfinder.movements.maxDropDown = 4
    bot.pathfinder.movements.allowSprinting = true
  }

  // --- 1. Go to table ---
  const tablePos = stateGet('tablePos')
  if (!tablePos) { report({ kind: 'fatal', reason: 'no tablePos' }); return }
  report({ kind: 'going-to-table', at: tablePos })
  await k.goto(tablePos.x, tablePos.y, tablePos.z, { radius: 2, timeout: 90000 })
  if (signal.aborted) return

  const table = k.findTable()
  if (!table) { report({ kind: 'fatal', reason: 'table not found at pos' }); return }
  report({ kind: 'at-table', pos: { x: table.position.x, y: table.position.y, z: table.position.z } })

  // --- 2. Craft tools ---
  await k.ensurePlanks(8)
  await k.ensureSticks(6)

  for (const tool of ['wooden_pickaxe', 'wooden_sword', 'wooden_axe']) {
    if (!k.invCount(tool)) {
      const ok = await k.craft(tool, 1)
      report({ kind: ok ? 'crafted' : 'craft-failed', item: tool })
    }
  }

  // --- 3. Craft 2 chests (each 8 planks) ---
  for (let i = 0; i < 2; i++) {
    if (k.invCount('chest') < (i + 1)) {
      await k.ensurePlanks(8)
      const ok = await k.craft('chest', 1)
      report({ kind: ok ? 'crafted' : 'craft-failed', item: 'chest' })
    }
  }
  if (signal.aborted) return

  if (k.invCount('chest') < 2) { report({ kind: 'fatal', reason: 'only ' + k.invCount('chest') + ' chests' }); return }

  // --- 4. Mine 8 cobblestone ---
  await k.equipBestPickaxe()
  const STONE = new Set(['stone','granite','diorite','andesite'].map(k.bid).filter(Boolean))
  let mineStreak = 0
  while (!signal.aborted && k.invCount('cobblestone') < 8) {
    const b = bot.findBlock({ matching: b => STONE.has(b.type), maxDistance: 64 })
    if (!b) {
      mineStreak++
      report({ kind: 'searching-stone', streak: mineStreak })
      if (mineStreak >= 3) {
        await k.goto(bot.entity.position.x + (Math.random()-0.5)*60, bot.entity.position.y, bot.entity.position.z + (Math.random()-0.5)*60, { radius: 5, timeout: 20000 })
        mineStreak = 0
      }
      await k.goto(tablePos.x, tablePos.y, tablePos.z, { radius: 2, timeout: 60000 })
      continue
    }
    mineStreak = 0
    report({ kind: 'mining-stone', at: b.position, cobble: k.invCount('cobblestone') })
    await k.goto(b.position.x, b.position.y, b.position.z, { radius: 2, timeout: 20000 })
    if (signal.aborted) return
    const block = bot.blockAt(b.position)
    if (!block || block.name === 'air') continue
    await k.equipBestPickaxe()
    try { await bot.dig(block); await sleep(400) }
    catch (e) { if (e instanceof ScopeDisposedError) return; await sleep(500) }
  }
  if (signal.aborted) return

  report({ kind: 'have-cobble', count: k.invCount('cobblestone') })

  // --- 5. Return to table, craft furnace ---
  await k.goto(tablePos.x, tablePos.y, tablePos.z, { radius: 2, timeout: 60000 })
  if (signal.aborted) return
  const ok = await k.craft('furnace', 1)
  report({ kind: ok ? 'crafted' : 'craft-failed', item: 'furnace' })
  if (!k.invCount('furnace')) { report({ kind: 'fatal', reason: 'no furnace item' }); return }

  // --- 6. Place chest (home) + furnace adjacent to table ---
  const tbl = k.findTable()
  if (!tbl) { report({ kind: 'fatal', reason: 'lost table' }); return }
  const tp = tbl.position

  async function placeAdjacentToTable (itemName, role) {
    for (const d of [new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1)]) {
      const destPos = tp.plus(d)
      const refPos  = destPos.offset(0,-1,0)
      const dest = bot.blockAt(destPos)
      const ref  = bot.blockAt(refPos)
      if (!ref || ref.boundingBox !== 'block') continue
      if (dest && dest.name !== 'air') continue
      const item = k.invItems().find(i => i.name === itemName)
      if (!item) break
      try {
        await bot.equip(item, 'hand')
        await bot.lookAt(refPos.offset(0.5, 1.01, 0.5), true)
        await sleep(300)
        const place = bot.placeBlock(ref, new Vec3(0,1,0))
        await Promise.race([place.then(()=>'ok'), sleep(8000).then(()=>'timeout')])
        await sleep(600)
        const placed = bot.blockAt(destPos)
        if (placed?.name === itemName) {
          report({ kind: 'placed', role, at: { x: destPos.x, y: destPos.y, z: destPos.z } })
          return { x: destPos.x, y: destPos.y, z: destPos.z }
        }
      } catch (e) {
        if (e instanceof ScopeDisposedError) return null
        // Check anyway
        await sleep(400)
        const placed = bot.blockAt(destPos)
        if (placed?.name === itemName) {
          report({ kind: 'placed', role, at: { x: destPos.x, y: destPos.y, z: destPos.z } })
          return { x: destPos.x, y: destPos.y, z: destPos.z }
        }
      }
    }
    return null
  }

  const homePos = await placeAdjacentToTable('chest', 'home')
  if (!homePos) { report({ kind: 'fatal', reason: 'could not place home chest' }); return }
  stateSet('home', homePos)

  const furnacePos = await placeAdjacentToTable('furnace', 'furnace')
  if (!furnacePos) { report({ kind: 'fatal', reason: 'could not place furnace' }); return }
  stateSet('furnacePos', furnacePos)

  // Second chest: output
  const outputPos = await placeAdjacentToTable('chest', 'output')
  if (outputPos) stateSet('outputChest', outputPos)

  report({
    kind: 'STATION-DONE',
    home: homePos,
    furnacePos,
    tablePos: { x: tp.x, y: tp.y, z: tp.z },
    outputChest: outputPos,
  })
  stop('done')
})

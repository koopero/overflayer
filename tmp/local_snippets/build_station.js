// One-shot: build the home station using EXISTING inventory.
// Skips the 9-log gather. Picks anchor at current location with relaxed scan.
declareState('home',        { type: 'vec3', export: true })
declareState('furnacePos',  { type: 'vec3', export: true })
declareState('tablePos',    { type: 'vec3', export: true })
declareState('outputChest', { type: 'vec3', export: true })

run(async () => {
  if (!bot.kit) await snippetLoad('lib_craft')
  const k = bot.kit

  const STONE_NAMES = ['stone','granite','diorite','andesite','cobblestone']
  const stoneIds = new Set(STONE_NAMES.map(k.bid).filter(Boolean))

  // Step 1: surface if needed
  if (bot.entity.position.y < 64 && bot.pathfinder && GoalY) {
    if (bot.pathfinder.movements) bot.pathfinder.movements.canDig = true
    report({ kind: 'surfacing', y: Math.floor(bot.entity.position.y) })
    try { await k.withTimeout(bot.pathfinder.goto(new GoalY(70)), 60000) }
    catch (e) { if (e instanceof ScopeDisposedError) return }
  }
  if (signal.aborted) return

  // Step 2: ensure we have the basics
  await k.ensurePlanks(8)
  await k.ensureSticks(4)
  if (!k.invCount('crafting_table')) {
    await k.craft('crafting_table', 1, { needsTable: false })
  }
  if (!k.invCount('crafting_table')) { report({ kind: 'fatal', reason: 'need crafting_table' }); return }

  // Step 3: relaxed anchor scan — any solid 1-block surface with air above
  let anchor = null, axis = 'x'
  const me = bot.entity.position.floored()
  outer:
  for (let r = 1; r <= 8; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        for (const ax of ['x', 'z']) {
          let ok = true
          for (let i = 0; i < 4; i++) {
            const off = ax === 'x' ? new Vec3(dx + i, 0, dz) : new Vec3(dx, 0, dz + i)
            const ground = bot.blockAt(me.plus(off).offset(0, -1, 0))
            const space  = bot.blockAt(me.plus(off))
            const above  = bot.blockAt(me.plus(off).offset(0, 1, 0))
            if (!ground || ground.boundingBox !== 'block') { ok = false; break }
            if (!space  || space.name  !== 'air')          { ok = false; break }
            if (!above  || above.name  !== 'air')          { ok = false; break }
          }
          if (ok) { anchor = me.plus(new Vec3(dx, 0, dz)); axis = ax; break outer }
        }
      }
    }
  }

  // Fallback: just use feet position if scan fails
  if (!anchor) {
    report({ kind: 'using-feet-fallback' })
    anchor = me
  }

  const off = (i) => axis === 'x' ? anchor.offset(i, 0, 0) : anchor.offset(0, 0, i)
  const homePos    = off(0)
  const furnacePos = off(1)
  const tablePos   = off(2)
  const outputPos  = off(3)

  async function placeAt (itemName, pos, role) {
    await k.goto(pos.x, pos.y, pos.z, { radius: 3 })
    if (signal.aborted) return false
    const existing = bot.blockAt(pos)
    if (existing && existing.name === itemName) {
      report({ kind: 'already-placed', role })
      return true
    }
    let item = k.invItems().find(i => i.name === itemName)
    if (!item) { report({ kind: 'no-item', role, want: itemName }); return false }
    // Try multiple ground candidates (below, then adjacent floors)
    const grounds = [
      pos.offset(0, -1, 0),
      pos.offset(1, 0, 0),  pos.offset(-1, 0, 0),
      pos.offset(0, 0, 1),  pos.offset(0, 0, -1),
    ]
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const gpos of grounds) {
        const ground = bot.blockAt(gpos)
        if (!ground || ground.boundingBox !== 'block') continue
        const face = gpos.equals(pos.offset(0,-1,0)) ? new Vec3(0,1,0)
                   : gpos.equals(pos.offset(1,0,0))  ? new Vec3(-1,0,0)
                   : gpos.equals(pos.offset(-1,0,0)) ? new Vec3(1,0,0)
                   : gpos.equals(pos.offset(0,0,1))  ? new Vec3(0,0,-1)
                   : new Vec3(0,0,1)
        try {
          await bot.equip(item, 'hand')
          await bot.placeBlock(ground, face)
          await sleep(400)
          const placed = bot.blockAt(pos)
          if (placed?.name === itemName) {
            report({ kind: 'placed', role, at: { x: pos.x, y: pos.y, z: pos.z } })
            return true
          }
        } catch (e) {
          if (e instanceof ScopeDisposedError) return false
          // swallow timeout/race errors and retry
        }
      }
      await sleep(500)
      item = k.invItems().find(i => i.name === itemName)
      if (!item) return false
    }
    report({ kind: 'place-failed', role })
    return false
  }

  // Step 4: place crafting table FIRST
  if (!await placeAt('crafting_table', tablePos, 'table')) return
  stateSet('tablePos', { x: tablePos.x, y: tablePos.y, z: tablePos.z })

  // Step 5: craft wooden pickaxe + first chest
  await k.ensurePlanks(8)
  await k.ensureSticks(4)
  if (!k.invItems().some(i => i.name.endsWith('_pickaxe'))) {
    report({ kind: 'crafting', item: 'wooden_pickaxe' })
    await k.craft('wooden_pickaxe', 1)
  }
  await k.equipBestPickaxe()
  if (!k.invCount('chest')) {
    report({ kind: 'crafting', item: 'chest' })
    await k.craft('chest', 1)
  }
  if (!k.invCount('chest')) { report({ kind: 'fatal', reason: 'no chest' }); return }
  if (signal.aborted) return

  // Step 6: place home chest
  if (!await placeAt('chest', homePos, 'home')) return
  stateSet('home', { x: homePos.x, y: homePos.y, z: homePos.z })

  // Step 7: mine cobblestone
  await k.equipBestPickaxe()
  if (bot.pathfinder?.movements) {
    bot.pathfinder.movements.canDig = true
    bot.pathfinder.movements.maxDropDown = 4
  }
  let mineStreak = 0
  while (!signal.aborted && k.invCount('cobblestone') < 8) {
    const b = bot.findBlock({ matching: b => stoneIds.has(b.type), maxDistance: 64 })
    if (!b) {
      mineStreak++
      report({ kind: 'searching', for: 'stone', streak: mineStreak })
      if (mineStreak >= 3) {
        // Just dig DOWN to find stone
        const below = bot.entity.position.floored().offset(0, -1, 0)
        const bb = bot.blockAt(below)
        if (bb && stoneIds.has(bb.type)) {
          try { await bot.dig(bb) } catch (_) {}
        } else {
          // wander
          const wx = bot.entity.position.x + (Math.random()-0.5)*40
          const wz = bot.entity.position.z + (Math.random()-0.5)*40
          await k.goto(wx, bot.entity.position.y, wz, { radius: 5, timeout: 20000 })
          mineStreak = 0
        }
      }
      await sleep(2000)
      continue
    }
    mineStreak = 0
    await k.goto(b.position.x, b.position.y, b.position.z, { radius: 3, timeout: 20000 })
    if (signal.aborted) return
    const block = bot.blockAt(b.position)
    if (!block || block.name === 'air') continue
    await k.equipBestPickaxe()
    try { await bot.dig(block); await sleep(400) }
    catch (e) { if (e instanceof ScopeDisposedError) return; await sleep(500) }
  }
  if (signal.aborted) return

  // Step 8: craft furnace + outputChest
  await k.ensurePlanks(8)
  if (!k.invCount('furnace')) await k.craft('furnace', 1)
  if (!k.invCount('chest'))   await k.craft('chest', 1)
  if (signal.aborted) return

  // Step 9: place furnace and outputChest
  if (!await placeAt('furnace', furnacePos, 'furnace')) return
  stateSet('furnacePos', { x: furnacePos.x, y: furnacePos.y, z: furnacePos.z })

  if (!await placeAt('chest', outputPos, 'outputChest')) return
  stateSet('outputChest', { x: outputPos.x, y: outputPos.y, z: outputPos.z })

  report({
    kind: 'done',
    home:        stateGet('home'),
    furnacePos:  stateGet('furnacePos'),
    tablePos:    stateGet('tablePos'),
    outputChest: stateGet('outputChest'),
  })
  stop('done')
})

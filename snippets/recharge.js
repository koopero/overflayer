// One-shot: build the bot's home station from scratch. Always rebuilds.
// Layout (along +X or +Z, picked from terrain):
//   [home / inputChest] [furnace] [crafting_table] [outputChest]
// On completion: home, furnacePos, tablePos, outputChest are set in state.

declareState('home',        { type: 'vec3', export: true })
declareState('furnacePos',  { type: 'vec3', export: true })
declareState('tablePos',    { type: 'vec3', export: true })
declareState('outputChest', { type: 'vec3', export: true })

run(async () => {
  if (!bot.kit) await snippetLoad('lib_craft')
  const k = bot.kit

  const STONE_NAMES = ['stone','granite','diorite','andesite']
  const logIds   = new Set(k.LOG_NAMES.map(k.bid).filter(Boolean))
  const stoneIds = new Set(STONE_NAMES.map(k.bid).filter(Boolean))

  const totalLogs = () => k.invCountAny(k.LOG_NAMES)

  // Surface if underground
  if (bot.entity.position.y < 62 && bot.pathfinder && GoalY) {
    if (bot.pathfinder.movements) bot.pathfinder.movements.canDig = true
    report({ kind: 'surfacing', y: Math.floor(bot.entity.position.y) })
    try { await k.withTimeout(bot.pathfinder.goto(new GoalY(70)), 60000) }
    catch (e) { if (e instanceof ScopeDisposedError) return }
  }
  if (signal.aborted) return

  // 1. Gather 9 logs
  while (!signal.aborted && totalLogs() < 9) {
    const b = bot.findBlock({ matching: b => logIds.has(b.type), maxDistance: 64 })
    if (!b) { report({ kind: 'searching', for: 'logs' }); await sleep(3000); continue }
    await k.goto(b.position.x, b.position.y, b.position.z, { radius: 3 })
    if (signal.aborted) return
    try { await bot.dig(b); await sleep(400) }
    catch (e) { if (e instanceof ScopeDisposedError) return; await sleep(500) }
  }
  if (signal.aborted) return

  // 2. Planks, sticks, crafting table (all 2x2 — no table needed yet)
  await k.ensurePlanks(4)
  await k.ensureSticks(2)
  if (!k.invCount('crafting_table')) {
    await k.craft('crafting_table', 1, { needsTable: false })
  }
  if (!k.invCount('crafting_table')) { report({ kind: 'fatal', reason: 'failed to craft table' }); return }

  // 3. Pick anchor: pre-set `home` wins, otherwise scan for a flat 4-wide strip.
  let anchor = null
  let axis = 'x'
  const preset = stateGet('home')
  if (preset) {
    anchor = new Vec3(preset.x, preset.y, preset.z)
    report({ kind: 'using-preset-home', at: preset })
  } else {
    const me = bot.entity.position.floored()
    outer:
    for (let r = 2; r <= 12; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          for (const ax of ['x', 'z']) {
            let ok = true
            for (let i = 0; i < 4; i++) {
              const off = ax === 'x' ? new Vec3(dx + i, 0, dz) : new Vec3(dx, 0, dz + i)
              const ground = bot.blockAt(me.plus(off).offset(0, -1, 0))
              const space  = bot.blockAt(me.plus(off))
              if (!ground || ground.boundingBox !== 'block' || !space || space.name !== 'air') { ok = false; break }
            }
            if (ok) { anchor = me.plus(new Vec3(dx, 0, dz)); axis = ax; break outer }
          }
        }
      }
    }
    if (!anchor) { report({ kind: 'fatal', reason: 'no flat 4-wide surface found' }); return }
  }

  const offset = (i) => axis === 'x' ? anchor.offset(i, 0, 0) : anchor.offset(0, 0, i)
  const homePos    = offset(0)
  const furnacePos = offset(1)
  const tablePos   = offset(2)
  const outputPos  = offset(3)

  async function placeAt (itemName, pos, role) {
    await k.goto(pos.x, pos.y, pos.z, { radius: 2 })
    if (signal.aborted) return false
    // Idempotent: if the desired block is already there, treat as success.
    const existing = bot.blockAt(pos)
    if (existing && existing.name === itemName) {
      report({ kind: 'already-placed', role, at: { x: pos.x, y: pos.y, z: pos.z } })
      return true
    }
    const item = k.invItems().find(i => i.name === itemName)
    if (!item) { report({ kind: 'fatal', reason: `missing item for ${role}: ${itemName}` }); return false }
    const ground = bot.blockAt(pos.offset(0, -1, 0))
    if (!ground) { report({ kind: 'fatal', reason: `no ground for ${role}` }); return false }
    try {
      await bot.equip(item, 'hand')
      await bot.placeBlock(ground, new Vec3(0, 1, 0))
      report({ kind: 'placed', role, at: { x: pos.x, y: pos.y, z: pos.z } })
      await sleep(300)
      return true
    } catch (e) {
      if (e instanceof ScopeDisposedError) return false
      report({ kind: 'place-error', role, message: e.message })
      return false
    }
  }

  // 4. Place the crafting TABLE first — we need it before we can craft chests.
  if (!await placeAt('crafting_table', tablePos, 'table')) return
  stateSet('tablePos', { x: tablePos.x, y: tablePos.y, z: tablePos.z })

  // 5. Craft a wooden pickaxe (needed for cobble later) and one chest (for home).
  await k.ensurePlanks(8)
  await k.ensureSticks(2)
  if (!k.invItems().some(i => i.name.endsWith('_pickaxe'))) {
    report({ kind: 'crafting', item: 'wooden_pickaxe' })
    await k.craft('wooden_pickaxe', 1)
  }
  await k.equipBestPickaxe()
  if (!k.invCount('chest')) {
    report({ kind: 'crafting', item: 'chest' })
    await k.craft('chest', 1)
  }
  if (!k.invCount('chest')) { report({ kind: 'fatal', reason: 'failed to craft home chest' }); return }
  if (signal.aborted) return

  // 6. Place HOME (inputChest) — the anchor.
  if (!await placeAt('chest', homePos, 'home')) return
  stateSet('home', { x: homePos.x, y: homePos.y, z: homePos.z })

  // 7. Mine 8 cobblestone (for the furnace).
  // Re-equip pickaxe — placing the home chest swapped it out of hand.
  await k.equipBestPickaxe()
  if (bot.pathfinder?.movements) {
    bot.pathfinder.movements.canDig = true
    bot.pathfinder.movements.maxDropDown = 4
  }
  while (!signal.aborted && k.invCount('cobblestone') < 8) {
    const b = bot.findBlock({ matching: b => stoneIds.has(b.type), maxDistance: 48 })
    if (!b) { report({ kind: 'searching', for: 'stone' }); await sleep(3000); continue }
    await k.goto(b.position.x, b.position.y, b.position.z, { radius: 3 })
    if (signal.aborted) return
    const block = bot.blockAt(b.position)
    if (!block || block.name === 'air') continue
    await k.equipBestPickaxe()
    try { await bot.dig(block); await sleep(400) }
    catch (e) { if (e instanceof ScopeDisposedError) return; await sleep(500) }
  }
  if (signal.aborted) return

  // 8. Back at table: craft furnace + outputChest.
  await k.ensurePlanks(8)
  if (!k.invCount('furnace')) await k.craft('furnace', 1)
  if (!k.invCount('chest'))   await k.craft('chest', 1)
  if (signal.aborted) return

  // 9. Place furnace and outputChest.
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

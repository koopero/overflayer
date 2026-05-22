// Recharge: build the home station from scratch.
// Layout (along +X or +Z from anchor): [chest/home] [furnace] [crafting_table] [chest/output]
// Pre-set `home` state to force a specific anchor; otherwise scans for flat ground.
// On success: sets home, furnacePos, tablePos, outputChest in state and calls stop('done').

declareState('home',        { type: 'vec3', export: true })
declareState('furnacePos',  { type: 'vec3', export: true })
declareState('tablePos',    { type: 'vec3', export: true })
declareState('outputChest', { type: 'vec3', export: true })

run(async () => {
  if (!bot.kit) await snippetLoad('lib_craft')
  const k = bot.kit

  const STONE_NAMES = ['stone', 'granite', 'diorite', 'andesite']
  const logIds   = new Set(k.LOG_NAMES.map(k.bid).filter(Boolean))
  const stoneIds = new Set(STONE_NAMES.map(k.bid).filter(Boolean))

  if (bot.pathfinder?.movements) {
    bot.pathfinder.movements.canDig      = true
    bot.pathfinder.movements.digCost     = 128
    bot.pathfinder.movements.maxDropDown = 4
    bot.pathfinder.movements.allowSprinting = true
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  async function surface () {
    if (bot.entity.position.y >= 62) return
    report({ kind: 'surfacing', y: Math.floor(bot.entity.position.y) })
    try { await k.withTimeout(bot.pathfinder.goto(new GoalY(70)), 60000) } catch (_) {}
  }


  // Place a block at `dest` by clicking the top face of `ref` (one block below dest).
  // Uses Promise.race so a server-lag timeout doesn't abort — checks actual block state after.
  async function placeBlock (itemName, dest) {
    const ref  = dest.offset(0, -1, 0)
    const refB = bot.blockAt(ref)
    if (!refB || refB.boundingBox !== 'block') return false
    const destB = bot.blockAt(dest)
    if (destB && !['air', 'short_grass', 'tall_grass', 'grass'].includes(destB.name)) return false
    // Clear vegetation
    if (destB && destB.name !== 'air') {
      try { await bot.dig(destB) } catch (_) {}
      await new Promise(r => setTimeout(r, 300))
    }
    const item = k.invItems().find(i => i.name === itemName)
    if (!item) return false
    try {
      await bot.equip(item, 'hand')
      await bot.lookAt(ref.position.offset(0.5, 1.01, 0.5), true)
      await new Promise(r => setTimeout(r, 300))
      await Promise.race([
        bot.placeBlock(refB, new Vec3(0, 1, 0)).then(() => 'ok'),
        new Promise(r => setTimeout(r, 8000, 'timeout')),
      ])
    } catch (e) {
      if (e instanceof ScopeDisposedError) throw e
    }
    // Check regardless of whether placeBlock threw or timed out
    await new Promise(r => setTimeout(r, 700))
    return bot.blockAt(dest)?.name === itemName
  }

  // Navigate to pos then try all four cardinal faces for placement.
  async function placeAt (itemName, pos, role) {
    await k.goto(pos.x, pos.y, pos.z, { radius: 3, timeout: 60000 })
    if (signal.aborted) return false

    // Check idempotently first
    if (bot.blockAt(pos)?.name === itemName) {
      report({ kind: 'already-placed', role })
      return true
    }

    // Try exact position first, then the four adjacent spots
    const targets = [
      pos,
      pos.offset(1,0,0), pos.offset(-1,0,0),
      pos.offset(0,0,1), pos.offset(0,0,-1),
    ]
    for (const dest of targets) {
      if (signal.aborted) return false
      if (await placeBlock(itemName, dest)) {
        report({ kind: 'placed', role, at: { x: dest.x, y: dest.y, z: dest.z } })
        return dest
      }
    }
    report({ kind: 'place-failed', role, item: itemName })
    return false
  }

  // ── STEP 1: Surface ────────────────────────────────────────────────────────
  await surface()
  if (signal.aborted) return

  // ── STEP 2: Gather 9 logs ──────────────────────────────────────────────────
  let logStreak = 0
  while (!signal.aborted && k.invCountAny(k.LOG_NAMES) < 9) {
    const b = bot.findBlock({ matching: b => logIds.has(b.type), maxDistance: 64 })
    if (!b) {
      logStreak++
      report({ kind: 'searching', for: 'logs', streak: logStreak })
      if (logStreak >= 3) {
        const me = bot.entity.position
        const wx = me.x + (Math.random() - 0.5) * 120
        const wz = me.z + (Math.random() - 0.5) * 120
        report({ kind: 'wandering', to: { x: Math.round(wx), z: Math.round(wz) } })
        await k.goto(wx, me.y, wz, { radius: 8, timeout: 30000 })
        logStreak = 0
      } else {
        await new Promise(r => setTimeout(r, 3000))
      }
      continue
    }
    logStreak = 0
    report({ kind: 'chopping', at: b.position, have: k.invCountAny(k.LOG_NAMES) })
    await k.goto(b.position.x, b.position.y, b.position.z, { radius: 3, timeout: 20000 })
    if (signal.aborted) return
    try { await bot.dig(b); await new Promise(r => setTimeout(r, 400)) }
    catch (e) { if (e instanceof ScopeDisposedError) return; await new Promise(r => setTimeout(r, 500)) }
  }
  if (signal.aborted) return

  // ── STEP 3: Craft planks, sticks, crafting table ───────────────────────────
  await k.ensurePlanks(4)
  await k.ensureSticks(2)
  if (!k.invCount('crafting_table')) {
    await k.craft('crafting_table', 1, { needsTable: false })
  }
  if (!k.invCount('crafting_table')) { report({ kind: 'fatal', reason: 'table craft failed' }); return }

  // ── STEP 4: Pick anchor ────────────────────────────────────────────────────
  let anchor = null
  let axis   = 'x'
  const preset = stateGet('home')
  if (preset) {
    anchor = new Vec3(preset.x, preset.y, preset.z)
    report({ kind: 'using-preset-home', at: preset })
  } else {
    const me = bot.entity.position.floored()
    outer:
    for (let r = 2; r <= 14; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          for (const ax of ['x', 'z']) {
            let ok = true
            for (let i = 0; i < 4; i++) {
              const off    = ax === 'x' ? new Vec3(dx+i, 0, dz) : new Vec3(dx, 0, dz+i)
              const ground = bot.blockAt(me.plus(off).offset(0,-1,0))
              const space  = bot.blockAt(me.plus(off))
              if (!ground || ground.boundingBox !== 'block') { ok = false; break }
              if (!space  || space.name  !== 'air')          { ok = false; break }
            }
            if (ok) { anchor = me.plus(new Vec3(dx, 0, dz)); axis = ax; break outer }
          }
        }
      }
    }
    if (!anchor) { report({ kind: 'fatal', reason: 'no flat 4-wide surface found' }); return }
  }

  const offset = i => axis === 'x' ? anchor.offset(i, 0, 0) : anchor.offset(0, 0, i)
  const homePos    = offset(0)
  const furnacePos = offset(1)
  const tablePos   = offset(2)
  const outputPos  = offset(3)

  // ── STEP 5: Place crafting table first ────────────────────────────────────
  const tablePlaced = await placeAt('crafting_table', tablePos, 'table')
  if (!tablePlaced) return
  const actualTablePos = (tablePlaced === true) ? tablePos : tablePlaced
  stateSet('tablePos', { x: actualTablePos.x, y: actualTablePos.y, z: actualTablePos.z })

  // ── STEP 6: Craft wooden pickaxe and first chest ───────────────────────────
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
  if (!k.invCount('chest')) { report({ kind: 'fatal', reason: 'chest craft failed' }); return }
  if (signal.aborted) return

  // ── STEP 7: Place home chest ───────────────────────────────────────────────
  const homePlaced = await placeAt('chest', homePos, 'home')
  if (!homePlaced) return
  const actualHome = (homePlaced === true) ? homePos : homePlaced
  stateSet('home', { x: actualHome.x, y: actualHome.y, z: actualHome.z })

  // ── STEP 8: Mine cobble from surface-exposed stone ─────────────────────────
  await k.equipBestPickaxe()
  let stoneStreak = 0
  while (!signal.aborted && k.invCount('cobblestone') < 8) {
    const stonePos = k.findSurfaceStone(48)
    if (!stonePos) {
      stoneStreak++
      report({ kind: 'searching', for: 'surface-stone', streak: stoneStreak })
      if (stoneStreak >= 3) {
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
    await k.equipBestPickaxe()
    try { await bot.dig(block, true); await new Promise(r => setTimeout(r, 300)) }
    catch (e) { if (e instanceof ScopeDisposedError) return; await new Promise(r => setTimeout(r, 500)) }
  }
  if (signal.aborted) return

  // ── STEP 9: Return to table; craft furnace + second chest ──────────────────
  // canDig=false to protect cobblestone while navigating back
  if (bot.pathfinder?.movements) bot.pathfinder.movements.canDig = false
  await k.goto(actualTablePos.x, actualTablePos.y, actualTablePos.z, { radius: 2, timeout: 90000 })
  if (bot.pathfinder?.movements) bot.pathfinder.movements.canDig = true
  if (signal.aborted) return

  await k.ensurePlanks(8)
  if (!k.invCount('furnace')) await k.craft('furnace', 1)
  if (!k.invCount('chest'))   await k.craft('chest',   1)
  if (signal.aborted) return

  // ── STEP 10: Place furnace and output chest ────────────────────────────────
  const fPlaced = await placeAt('furnace', furnacePos, 'furnace')
  if (!fPlaced) return
  const actualFurnace = (fPlaced === true) ? furnacePos : fPlaced
  stateSet('furnacePos', { x: actualFurnace.x, y: actualFurnace.y, z: actualFurnace.z })

  const oPlaced = await placeAt('chest', outputPos, 'outputChest')
  if (oPlaced) {
    const actualOutput = (oPlaced === true) ? outputPos : oPlaced
    stateSet('outputChest', { x: actualOutput.x, y: actualOutput.y, z: actualOutput.z })
  }

  report({
    kind:        'done',
    home:        stateGet('home'),
    furnacePos:  stateGet('furnacePos'),
    tablePos:    stateGet('tablePos'),
    outputChest: stateGet('outputChest'),
  })
  stop('done')
})

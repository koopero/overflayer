// Descend from pillar to natural ground, then place table + craft tools.
run(async () => {
  if (!bot.kit) await snippetLoad('lib_craft')
  const k = bot.kit

  // Step 1: find ground — scan downward for a real block surface near us
  function findGround () {
    const me = bot.entity.position.floored()
    for (let r = 1; r <= 12; r++) {
      for (let dy = 0; dy >= -20; dy--) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
            const pos = me.offset(dx, dy, dz)
            const ground = bot.blockAt(pos.offset(0, -1, 0))
            const space  = bot.blockAt(pos)
            const above  = bot.blockAt(pos.offset(0, 1, 0))
            if (!ground || ground.boundingBox !== 'block') continue
            if (ground.name === 'oak_planks' || ground.name === 'crafting_table') continue
            if (!space || space.name !== 'air') continue
            if (!above || above.name !== 'air') continue
            return pos
          }
        }
      }
    }
    return null
  }

  if (bot.pathfinder?.movements) {
    bot.pathfinder.movements.canDig = true
    bot.pathfinder.movements.maxDropDown = 8
    bot.pathfinder.movements.allow1by1towers = true
  }

  const ground = findGround()
  if (!ground) { report({ kind: 'no-ground' }); return }
  report({ kind: 'descending', to: { x: ground.x, y: ground.y, z: ground.z } })
  await k.goto(ground.x, ground.y, ground.z, { radius: 1, timeout: 60000 })
  if (signal.aborted) return

  // Step 2: ensure crafting table item
  if (!k.invCount('crafting_table')) {
    await k.ensurePlanks(4)
    await k.craft('crafting_table', 1, { needsTable: false })
  }
  if (!k.invCount('crafting_table')) { report({ kind: 'no-table-item' }); return }

  // Step 3: place table adjacent
  const feet = bot.entity.position.floored()
  const tableItem = k.invItems().find(i => i.name === 'crafting_table')
  let tablePos = null
  for (const d of [new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(0,0,-1)]) {
    const refPos = feet.plus(d).offset(0,-1,0)
    const ref = bot.blockAt(refPos)
    if (!ref || ref.boundingBox !== 'block') continue
    const dest = bot.blockAt(feet.plus(d))
    if (dest && dest.name !== 'air') continue
    try {
      await bot.equip(tableItem, 'hand')
      await bot.lookAt(refPos.offset(0.5, 1, 0.5), true)
      await sleep(200)
      await bot.placeBlock(ref, new Vec3(0,1,0))
      await sleep(400)
      const placed = bot.blockAt(feet.plus(d))
      if (placed?.name === 'crafting_table') { tablePos = feet.plus(d); break }
    } catch (e) {
      if (e instanceof ScopeDisposedError) return
    }
  }
  if (!tablePos) { report({ kind: 'place-failed' }); return }
  stateSet('tablePos', { x: tablePos.x, y: tablePos.y, z: tablePos.z })
  report({ kind: 'table-placed', at: { x: tablePos.x, y: tablePos.y, z: tablePos.z } })

  // Step 4: craft wooden tools
  await k.ensureSticks(4)
  for (const tool of ['wooden_pickaxe','wooden_sword','wooden_axe']) {
    if (!k.invCount(tool)) {
      const ok = await k.craft(tool, 1)
      report({ kind: ok ? 'crafted' : 'craft-failed', item: tool })
    }
  }
  await k.equipBestSword()
  report({ kind: 'armed', inv: k.invItems().map(i => `${i.name}x${i.count}`) })
  stop('done')
})

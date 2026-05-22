// Pathfind to lower natural ground, then place table and craft tools.
run(async () => {
  if (!bot.kit) await snippetLoad('lib_craft')
  const k = bot.kit

  if (bot.pathfinder?.movements) {
    bot.pathfinder.movements.canDig = true
    bot.pathfinder.movements.maxDropDown = 16
    bot.pathfinder.movements.allow1by1towers = true
    bot.pathfinder.movements.allowSprinting = true
  }

  // Sample current location and scan for the LOWEST nearby natural-ground spot
  function scanGround () {
    const me = bot.entity.position.floored()
    const candidates = []
    for (let r = 0; r <= 16; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
          // Probe downward through the column to find first natural ground
          for (let y = me.y; y >= me.y - 20; y--) {
            const pos = new Vec3(me.x + dx, y, me.z + dz)
            const ground = bot.blockAt(pos.offset(0, -1, 0))
            const space  = bot.blockAt(pos)
            const above  = bot.blockAt(pos.offset(0, 1, 0))
            if (!ground || ground.boundingBox !== 'block') continue
            if (ground.name === 'oak_planks' || ground.name === 'crafting_table') continue
            if (!space || space.name !== 'air') continue
            if (!above || above.name !== 'air') continue
            candidates.push(pos)
            break
          }
        }
      }
      if (candidates.length >= 5) break
    }
    candidates.sort((a, b) => a.y - b.y)   // prefer lower
    return candidates[0]
  }

  const target = scanGround()
  if (!target) { report({ kind: 'no-ground' }); return }
  report({ kind: 'going-to-ground', target: { x: target.x, y: target.y, z: target.z } })
  await k.goto(target.x, target.y, target.z, { radius: 1, timeout: 90000 })
  if (signal.aborted) return

  // Verify we landed close
  const feet = bot.entity.position.floored()
  report({ kind: 'arrived', feet: { x: feet.x, y: feet.y, z: feet.z } })

  // Place crafting table
  if (!k.invCount('crafting_table')) {
    await k.ensurePlanks(4)
    await k.craft('crafting_table', 1, { needsTable: false })
  }
  if (!k.invCount('crafting_table')) { report({ kind: 'no-table-item' }); return }

  const tableItem = k.invItems().find(i => i.name === 'crafting_table')
  let tablePos = null
  for (let attempt = 0; attempt < 3 && !tablePos; attempt++) {
    for (const d of [new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(0,0,-1)]) {
      const refPos = feet.plus(d).offset(0,-1,0)
      const ref = bot.blockAt(refPos)
      if (!ref || ref.boundingBox !== 'block') continue
      const dest = bot.blockAt(feet.plus(d))
      if (dest && dest.name !== 'air') continue
      try {
        await bot.equip(tableItem, 'hand')
        await bot.lookAt(refPos.offset(0.5, 1, 0.5), true)
        await sleep(250)
        await bot.placeBlock(ref, new Vec3(0,1,0))
        await sleep(500)
        const placed = bot.blockAt(feet.plus(d))
        if (placed?.name === 'crafting_table') { tablePos = feet.plus(d); break }
      } catch (e) {
        if (e instanceof ScopeDisposedError) return
      }
    }
    if (!tablePos) await sleep(500)
  }
  if (!tablePos) { report({ kind: 'place-failed' }); return }
  stateSet('tablePos', { x: tablePos.x, y: tablePos.y, z: tablePos.z })
  report({ kind: 'table-placed', at: { x: tablePos.x, y: tablePos.y, z: tablePos.z } })

  // Craft wooden tools
  await k.ensureSticks(6)
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

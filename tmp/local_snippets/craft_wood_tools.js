// One-shot: place crafting table + craft wooden tools.
// Stays in current location. Tries every adjacent ground for placement.
run(async () => {
  if (!bot.kit) await snippetLoad('lib_craft')
  const k = bot.kit

  // Make sure we have a table item
  if (!k.invCount('crafting_table')) {
    await k.ensurePlanks(4)
    await k.craft('crafting_table', 1, { needsTable: false })
  }
  if (!k.invCount('crafting_table')) { report({ kind: 'fatal', reason: 'no table item' }); return }

  // Place table adjacent: ref = ground block next to us, face = up
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

  if (!tablePos) { report({ kind: 'place-failed', reason: 'no valid adjacent ground' }); return }
  stateSet('tablePos', { x: tablePos.x, y: tablePos.y, z: tablePos.z })
  report({ kind: 'table-placed', at: { x: tablePos.x, y: tablePos.y, z: tablePos.z } })

  // Craft wooden tools
  await k.ensureSticks(4)
  if (!k.invItems().some(i => i.name === 'wooden_pickaxe')) {
    const ok = await k.craft('wooden_pickaxe', 1)
    report({ kind: ok ? 'crafted' : 'craft-failed', item: 'wooden_pickaxe' })
  }
  if (!k.invItems().some(i => i.name === 'wooden_sword')) {
    const ok = await k.craft('wooden_sword', 1)
    report({ kind: ok ? 'crafted' : 'craft-failed', item: 'wooden_sword' })
  }
  if (!k.invItems().some(i => i.name === 'wooden_axe')) {
    const ok = await k.craft('wooden_axe', 1)
    report({ kind: ok ? 'crafted' : 'craft-failed', item: 'wooden_axe' })
  }

  await k.equipBestSword()
  report({ kind: 'armed', inv: k.invItems().map(i => `${i.name}x${i.count}`) })
  stop('done')
})

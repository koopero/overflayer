// Background: if bot is stuck underground (y < targetY), pillar up using scaffoldBlock.
// Other snippets set scaffoldBlock (e.g. 'oak_planks', 'dirt') and targetY.
// Runs in parallel with any task — fires when triggered by low Y.

declareState('scaffoldBlock', { type: 'string', export: true, default: 'oak_planks' })
declareState('scaffoldTargetY', { type: 'number', export: true, default: 70 })

run(async () => {
  report({ kind: 'scaffold-ready' })

  while (!signal.aborted) {
    const targetY = stateGet('scaffoldTargetY') ?? 70
    const blockName = stateGet('scaffoldBlock') ?? 'oak_planks'

    if (bot.entity.position.y >= targetY - 1) {
      await sleep(2000)
      continue
    }

    // Find scaffold block in inventory
    const item = bot.inventory.items().find(i => i.name === blockName)
      ?? bot.inventory.items().find(i => i.name === 'dirt')
      ?? bot.inventory.items().find(i => i.name.endsWith('_planks'))
    if (!item) {
      await sleep(3000)
      continue
    }

    // Pause pathfinder while pillaring
    try { bot.pathfinder?.setGoal(null) } catch (_) {}

    report({ kind: 'pillaring', from: Math.round(bot.entity.position.y), to: targetY, using: item.name })

    // Pillar up: jump + place below feet
    let placed = 0
    while (!signal.aborted && bot.entity.position.y < targetY - 1) {
      const scaffItem = bot.inventory.items().find(i => i.name === item.name)
        ?? bot.inventory.items().find(i => i.name === 'dirt')
        ?? bot.inventory.items().find(i => i.name.endsWith('_planks'))
      if (!scaffItem) break

      const ref = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
      if (!ref || ref.boundingBox !== 'block') { await sleep(300); continue }

      try { await bot.equip(scaffItem, 'hand') } catch (_) {}
      try {
        bot.setControlState('jump', true)
        await sleep(200)
        await bot.placeBlock(ref, new Vec3(0, 1, 0))
        bot.setControlState('jump', false)
        placed++
        await sleep(200)
      } catch (e) {
        bot.setControlState('jump', false)
        if (e instanceof ScopeDisposedError) return
        await sleep(300)
      }
    }

    report({ kind: 'pillared', placed, y: Math.round(bot.entity.position.y) })
    await sleep(1000)
  }
})

// EMERGENCY: pillar up with planks to escape ground threats.
run(async () => {
  if (!bot.kit) await snippetLoad('lib_craft')
  const k = bot.kit

  // Stop any pathfinder activity
  try { bot.pathfinder?.setGoal(null) } catch (_) {}

  const PLANK_NAMES = k.PLANK_NAMES

  // Find a placeable block
  function findBlock () {
    const items = k.invItems()
    return items.find(i => PLANK_NAMES.includes(i.name))
        ?? items.find(i => i.name === 'dirt' || i.name === 'cobblestone' || i.name === 'stone')
        ?? items.find(i => i.name.endsWith('_log'))
  }

  const targetHeight = 8
  let placed = 0

  while (!signal.aborted && placed < targetHeight) {
    const block = findBlock()
    if (!block) { report({ kind: 'out-of-blocks', placed }); break }

    try { await bot.equip(block, 'hand') } catch (_) {}

    // Look straight down
    try { await bot.look(bot.entity.yaw, Math.PI / 2, true) } catch (_) {}
    await sleep(150)

    // Jump and place below
    const refPos = bot.entity.position.floored().offset(0, -1, 0)
    const ref = bot.blockAt(refPos)
    if (!ref || ref.name === 'air') {
      // Need something to place on; place from feet sideways
      const feet = bot.entity.position.floored()
      for (const d of [new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(0,0,-1)]) {
        const side = bot.blockAt(feet.plus(d))
        if (side && side.boundingBox === 'block') {
          try { await bot.placeBlock(side, d.scaled(-1).offset(0,0,0)) } catch (_) {}
          break
        }
      }
      await sleep(300)
      continue
    }

    try {
      bot.setControlState('jump', true)
      await sleep(250)
      await bot.placeBlock(ref, new Vec3(0, 1, 0))
      bot.setControlState('jump', false)
      placed++
      report({ kind: 'pillared', height: placed, hp: bot.health })
      await sleep(250)
    } catch (e) {
      bot.setControlState('jump', false)
      if (e instanceof ScopeDisposedError) return
      await sleep(300)
    }
  }

  report({ kind: 'safe', placed, hp: bot.health, pos: bot.entity.position })
  // Stay on top
  while (!signal.aborted) {
    await sleep(2000)
    if (bot.health < 15) report({ kind: 'still-taking-damage', hp: bot.health })
  }
})

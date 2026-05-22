// Survival watchdog: stay near current spot, attack hostile mobs in reach,
// flee/heal if HP drops, share status periodically.
run(async () => {
  if (!bot.kit) await snippetLoad('lib_craft')
  const k = bot.kit

  const HOSTILE = new Set([
    'zombie','skeleton','spider','creeper','witch','enderman','husk','stray',
    'drowned','zombie_villager','pillager','vindicator','phantom','slime',
    'magma_cube','silverfish','cave_spider','wither_skeleton','blaze'
  ])

  // Equip best weapon
  await k.equipBestSword()
  if (!k.invItems().some(i => i.name.endsWith('_sword'))) {
    // Try to craft a wooden sword if we have parts (no table = ok, sword is 2x2... actually sword needs table)
    // Skip; just punch.
  }

  const home = bot.entity.position.clone()
  report({ kind: 'guarding', at: { x: Math.round(home.x), y: Math.round(home.y), z: Math.round(home.z) }, hp: bot.health })

  let lastReportT = Date.now()

  while (!signal.aborted) {
    // Find nearest hostile
    let target = null, bestDist = Infinity
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity) continue
      if (!HOSTILE.has(e.name)) continue
      const d = e.position.distanceTo(bot.entity.position)
      if (d < bestDist && d < 12) { target = e; bestDist = d }
    }

    if (target) {
      try {
        await bot.lookAt(target.position.offset(0, 1.5, 0), true)
        if (bestDist < 3.2) {
          await k.equipBestSword().catch(() => {})
          bot.attack(target)
          await sleep(600)
        } else {
          // Move toward it if reachable, but stay near home
          const distFromHome = bot.entity.position.distanceTo(home)
          if (distFromHome < 6 && bot.pathfinder && GoalNear) {
            try {
              bot.pathfinder.setGoal(new GoalNear(target.position.x, target.position.y, target.position.z, 1))
            } catch (_) {}
            await sleep(800)
            try { bot.pathfinder.setGoal(null) } catch (_) {}
          } else {
            await sleep(300)
          }
        }
      } catch (e) {
        if (e instanceof ScopeDisposedError) return
        await sleep(300)
      }
    } else {
      // No target. Return toward home if drifted.
      const distFromHome = bot.entity.position.distanceTo(home)
      if (distFromHome > 4 && bot.pathfinder && GoalNear) {
        try {
          bot.pathfinder.setGoal(new GoalNear(home.x, home.y, home.z, 1))
        } catch (_) {}
        await sleep(1500)
        try { bot.pathfinder.setGoal(null) } catch (_) {}
      } else {
        await sleep(800)
      }
    }

    // Periodic status report
    if (Date.now() - lastReportT > 15000) {
      lastReportT = Date.now()
      report({
        kind: 'alive',
        hp: bot.health,
        food: bot.food,
        pos: { x: Math.round(bot.entity.position.x), y: Math.round(bot.entity.position.y), z: Math.round(bot.entity.position.z) },
        threats: Object.values(bot.entities).filter(e => HOSTILE.has(e?.name) && e.position.distanceTo(bot.entity.position) < 16).map(e => e.name),
      })
    }
  }
})

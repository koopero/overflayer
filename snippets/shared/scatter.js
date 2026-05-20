const DISTANCE = 20
const MAX_ATTEMPTS = 6

run(async () => {
  if (!bot.pathfinder || !GoalNear) {
    report({ kind: 'fatal', reason: 'mineflayer-pathfinder is not loaded' })
    return stop('no-pathfinder')
  }
  if (!bot.entity) {
    report({ kind: 'fatal', reason: 'bot has no entity (not spawned yet)' })
    return stop('not-spawned')
  }

  const origin = bot.entity.position.clone()

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) return
    const angle = Math.random() * Math.PI * 2
    const dx = Math.cos(angle) * DISTANCE
    const dz = Math.sin(angle) * DISTANCE
    const target = origin.offset(dx, 0, dz)
    report({ kind: 'attempt', attempt, target: { x: target.x, y: target.y, z: target.z } })

    try {
      await bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, 2))
      const here = bot.entity.position
      const traveled = Math.hypot(here.x - origin.x, here.z - origin.z)
      report({ kind: 'arrived', attempt, traveled, at: { x: here.x, y: here.y, z: here.z } })
      return stop('arrived')
    } catch (err) {
      if (err instanceof ScopeDisposedError) return
      report({ kind: 'unreachable', attempt, message: String(err.message || err) })
    }
  }

  report({ kind: 'gave-up', attempts: MAX_ATTEMPTS })
  stop('gave-up')
})

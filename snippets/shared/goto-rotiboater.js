declareState('target', { type: 'player', export: true, default: 'rotiboater' })
declareState('radius', { type: 'number', export: true, default: 2 })

run(async () => {
  if (!bot.pathfinder || !GoalNear) {
    report({ kind: 'fatal', reason: 'mineflayer-pathfinder is not loaded on this bot' })
    return stop('no-pathfinder')
  }

  while (!signal.aborted) {
    const targetName = stateGet('target')
    const radius = stateGet('radius') || 2

    if (!targetName) {
      report({ kind: 'idle', reason: 'no target set' })
      await sleep(2000)
      continue
    }

    const target = bot.players[targetName]
    if (!target?.entity) {
      report({ kind: 'waiting', target: targetName, reason: 'not visible' })
      await sleep(2000)
      continue
    }

    const { x, y, z } = target.entity.position
    const me = bot.entity.position
    const dist = Math.hypot(me.x - x, me.y - y, me.z - z)

    if (dist <= radius) {
      report({ kind: 'arrived', target: targetName, distance: dist, at: { x: me.x, y: me.y, z: me.z } })
      await sleep(1000)
      continue
    }

    report({ kind: 'navigating', target: targetName, distance: dist, to: { x, y, z } })
    try {
      await bot.pathfinder.goto(new GoalNear(x, y, z, radius))
    } catch (err) {
      if (err instanceof ScopeDisposedError) return
      report({ kind: 'pathfinder-error', message: String(err.message || err) })
      await sleep(1000)
    }
  }
})

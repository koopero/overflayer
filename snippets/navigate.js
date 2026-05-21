// Navigation bus. Other behaviors write navTarget; this snippet owns pathfinder.
declareState('navTarget', { type: 'vec3',   export: true })
declareState('navRadius', { type: 'number', export: true,  default: 2 })
declareState('navStatus', { type: 'string', export: false, default: 'idle' })

run(async () => {
  if (!bot.pathfinder || !GoalNear) {
    report({ kind: 'fatal', reason: 'pathfinder not available' })
    return stop('no-pathfinder')
  }

  bot.on('goal_reached', () => {
    stateSet('navStatus', 'arrived')
    report({ kind: 'arrived' })
  })

  bot.on('path_update', (r) => {
    if (r.status === 'noPath') {
      stateSet('navStatus', 'failed')
      report({ kind: 'no-path' })
    }
  })

  let active = null   // last target we issued a setGoal for

  while (!signal.aborted) {
    const target = stateGet('navTarget')

    if (!target) {
      if (active) {
        try { bot.pathfinder.setGoal(null) } catch (_) {}
        active = null
        stateSet('navStatus', 'idle')
      }
      await sleep(100)
      continue
    }

    const moved = !active || Math.hypot(target.x - active.x, target.z - active.z) > 0.5

    if (moved) {
      bot.pathfinder.setGoal(new GoalNear(target.x, target.y, target.z, stateGet('navRadius') || 2))
      active = { ...target }
      stateSet('navStatus', 'navigating')
    }

    await sleep(200)
  }
})

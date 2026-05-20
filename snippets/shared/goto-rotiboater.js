const TARGET = 'rotiboater'
const ARRIVED_RADIUS = 2

run(async () => {
  if (!bot.pathfinder || !GoalNear) {
    report({ kind: 'fatal', reason: 'mineflayer-pathfinder is not loaded on this bot' })
    return
  }

  while (!signal.aborted) {
    const player = bot.players[TARGET]
    if (!player?.entity) {
      report({ kind: 'waiting', target: TARGET, reason: 'not visible' })
      await sleep(2000)
      continue
    }

    const { x, y, z } = player.entity.position
    const me = bot.entity.position
    const dist = Math.hypot(me.x - x, me.y - y, me.z - z)

    if (dist <= ARRIVED_RADIUS) {
      report({ kind: 'arrived', target: TARGET, distance: dist, at: { x: me.x, y: me.y, z: me.z } })
      stop('arrived')
      return
    }

    report({ kind: 'navigating', target: TARGET, distance: dist, to: { x, y, z } })
    try {
      await bot.pathfinder.goto(new GoalNear(x, y, z, ARRIVED_RADIUS))
    } catch (err) {
      if (err instanceof ScopeDisposedError) return
      report({ kind: 'pathfinder-error', message: String(err.message || err) })
      await sleep(1000)
    }
  }
})

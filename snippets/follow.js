// Task: follow a player. Continuously writes navTarget so navigate handles movement.
declareState('currentTask', { type: 'string', export: true })
declareState('target',      { type: 'player', export: true })
declareState('navTarget',   { type: 'vec3',   export: true })
declareState('navRadius',   { type: 'number', export: true, default: 3 })

run(async () => {
  while (!signal.aborted) {
    if (stateGet('currentTask') !== 'follow') {
      stateSet('navTarget', null)
      await sleep(500)
      continue
    }

    const name = stateGet('target')
    if (!name) {
      report({ kind: 'idle', reason: 'no target' })
      await sleep(1000)
      continue
    }

    const player = bot.players[name]
    if (!player?.entity) {
      report({ kind: 'waiting', target: name, reason: 'not visible' })
      await sleep(2000)
      continue
    }

    const { x, y, z } = player.entity.position
    stateSet('navTarget', { x, y, z })
    await sleep(500)
  }
})

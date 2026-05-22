// Task: scan blocks in front of `target` player and report, then idle.
// Re-triggers each time currentTask transitions to 'inspect'.
declareState('currentTask',    { type: 'string', export: true })
declareState('target',         { type: 'player', export: true })
declareState('inspectDistance',{ type: 'number', export: true, default: 5 })

run(async () => {
  let prev = stateGet('currentTask')

  while (!signal.aborted) {
    const task = stateGet('currentTask')

    if (task === 'inspect' && prev !== 'inspect') {
      const name = stateGet('target')
      if (!name) {
        report({ kind: 'error', reason: 'no target set' })
      } else {
        const player = bot.players[name]
        if (!player?.entity) {
          report({ kind: 'error', reason: `${name} not visible` })
        } else {
          const pos = player.entity.position
          const yaw = player.entity.yaw
          const dx = -Math.sin(yaw)
          const dz = -Math.cos(yaw)
          const dist = stateGet('inspectDistance') || 5

          const blocks = []
          for (let d = 1; d <= dist; d++) {
            for (let dy = -1; dy <= 2; dy++) {
              const x = Math.floor(pos.x + dx * d + 0.5)
              const y = Math.floor(pos.y + dy + 0.5)
              const z = Math.floor(pos.z + dz * d + 0.5)
              const b = bot.blockAt(new Vec3(x, y, z))
              if (b && b.name !== 'air') blocks.push({ dist: d, dy, pos: { x, y, z }, name: b.name })
            }
          }

          report({
            kind: 'inspect',
            target: name,
            facing: { yaw: yaw.toFixed(2), dx: dx.toFixed(2), dz: dz.toFixed(2) },
            blocks
          })
        }
      }
    }

    prev = task
    await sleep(100)
  }
})

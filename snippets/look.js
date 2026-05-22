// Always-on ambient behavior. Looks at `target` whenever visible; otherwise looks around idly.
declareState('target', { type: 'player', export: true })

run(async () => {
  let idleYaw   = Math.random() * Math.PI * 2
  let idlePitch = 0
  let nextIdle  = 0

  while (!signal.aborted) {
    const name   = stateGet('target')
    const player = name ? bot.players[name] : null

    if (player?.entity) {
      bot.lookAt(player.entity.position.offset(0, 1.6, 0), true).catch(() => {})
    } else {
      const now = Date.now()
      if (now >= nextIdle) {
        idleYaw   = Math.random() * Math.PI * 2
        idlePitch = (Math.random() - 0.5) * 0.6   // ±~17°
        nextIdle  = now + 2000 + Math.random() * 3000
      }
      bot.look(idleYaw, idlePitch, true)
    }

    await sleep(100)
  }
})

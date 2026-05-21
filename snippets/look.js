// Always-on ambient behavior. Looks at `target` whenever they're visible.
// Composes with follow: set target + currentTask=follow and the bot escorts.
declareState('target', { type: 'player', export: true })

run(async () => {
  while (!signal.aborted) {
    const name = stateGet('target')
    if (name) {
      const player = bot.players[name]
      if (player?.entity) {
        // offset to eye level; force=true skips interpolation animation
        bot.lookAt(player.entity.position.offset(0, 1.6, 0), true).catch(() => {})
      }
    }
    await sleep(100)
  }
})

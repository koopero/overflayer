bot.on('chat', (username, message) => {
  if (username === bot.username) return
  if (message !== 'come') return
  run(async () => {
    const player = bot.players[username]
    if (!player?.entity) return bot.chat(`I can't see you, ${username}.`)
    if (!bot.pathfinder || !GoalNear) return bot.chat('No pathfinder available.')
    const { x, y, z } = player.entity.position
    bot.chat(`On my way, ${username}.`)
    await bot.pathfinder.goto(new GoalNear(x, y, z, 6))
    bot.chat('Here!')
  })
})

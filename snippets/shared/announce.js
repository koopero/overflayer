interval(60_000, () => {
  const { x, y, z } = bot.entity.position
  bot.chat(`[${bot.username}] alive at ${x.toFixed(0)} ${y.toFixed(0)} ${z.toFixed(0)}`)
  report({
    kind: 'heartbeat',
    pos: { x, y, z },
    health: bot.health,
    food: bot.food
  })
})

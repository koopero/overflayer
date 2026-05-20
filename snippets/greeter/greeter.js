bot.on('chat', (username, message) => {
  if (username === bot.username) return
  if (message === 'hi' || message === 'hello') {
    bot.chat(`Hello, ${username}!`)
  }
})

bot.on('playerJoined', (player) => {
  if (player.username === bot.username) return
  bot.chat(`Welcome, ${player.username}.`)
})

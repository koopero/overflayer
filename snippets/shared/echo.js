bot.on('chat', (username, message) => {
  if (username === bot.username) return
  if (!message.startsWith('!echo ')) return
  bot.chat(message.slice(6))
})

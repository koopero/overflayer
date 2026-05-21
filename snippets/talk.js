// Task: say talkMessage in chat once, then report done.
// Re-triggers each time currentTask transitions to 'talk'.
declareState('currentTask',  { type: 'string', export: true })
declareState('talkMessage',  { type: 'string', export: true })

run(async () => {
  let prev = stateGet('currentTask')

  while (!signal.aborted) {
    const task = stateGet('currentTask')

    if (task === 'talk' && prev !== 'talk') {
      const msg = stateGet('talkMessage')
      if (msg) {
        bot.chat(msg)
        report({ kind: 'said', message: msg })
      } else {
        report({ kind: 'idle', reason: 'no talkMessage set' })
      }
    }

    prev = task
    await sleep(100)
  }
})

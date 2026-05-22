// Ambient: monitors inventory against the standard kit. When the bot is short
// on kit items, switches currentTask to 'acquire_kit'. Only re-triggers when
// the shortfall *changes* — avoids infinite loops if acquire_kit can't fully
// resolve (e.g. no bread available).

declareState('currentTask', { type: 'string', export: true })

run(async () => {
  if (!bot.kit) await snippetLoad('lib_craft')
  const k = bot.kit

  let lastTriggerKey = ''

  while (!signal.aborted) {
    await sleep(5000)

    const task = stateGet('currentTask')
    if (task === 'acquire_kit') continue       // wait for it to finish

    const missing = k.kitMissing()
    const key = missing.map(m => `${m.name}:${m.short}`).join('|')

    if (missing.length === 0) { lastTriggerKey = ''; continue }
    if (key === lastTriggerKey) continue       // same shortfall as last trigger; don't loop

    lastTriggerKey = key
    report({ kind: 'kit-short', missing, interrupting: task || '(idle)' })
    stateSet('currentTask', 'acquire_kit')
  }
})

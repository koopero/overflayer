// Task: equip an item once, then report done.
// Re-triggers each time currentTask transitions to 'equip'.
declareState('currentTask', { type: 'string', export: true })
declareState('equipItem',   { type: 'string', export: true })
declareState('equipSlot',   { type: 'string', export: true, default: 'hand' })

run(async () => {
  let prev = stateGet('currentTask')

  while (!signal.aborted) {
    const task = stateGet('currentTask')

    if (task === 'equip' && prev !== 'equip') {
      const itemName = stateGet('equipItem')
      if (!itemName) {
        report({ kind: 'idle', reason: 'no equipItem set' })
      } else {
        const item = bot.inventory.items().find(i => i.name.includes(itemName))
        if (!item) {
          report({ kind: 'not-found', item: itemName })
        } else {
          const slot = stateGet('equipSlot') || 'hand'
          try {
            await bot.equip(item, slot)
            report({ kind: 'equipped', item: item.name, slot })
          } catch (err) {
            report({ kind: 'failed', reason: err.message })
          }
        }
      }
    }

    prev = task
    await sleep(100)
  }
})

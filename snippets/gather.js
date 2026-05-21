// Task: find and collect the nearest block of type gatherBlock.
// Uses collectBlock plugin if available; otherwise navigates then digs manually.
declareState('currentTask',  { type: 'string', export: true })
declareState('gatherBlock',  { type: 'string', export: true })
declareState('navTarget',    { type: 'vec3',   export: true })
declareState('navRadius',    { type: 'number', export: true, default: 3 })
declareState('navStatus',    { type: 'string', default: 'idle' })

run(async () => {
  while (!signal.aborted) {
    if (stateGet('currentTask') !== 'gather') {
      stateSet('navTarget', null)
      await sleep(500)
      continue
    }

    const blockType = stateGet('gatherBlock')
    if (!blockType) {
      report({ kind: 'idle', reason: 'no gatherBlock set' })
      await sleep(1000)
      continue
    }

    const blockId = bot.registry?.blocksByName[blockType]?.id
    if (blockId === undefined) {
      report({ kind: 'unknown-block', block: blockType })
      await sleep(3000)
      continue
    }

    const block = bot.findBlock({ matching: blockId, maxDistance: 64 })
    if (!block) {
      report({ kind: 'searching', block: blockType, reason: 'none in range' })
      await sleep(3000)
      continue
    }

    // --- collectBlock path (handles navigate + dig internally) ---
    if (bot.collectBlock) {
      try {
        report({ kind: 'collecting', block: blockType, at: block.position })
        await bot.collectBlock.collect(block)
        report({ kind: 'collected', block: blockType })
      } catch (err) {
        if (err instanceof ScopeDisposedError) return
        report({ kind: 'error', message: err.message })
        await sleep(1000)
      }
      continue
    }

    // --- manual path: navigate via nav bus, then dig ---
    const { x, y, z } = block.position
    stateSet('navTarget', { x, y, z })
    stateSet('navRadius', 3)

    while (!signal.aborted && stateGet('currentTask') === 'gather') {
      const status = stateGet('navStatus')
      if (status === 'arrived') break
      if (status === 'failed') {
        report({ kind: 'unreachable', block: blockType, at: block.position })
        stateSet('navTarget', null)
        await sleep(2000)
        break
      }
      await sleep(300)
    }

    if (stateGet('currentTask') !== 'gather') continue
    if (stateGet('navStatus') !== 'arrived') continue

    stateSet('navTarget', null)

    try {
      report({ kind: 'digging', block: blockType, at: block.position })
      await bot.dig(block)
      report({ kind: 'dug', block: blockType })
    } catch (err) {
      if (err instanceof ScopeDisposedError) return
      report({ kind: 'dig-error', message: err.message })
    }

    await sleep(300)
  }
})

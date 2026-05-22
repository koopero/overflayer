// Task: chop logs until inventory holds `woodTarget` logs.
// Routes movement through the navigate bus (writes navTarget, awaits navStatus).
// Activates when currentTask === 'gather_wood'. Clears currentTask on completion.
declareState('currentTask', { type: 'string', export: true })
declareState('woodTarget',  { type: 'number', export: true, default: 16 })
declareState('navTarget',   { type: 'vec3',   export: true })
declareState('navRadius',   { type: 'number', export: true, default: 3 })
declareState('navStatus',   { type: 'string', default: 'idle' })

run(async () => {
  if (!bot.kit) await snippetLoad('lib_craft')
  const k = bot.kit
  const logIds = new Set(k.LOG_NAMES.map(k.bid).filter(Boolean))
  const totalLogs = () => k.invCountAny(k.LOG_NAMES)

  while (!signal.aborted) {
    if (stateGet('currentTask') !== 'gather_wood') {
      if (stateGet('navTarget') !== null) stateSet('navTarget', null)
      await sleep(500)
      continue
    }

    const target = stateGet('woodTarget') || 16
    if (totalLogs() >= target) {
      report({ kind: 'done', logs: totalLogs() })
      stateSet('navTarget', null)
      stateSet('currentTask', '')
      continue
    }

    const b = bot.findBlock({ matching: b => logIds.has(b.type), maxDistance: 64 })
    if (!b) {
      report({ kind: 'searching', have: totalLogs(), need: target })
      await sleep(3000)
      continue
    }

    report({ kind: 'chopping', at: b.position, have: totalLogs(), need: target })
    stateSet('navTarget', { x: b.position.x, y: b.position.y, z: b.position.z })
    stateSet('navRadius', 3)

    // Wait for arrival
    while (!signal.aborted && stateGet('currentTask') === 'gather_wood') {
      const status = stateGet('navStatus')
      if (status === 'arrived') break
      if (status === 'failed') {
        report({ kind: 'unreachable', at: b.position })
        stateSet('navTarget', null)
        await sleep(2000)
        break
      }
      await sleep(300)
    }
    if (stateGet('currentTask') !== 'gather_wood') continue
    if (stateGet('navStatus') !== 'arrived') continue

    stateSet('navTarget', null)

    const block = bot.blockAt(b.position)
    if (!block || block.name === 'air') continue
    try { await bot.dig(block); await sleep(400) }
    catch (e) { if (e instanceof ScopeDisposedError) return; await sleep(500) }
  }
})

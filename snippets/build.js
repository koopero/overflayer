// Task: place buildBlock at buildTarget position.
// Navigates to within reach, equips the block, places it on the surface below.
declareState('currentTask', { type: 'string', export: true })
declareState('buildTarget', { type: 'vec3',   export: true })
declareState('buildBlock',  { type: 'string', export: true, default: 'dirt' })
declareState('navTarget',   { type: 'vec3',   export: true })
declareState('navRadius',   { type: 'number', export: true, default: 3 })
declareState('navStatus',   { type: 'string', default: 'idle' })

run(async () => {
  while (!signal.aborted) {
    if (stateGet('currentTask') !== 'build') {
      if (stateGet('navTarget') !== null) stateSet('navTarget', null)
      await sleep(500)
      continue
    }

    const target = stateGet('buildTarget')
    if (!target) {
      report({ kind: 'idle', reason: 'no buildTarget set' })
      await sleep(1000)
      continue
    }

    // Navigate to within reach of the target position
    stateSet('navTarget', { x: target.x, y: target.y, z: target.z })
    stateSet('navRadius', 3)

    while (!signal.aborted && stateGet('currentTask') === 'build') {
      const status = stateGet('navStatus')
      if (status === 'arrived') break
      if (status === 'failed') {
        report({ kind: 'unreachable', target })
        stateSet('navTarget', null)
        await sleep(2000)
        break
      }
      await sleep(300)
    }

    if (stateGet('currentTask') !== 'build') continue
    if (stateGet('navStatus') !== 'arrived') continue

    stateSet('navTarget', null)

    const blockName = stateGet('buildBlock') || 'dirt'
    const item = bot.inventory.items().find(i => i.name.includes(blockName))
    if (!item) {
      report({ kind: 'no-item', block: blockName })
      await sleep(2000)
      continue
    }

    // Place against the block directly below the target position
    const surface = bot.blockAt(new Vec3(target.x, target.y - 1, target.z))
    if (!surface || surface.name === 'air') {
      report({ kind: 'no-surface', target, reason: 'nothing to place against below target' })
      await sleep(1000)
      continue
    }

    try {
      await bot.equip(item, 'hand')
      await bot.placeBlock(surface, new Vec3(0, 1, 0))
      report({ kind: 'placed', block: blockName, at: target })
      stateSet('buildTarget', null)
    } catch (err) {
      if (err instanceof ScopeDisposedError) return
      report({ kind: 'place-error', message: err.message })
      await sleep(1000)
    }
  }
})

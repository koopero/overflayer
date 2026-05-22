// One-shot: top up the bot's kit. Returns home, withdraws what the input chest
// has, then crafts the remainder. Mines + smelts iron as needed to fulfill iron
// tools. Bread is taken from the chest only (no farming logic yet).
//
// Activates when currentTask === 'acquire_kit'. Clears currentTask on completion.

declareState('currentTask', { type: 'string', export: true })
declareState('home',        { type: 'vec3',   export: true })

run(async () => {
  if (!bot.kit) await snippetLoad('lib_craft')
  const k = bot.kit

  // Wait until activated (allows pre-loading)
  while (!signal.aborted && stateGet('currentTask') !== 'acquire_kit') {
    await sleep(500)
  }
  if (signal.aborted) return

  const home = stateGet('home')
  if (!home) {
    report({ kind: 'no-home', reason: 'run recharge first' })
    stateSet('currentTask', '')
    return stop('no-home')
  }

  // 1. Go home and withdraw available kit items
  report({ kind: 'going-home' })
  await k.goHome({ radius: 1 })
  if (signal.aborted) return

  const kitNames = new Set(k.STANDARD_KIT.map(x => x.name))
  const taken = await k.takeFromHome(s => kitNames.has(s.name))
  if (taken.length) {
    report({ kind: 'withdrew', items: taken.map(t => `${t.name}x${t.count}`) })
  }

  if (k.kitMissing().length === 0) {
    report({ kind: 'done', source: 'chest' })
    stateSet('currentTask', '')
    return stop('done')
  }

  // 2. Make sure we can actually mine iron — need at least a stone pickaxe.
  const capable = await ensureMiningCapable()
  if (signal.aborted) return
  if (!capable) {
    report({ kind: 'partial', stillMissing: k.kitMissing(), reason: 'no iron-capable pickaxe' })
    stateSet('currentTask', '')
    return stop('blocked')
  }

  // 3. For each missing iron tool, fulfill (mine + smelt + craft).
  for (const m of k.kitMissing()) {
    if (signal.aborted) return
    if (m.name === 'bread') continue                              // can't craft without wheat
    if (!m.name.startsWith('iron_')) continue                     // unknown kit item
    report({ kind: 'fulfilling', tool: m.name, need: m.short })
    await fulfillIronTool(m.name, m.short)
  }

  // 4. Report and exit
  const stillMissing = k.kitMissing()
  if (stillMissing.length === 0) {
    report({ kind: 'done', source: 'craft' })
  } else {
    report({ kind: 'partial', stillMissing })
  }
  stateSet('currentTask', '')
  stop('done')

  // ---- helpers ----

  function hasIronCapablePickaxe () {
    return k.invItems().some(i =>
      ['stone_pickaxe','iron_pickaxe','diamond_pickaxe','netherite_pickaxe'].includes(i.name))
  }

  async function ensureMiningCapable () {
    if (hasIronCapablePickaxe()) { await k.equipBestPickaxe(); return true }

    // Need a wooden pickaxe to mine cobble, then craft a stone one.
    if (!k.invItems().some(i => i.name.endsWith('_pickaxe'))) {
      report({ kind: 'crafting', item: 'wooden_pickaxe' })
      await k.ensurePlanks(3)
      await k.ensureSticks(2)
      await k.craft('wooden_pickaxe', 1)
    }
    await k.equipBestPickaxe()

    if (k.invCount('cobblestone') < 3) {
      const STONE_NAMES = ['stone','granite','diorite','andesite']
      const stoneIds = new Set(STONE_NAMES.map(k.bid).filter(Boolean))
      if (bot.pathfinder?.movements) {
        bot.pathfinder.movements.canDig = true
        bot.pathfinder.movements.maxDropDown = 4
      }
      while (!signal.aborted && k.invCount('cobblestone') < 3) {
        const b = bot.findBlock({ matching: b => stoneIds.has(b.type), maxDistance: 48 })
        if (!b) { report({ kind: 'searching', for: 'stone' }); await sleep(3000); continue }
        await k.goto(b.position.x, b.position.y, b.position.z, { radius: 3 })
        if (signal.aborted) return false
        const block = bot.blockAt(b.position)
        if (!block || block.name === 'air') continue
        await k.equipBestPickaxe()
        try { await bot.dig(block); await sleep(300) }
        catch (e) { if (e instanceof ScopeDisposedError) return false; await sleep(500) }
      }
    }
    if (signal.aborted) return false
    // Return home before crafting — we may have wandered far underground.
    report({ kind: 'returning-home', for: 'stone_pickaxe' })
    await k.goHome({ radius: 2 })
    if (signal.aborted) return false
    await k.ensureSticks(2)
    report({ kind: 'crafting', item: 'stone_pickaxe' })
    const crafted = await k.craft('stone_pickaxe', 1)
    await k.equipBestPickaxe()
    if (!hasIronCapablePickaxe()) {
      report({ kind: 'fatal', reason: 'stone_pickaxe craft failed', craftReturned: crafted })
      return false
    }
    report({ kind: 'ready-to-mine-iron' })
    return true
  }

  async function mineIron (qty) {
    await k.equipBestPickaxe()
    if (bot.pathfinder?.movements) {
      bot.pathfinder.movements.canDig = true
      bot.pathfinder.movements.maxDropDown = 4
    }
    const isOre = b => b.name === 'iron_ore' || b.name === 'deepslate_iron_ore'
    let mined = 0
    let searchStreak = 0
    while (!signal.aborted && mined < qty) {
      const b = bot.findBlock({ matching: isOre, maxDistance: 64 })
      if (!b) {
        searchStreak++
        report({ kind: 'searching', for: 'iron', streak: searchStreak })
        if (searchStreak >= 3) return mined          // give up if we can't find any nearby
        await sleep(3000)
        continue
      }
      searchStreak = 0
      await k.goto(b.position.x, b.position.y, b.position.z, { radius: 3, timeout: 20000 })
      if (signal.aborted) return mined
      const block = bot.blockAt(b.position)
      if (!block || block.name === 'air') continue
      await k.equipBestPickaxe()
      const rawBefore = k.invCount('raw_iron')
      try {
        await bot.dig(block, true)
        mined++
        await sleep(600)   // give pickup a beat
        const rawAfter = k.invCount('raw_iron')
        report({ kind: 'mined-ore', at: b.position, rawIron: rawAfter, delta: rawAfter - rawBefore })
      } catch (e) { if (e instanceof ScopeDisposedError) return mined; await sleep(500) }
    }
    return mined
  }

  async function fulfillIronTool (toolName, qty) {
    // Sticks (need 1 stick per tool, +1 spare)
    await k.ensureSticks(qty + 1)

    // Ingots: each tool needs ingots (pickaxe/shovel/sword each 1-3 ingots).
    // We aim for 3*qty as a safe overshoot for picks; smelt as we go.
    const ingotsNeeded = qty * 3
    while (k.invCount('iron_ingot') < ingotsNeeded && !signal.aborted) {
      if (k.invCount('raw_iron') > 0) {
        report({ kind: 'smelting', qty: k.invCount('raw_iron') })
        const n = await k.smelt('raw_iron', k.invCount('raw_iron'))
        if (!n) { report({ kind: 'smelt-failed' }); break }
        continue
      }
      const want = ingotsNeeded - k.invCount('iron_ingot')
      report({ kind: 'mining-iron', need: want })
      const got = await mineIron(want)
      if (!got) { report({ kind: 'no-iron-found' }); break }
    }

    if (k.invCount('iron_ingot') < 1) {
      report({ kind: 'short-ingots', for: toolName, have: 0 })
      return false
    }

    report({ kind: 'crafting', item: toolName, qty })
    return k.craft(toolName, qty)
  }
})

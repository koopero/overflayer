// Background defense subroutine. Event-driven — reacts on bot.on('health') immediately.
// Interrupts pathfinder, attacks nearest hostile, resumes when clear.
// Safe to run alongside any other snippet.

const HOSTILE = new Set([
  'zombie','skeleton','spider','creeper','witch','enderman','husk','stray',
  'drowned','zombie_villager','pillager','vindicator','phantom','slime',
  'magma_cube','silverfish','cave_spider','wither_skeleton','blaze','bogged',
])

const SWORD_ORDER = ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword','golden_sword']
const AXE_ORDER   = ['netherite_axe','diamond_axe','iron_axe','stone_axe','wooden_axe','golden_axe']

function findNearestHostile (range = 12) {
  let best = null, bestDist = range
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !HOSTILE.has(e.name)) continue
    const d = e.position.distanceTo(bot.entity.position)
    if (d < bestDist) { best = e; bestDist = d }
  }
  return best
}

function equipBestWeapon () {
  const inv = bot.inventory.items()
  for (const name of [...SWORD_ORDER, ...AXE_ORDER]) {
    const item = inv.find(i => i.name === name)
    if (item) { bot.equip(item, 'hand').catch(() => {}); return }
  }
}

let defending = false

async function defend () {
  if (defending) return
  defending = true

  // Pause pathfinder
  try { bot.pathfinder?.setGoal(null) } catch (_) {}

  equipBestWeapon()

  let consecutive = 0
  while (!signal.aborted) {
    const target = findNearestHostile(16)
    if (!target) {
      consecutive++
      if (consecutive >= 3) break   // 3 clear ticks = safe
    } else {
      consecutive = 0
      try {
        await bot.lookAt(target.position.offset(0, 1.62, 0), true)
      } catch (_) {}
      const dist = target.position.distanceTo(bot.entity.position)
      if (dist < 3.2) {
        bot.attack(target)
      } else if (dist < 8 && bot.pathfinder && GoalNear) {
        try { bot.pathfinder.setGoal(new GoalNear(target.position.x, target.position.y, target.position.z, 1)) } catch (_) {}
      }
    }
    await sleep(250)
  }

  try { bot.pathfinder?.setGoal(null) } catch (_) {}
  report({ kind: 'threat-clear', hp: bot.health })
  defending = false
}

// Trigger on every health event
bot.on('health', () => {
  if (bot.health < 15 || findNearestHostile(8)) {
    defend().catch(() => {})
  }
})

// Also scan every 2s in case health event fires before entity spawns
run(async () => {
  report({ kind: 'defend-active', hp: bot.health })
  while (!signal.aborted) {
    if (!defending && findNearestHostile(6)) {
      defend().catch(() => {})
    }
    await sleep(2000)
  }
})

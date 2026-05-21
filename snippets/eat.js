// Always-on background behavior. No task gate — eating is never the task.
const EDIBLE = [
  'bread', 'apple', 'carrot', 'baked_potato',
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_salmon', 'cooked_cod'
]

run(async () => {
  while (!signal.aborted) {
    if (bot.food < 16) {
      const food = bot.inventory.items().find(i => EDIBLE.some(n => i.name.includes(n)))
      if (food) {
        try {
          await bot.equip(food, 'hand')
          await bot.consume()
        } catch (_) {}
      }
    }
    await sleep(2000)
  }
})

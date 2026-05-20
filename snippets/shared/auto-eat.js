const EDIBLE = ['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'apple', 'carrot', 'baked_potato']

run(async () => {
  while (!signal.aborted) {
    if (bot.food < 16) {
      const food = bot.inventory.items().find(i => EDIBLE.some(name => i.name.includes(name)))
      if (food) {
        try {
          await bot.equip(food, 'hand')
          await bot.consume()
        } catch (err) {
          // out of food, interrupted, etc — try again next tick
        }
      }
    }
    await sleep(2000)
  }
})

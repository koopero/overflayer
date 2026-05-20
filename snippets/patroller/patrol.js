const WAYPOINTS = [
  new Vec3(10, 64, 10),
  new Vec3(-10, 64, 10),
  new Vec3(-10, 64, -10),
  new Vec3(10, 64, -10)
]

run(async () => {
  let i = 0
  while (!signal.aborted) {
    const wp = WAYPOINTS[i]
    if (bot.pathfinder && GoalNear) {
      await bot.pathfinder.goto(new GoalNear(wp.x, wp.y, wp.z, 1))
    } else {
      bot.chat(`(no pathfinder) would walk to ${wp.x} ${wp.y} ${wp.z}`)
    }
    await sleep(3000)
    i = (i + 1) % WAYPOINTS.length
  }
})

import { manager } from '../utils/manager'

export default defineNitroPlugin(() => {
  const m = manager()
  if (m.sessions.size > 0) return // already booted

  const configPath = process.env.OVERFLAYER_CONFIG || 'config.yaml'
  try {
    m.loadConfig(configPath)
    m.start()
    console.log(`[overflayer-web] booted ${m.sessions.size} session(s) from ${configPath}`)
  } catch (err: any) {
    console.error(`[overflayer-web] failed to start sessions: ${err.message}`)
  }
})

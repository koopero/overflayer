import { manager } from '../utils/manager'

export default defineEventHandler((event) => {
  const m = manager()
  setResponseHeader(event, 'Content-Type', 'text/event-stream')
  setResponseHeader(event, 'Cache-Control', 'no-cache')
  setResponseHeader(event, 'Connection', 'keep-alive')
  setResponseHeader(event, 'X-Accel-Buffering', 'no')

  const res = event.node.res
  res.flushHeaders?.()

  // Replay recent events so a freshly-opened tab is populated immediately.
  for (const evt of m.recentEvents(50)) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`)
  }

  const listener = (evt: any) => {
    try { res.write(`data: ${JSON.stringify(evt)}\n\n`) } catch (_) {}
  }
  m.on('event', listener)

  const ping = setInterval(() => {
    try { res.write(`: ping\n\n`) } catch (_) {}
  }, 15000)

  const close = () => {
    clearInterval(ping)
    m.off('event', listener)
    try { res.end() } catch (_) {}
  }
  event.node.req.on('close', close)
  event.node.req.on('end', close)
})

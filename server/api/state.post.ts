import { manager } from '../utils/manager'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  if (!body || typeof body !== 'object') {
    throw createError({ statusCode: 400, statusMessage: 'JSON body required' })
  }
  const { targets, key, value } = body as any
  if (!key) {
    throw createError({ statusCode: 400, statusMessage: 'key is required' })
  }
  try {
    const results = manager().setState({ targets, key, value })
    return { key, results }
  } catch (err: any) {
    throw createError({ statusCode: 400, statusMessage: err.message })
  }
})

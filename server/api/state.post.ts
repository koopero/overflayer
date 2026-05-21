import { manager } from '../utils/manager'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  if (!body || typeof body !== 'object') {
    throw createError({ statusCode: 400, statusMessage: 'JSON body required' })
  }
  const { targets, id, key, value } = body as any
  if (!id || !key) {
    throw createError({ statusCode: 400, statusMessage: 'id and key are required' })
  }
  try {
    const results = manager().setState({ targets, id, key, value })
    return { id, key, results }
  } catch (err: any) {
    throw createError({ statusCode: 400, statusMessage: err.message })
  }
})

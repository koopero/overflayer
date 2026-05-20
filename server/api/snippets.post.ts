import { manager } from '../utils/manager'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  if (!body || typeof body !== 'object') {
    throw createError({ statusCode: 400, statusMessage: 'JSON body required' })
  }
  const { targets, id, code } = body as any
  if (!id || !code) {
    throw createError({ statusCode: 400, statusMessage: 'id and code are required' })
  }
  try {
    const results = await manager().loadSnippet({ targets, id, code })
    return { id, results }
  } catch (err: any) {
    throw createError({ statusCode: 400, statusMessage: err.message })
  }
})

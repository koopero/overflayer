import { manager } from '../utils/manager'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  if (!body || typeof body !== 'object') {
    throw createError({ statusCode: 400, statusMessage: 'JSON body required' })
  }
  const { targets, id } = body as any
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'id is required' })
  }
  try {
    const results = manager().unloadSnippet({ targets, id })
    return { id, results }
  } catch (err: any) {
    throw createError({ statusCode: 400, statusMessage: err.message })
  }
})

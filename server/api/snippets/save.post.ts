import { manager } from '../../utils/manager'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  if (!body || typeof body !== 'object') {
    throw createError({ statusCode: 400, statusMessage: 'JSON body required' })
  }
  const { id, code, dir } = body as any
  if (!id || typeof code !== 'string' || !dir) {
    throw createError({ statusCode: 400, statusMessage: 'id, code, and dir are required' })
  }
  try {
    const result = manager().saveSnippetToDir({ id, code, dir })
    return { id, ...result }
  } catch (err: any) {
    throw createError({ statusCode: 400, statusMessage: err.message })
  }
})

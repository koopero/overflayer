import { manager } from '../../utils/manager'

export default defineEventHandler((event) => {
  const username = getRouterParam(event, 'username') as string
  const found = manager().get(username)
  if (!found) {
    throw createError({ statusCode: 404, statusMessage: `no such player: ${username}` })
  }
  return found
})

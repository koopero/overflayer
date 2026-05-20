import { manager } from '../utils/manager'

export default defineEventHandler(() => {
  return manager().list()
})

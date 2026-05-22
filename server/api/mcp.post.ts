import { handleMcpRequest } from '../utils/mcpServer'

export default defineEventHandler(async (event) => {
  // Pre-parse JSON so we can hand it to the transport without re-reading the stream.
  // (Streamable HTTP supports both initialize/notifications/responses on POST.)
  let body: any
  try { body = await readBody(event) } catch (_) { body = undefined }
  await handleMcpRequest(event, body)
})

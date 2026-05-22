import { handleMcpRequest } from '../utils/mcpServer'

// MCP Streamable HTTP also supports GET for the SSE response channel.
// In stateless mode the transport responds 405 if the spec doesn't expect a
// GET — that's fine, we just forward.
export default defineEventHandler(async (event) => {
  await handleMcpRequest(event)
})

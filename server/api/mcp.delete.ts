import { handleMcpRequest } from '../utils/mcpServer'

// MCP Streamable HTTP uses DELETE to terminate a session (stateful mode only).
// In stateless mode this is effectively a no-op handled by the transport.
export default defineEventHandler(async (event) => {
  await handleMcpRequest(event)
})

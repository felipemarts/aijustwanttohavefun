import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Answers one Streamable HTTP POST in stateless mode (no `Mcp-Session-Id`, nothing kept between requests): a fresh
 * server and transport per request, JSON responses instead of an SSE stream (the tools send no notifications).
 * `parsedBody` is the JSON the host already parsed (and size-limited); the transport still checks `Accept`,
 * `Content-Type` and `MCP-Protocol-Version`. GET and DELETE are the host's to refuse with 405: a stateless server
 * offers no standalone SSE stream and has no session to end.
 */
export async function handleStatelessPost(build: () => McpServer, request: Request, parsedBody: unknown): Promise<Response> {
  const server = build();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, { parsedBody });
  } finally {
    // The JSON response is complete once handleRequest resolves; closing frees the per-request server.
    await server.close();
  }
}

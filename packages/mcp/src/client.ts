/**
 * The official MCP client pieces, re-exported for the game server's tests and scripts (which do not depend on the
 * MCP SDK directly).
 */
export { Client } from '@modelcontextprotocol/sdk/client/index.js';
export { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
export { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
export { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
export type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

#!/usr/bin/env node
// Launcher for MCP clients: `node /path/to/aijustwanttohavefun/packages/mcp/bin/stdio.mjs`. Works from any working
// directory (clients rarely let you set one) and writes nothing to stdout but MCP messages.
import { register } from 'tsx/esm/api';

register();
await import('../src/stdio.ts');

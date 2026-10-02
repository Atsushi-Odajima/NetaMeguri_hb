// ContentLoop MCP server (stdio). Usage (Claude Code):
//   claude mcp add contentloop -e CONTENTLOOP_DATA_DIR=/path/data -e CONTENTLOOP_MCP_USER=you@example.com \
//     -e CONTENTLOOP_MCP_WORKSPACE=ws_xxx -- npx tsx server/src/mcp/stdio.ts
// The server acts as that user inside that workspace with that user's RBAC role.
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApp } from '../app.js';
import { ctxFor } from '../domain/workspace.js';
import { TOOLS, callTool } from './tools.js';

const dataDir = resolve(process.env.CONTENTLOOP_DATA_DIR ?? './data');
const app = createApp({ dbPath: `${dataDir}/contentloop.db`, storageDir: `${dataDir}/objects` });
const email = process.env.CONTENTLOOP_MCP_USER;
const wsId = process.env.CONTENTLOOP_MCP_WORKSPACE;
if (!email || !wsId) {
  console.error('CONTENTLOOP_MCP_USER and CONTENTLOOP_MCP_WORKSPACE are required');
  process.exit(1);
}
const user = app.db.get('SELECT id FROM users WHERE email = ?', email.toLowerCase());
if (!user) {
  console.error('user not found');
  process.exit(1);
}
const ctx = ctxFor(app, user.id, wsId, 'mcp');

const server = new McpServer({ name: 'contentloop', version: '0.1.0' });
for (const t of TOOLS) {
  server.registerTool(t.name, { description: t.description, inputSchema: t.input, annotations: t.annotations }, async (args: any) => {
    try {
      const out = await callTool(ctx, t.name, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] };
    }
  });
}
await server.connect(new StdioServerTransport());

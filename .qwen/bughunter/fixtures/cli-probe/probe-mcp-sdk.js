#!/usr/bin/env node
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const server = new Server(
  { name: 'probe-cwd-sdk', version: '0.0.1' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_cwd',
      description: 'Return the current working directory of the stdio MCP server process.',
      inputSchema: { type: 'object', properties: {}, required: [] }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'get_cwd') {
    return {
      content: [{ type: 'text', text: JSON.stringify({ cwd: process.cwd() }) }],
      isError: false
    };
  }
  return { content: [{ type: 'text', text: 'Unknown tool' }], isError: true };
});

const transport = new StdioServerTransport();
server.connect(transport);

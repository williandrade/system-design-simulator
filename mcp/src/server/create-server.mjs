import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { failure } from '../shared/result.mjs';
import { canvasTools } from '../tools/canvas-tools.mjs';

export const SERVER_INFO = {
  name: 'willis-overengineer-inator',
  title: "Willi's Overengineer-inator",
  version: '0.1.0',
};

const instructions = [
  'Read the paired canvas with get_canvas_state before editing.',
  'Use list_service_types for service identifiers and ports, and can_connect for proposed traffic connections.',
  'Check the available tools can complete the request. Explain any required manual steps before editing.',
  'Use apply_graph for a complete replacement. Preview destructive batches with dryRun and use the current revision.',
  'If a dispatched edit returns RESULT_UNKNOWN, reconnect and read the canvas before deciding whether to retry.',
].join(' ');

const errorOutput = z.object({ code: z.string(), message: z.string() });

function objectSchema(schema) {
  // The MCP tool schema root is an object, including when Zod emits an anyOf.
  return { type: 'object', ...z.toJSONSchema(schema, { target: 'draft-07', io: 'input' }) };
}

function describeTool([name, tool]) {
  return {
    name,
    description: tool.description,
    inputSchema: objectSchema(tool.clientInput ?? tool.input),
    // Some clients validate structured errors too. Preserve the existing error
    // payload and advertise it alongside successful results.
    outputSchema: objectSchema(z.union([tool.clientOutput ?? tool.output, errorOutput])),
    annotations: {
      readOnlyHint: !tool.mutates,
      destructiveHint: tool.destructive ?? false,
      openWorldHint: false,
    },
  };
}

function toolResult(result, summary) {
  if (!result.ok) {
    return {
      isError: true,
      structuredContent: result.error,
      content: [{ type: 'text', text: `${result.error.code}: ${result.error.message}` }],
    };
  }
  return {
    structuredContent: result.data,
    content: [{ type: 'text', text: summary(result.data) }],
  };
}

export function createCanvasMcpServer(relay, { operatorPairing = false } = {}) {
  const tools = new Map(canvasTools);
  // In operator mode the operator owns the code, so the client must not be able to request one.
  if (operatorPairing) tools.delete('get_canvas_pairing');
  const mcp = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions });
  const toolDescriptions = Array.from(tools, describeTool);

  mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolDescriptions }));

  mcp.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    const tool = tools.get(params.name);
    if (!tool) return toolResult(failure('UNKNOWN_TOOL', 'This simulator tool is unavailable.'));

    const input = (tool.clientInput ?? tool.input).safeParse(params.arguments ?? {});
    if (!input.success) {
      const issue = input.error.issues[0];
      const path = issue.path.length ? `${issue.path.join('.')}: ` : '';
      return toolResult(failure('INVALID_ARGUMENT', `${path}${issue.message}`));
    }

    // Response formatting is a client preference and stays out of the relay.
    const { responseFormat, ...args } = input.data;
    const result = params.name === 'get_canvas_pairing'
      ? await relay.issuePairing()
      : await relay.request(params.name, args, signal);
    if (result.ok && responseFormat === 'concise') {
      return toolResult({ ok: true, data: tool.compact(result.data) }, JSON.stringify);
    }
    return toolResult(result, (data) => tool.summary(data, args));
  });

  return mcp;
}

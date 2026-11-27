import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCanvasMcpServer } from '../src/server/create-server.mjs';
import { addArgs, nextFrame, pair, respond, sampleNode, sampleState, start } from './helpers.mjs';

async function connectMcp(t, relay, options) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'simulator-test', version: '1.0.0' });
  const server = createCanvasMcpServer(relay, options);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  return client;
}

test('advertises strict MCP schemas and returns structured errors and values over the SDK', async (t) => {
  const relay = await start(t);
  const client = await connectMcp(t, relay);
  assert.equal(client.getServerVersion().name, 'willis-overengineer-inator');
  assert.equal(client.getServerVersion().title, "Willi's Overengineer-inator");
  assert.match(client.getInstructions(), /get_canvas_state.*apply_graph.*RESULT_UNKNOWN/);
  const { tools } = await client.listTools();
  assert.ok(tools.every((tool) => tool.inputSchema.type === 'object' && tool.outputSchema.type === 'object'));
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get('add_node').inputSchema.additionalProperties, false);
  assert.equal(byName.get('apply_graph').annotations.destructiveHint, true);
  assert.equal(byName.get('delete_node').annotations.readOnlyHint, false);
  assert.equal(byName.get('can_connect').annotations.readOnlyHint, true);

  const invalid = await client.callTool({ name: 'add_node', arguments: { ...addArgs, wrapped: true } });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.code, 'INVALID_ARGUMENT');

  const pairing = await client.callTool({ name: 'get_canvas_pairing', arguments: {} });
  const { code, expiresInSeconds } = pairing.structuredContent;
  assert.equal(expiresInSeconds, 300);
  assert.equal(code.length, 22);
  assert.ok(!pairing.content[0].text.includes(code));
  const socket = await pair(relay, code);

  const dispatch = nextFrame(socket);
  const operation = client.callTool({ name: 'get_canvas_state', arguments: {} });
  const expected = sampleState('canvas-a', [sampleNode]);
  respond(socket, await dispatch, { ok: true, data: expected });
  assert.deepEqual((await operation).structuredContent, expected);
});

test('compact creation trims the client reply and preserves renderer arguments and full replies', async (t) => {
  const relay = await start(t);
  const client = await connectMcp(t, relay);
  await client.listTools();
  const socket = await pair(relay);
  const call = async (name, args, data) => {
    const dispatched = nextFrame(socket);
    const result = client.callTool({ name, arguments: args });
    const request = await dispatched;
    respond(socket, request, { ok: true, data });
    return { request, result: await result };
  };

  await call('get_canvas_state', {}, sampleState('canvas-a'));
  const node = { ...sampleNode, config: { requestRate: 50 } };
  const full = await call('add_node', addArgs, { node });
  const compact = await call('add_node', { ...addArgs, responseFormat: 'concise' }, { node });
  assert.deepEqual(full.result.structuredContent, { node });
  assert.deepEqual(compact.request.args, addArgs);
  assert.deepEqual(compact.result.structuredContent, { id: node.id, ports: node.ports });
  assert.deepEqual(JSON.parse(compact.result.content[0].text), compact.result.structuredContent);
});

test('catalog text is concise by default while the structured catalog remains complete', async (t) => {
  const services = [{
    type: 'elb', name: 'Elastic Load Balancer', category: 'Networking', aliases: ['alb'],
    ports: [{ id: 'in-http', direction: 'input', type: 'http' }], allowedTargets: ['ecs'],
    fields: [{ key: 'lbType', type: 'enum', value: 'alb', options: [{ value: 'alb', label: 'Application' }] }],
  }];
  const client = await connectMcp(t, { request: async () => ({ ok: true, data: { services } }) });
  await client.listTools();
  const call = (args) => client.callTool({ name: 'list_service_types', arguments: args });
  const unfiltered = await call({});
  assert.deepEqual(unfiltered.structuredContent, { services });
  assert.deepEqual(JSON.parse(unfiltered.content[0].text).services[0].fields, ['lbType']);
  const filtered = await call({ query: 'alb' });
  assert.deepEqual(JSON.parse(filtered.content[0].text), { services });
});

test('validates batch shapes and payload limits before forwarding a single atomic request', async (t) => {
  const relay = await start(t);
  const client = await connectMcp(t, relay);
  await client.listTools();
  const socket = await pair(relay);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const args = {
    expectedRevision: 4,
    dryRun: true,
    operations: [
      { type: 'add_frame', args: { kind: 'vpc', name: 'Staging', x: 50, y: 50, width: 600, height: 400, ref: 'staging' } },
      { type: 'add_node', args: { ...addArgs, ref: 'client', parentId: '$staging' } },
      { type: 'set_node_config', args: { nodeId: '$client', fields: { requestRate: 50 } } },
    ],
  };
  assert.equal((await call('apply_graph', args)).structuredContent.code, 'CANVAS_STATE_REQUIRED');
  assert.equal((await call('apply_graph', { ...args, operations: [{ type: 'set_simulation', args: { action: 'play' } }] })).structuredContent.code, 'INVALID_ARGUMENT');
  assert.equal((await call('apply_graph', { ...args, operations: Array(101).fill(args.operations[0]) })).structuredContent.code, 'INVALID_ARGUMENT');
  assert.equal((await call('import_canvas', { expectedRevision: 4, project: { name: 'ø'.repeat(460_801) } })).structuredContent.code, 'INVALID_ARGUMENT');

  const readFrame = nextFrame(socket);
  const reading = call('get_canvas_state', {});
  respond(socket, await readFrame, { ok: true, data: { ...sampleState('canvas-a'), revision: 4 } });
  assert.equal((await reading).structuredContent.revision, 4);

  const batchFrame = nextFrame(socket);
  const batch = call('apply_graph', args);
  const request = await batchFrame;
  assert.equal(request.tool, 'apply_graph');
  assert.deepEqual(request.args, args);
  const preview = { revision: 4, dryRun: true, createdIds: [], removedIds: [], updatedIds: [], refs: {} };
  respond(socket, request, { ok: true, data: preview });
  assert.deepEqual((await batch).structuredContent, preview);
});

test('operator pairing stays in memory and its tool is unavailable to the MCP client', async (t) => {
  const code = randomBytes(16).toString('base64url');
  const relay = await start(t, { operatorCode: code });
  const client = await connectMcp(t, relay, { operatorPairing: true });
  assert.ok(!(await client.listTools()).tools.some((tool) => tool.name === 'get_canvas_pairing'));
  const rejected = await client.callTool({ name: 'get_canvas_pairing', arguments: {} });
  assert.equal(rejected.structuredContent.code, 'UNKNOWN_TOOL');
  assert.ok(!JSON.stringify(rejected).includes(code));
  await pair(relay, code);
});

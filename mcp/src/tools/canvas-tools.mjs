import { z } from 'zod';
import {
  addAnnotation, addNode, applyGraph, assignParent, connectNodes, deleteArrow, deleteConnection,
  deleteFrame, deleteNode, graphChange, importCanvas, setCanvasRegion, setNodeConfig, updateArrow,
  updateFrame, updateNode,
} from './graph-operations.mjs';
import {
  arrow, configField, configValue, fields, frame, id, issue, item, name, network, node, pricing, revision,
  simulationMode,
} from './schemas.mjs';

const emptyInput = z.strictObject({});
const jsonSummary = (result) => JSON.stringify(result);
const responseFormat = z.enum(['full', 'concise']).optional();
const nodeId = z.object({ id, ports: z.array(item) });
const objectId = z.object({ id });

function catalogSummary({ services }, { category, query }) {
  if (category || query) return jsonSummary({ services });
  return jsonSummary({
    services: services.map(({ type, name, aliases, ports, fields }) => ({
      type,
      name,
      ...(aliases.length ? { aliases } : {}),
      ports: ports.map(({ id }) => id),
      ...(fields?.length ? { fields: fields.map(({ key }) => key) } : {}),
    })),
    details: 'Filter by category or query for allowed targets and configuration options.',
  });
}

function withCompactCreation(tool, schema, compact) {
  return {
    ...tool,
    clientInput: tool.input.extend({ responseFormat }),
    clientOutput: z.union([tool.output, schema]),
    compact,
  };
}

function diagramEdit(input, description, destructive = false) {
  return { input, description, output: objectId, summary: jsonSummary, mutates: true, destructive };
}

// Mutations require a prior get_canvas_state read in the session. output validates
// renderer replies before the server applies any client-specific projection.
export const canvasTools = new Map([
  ['get_canvas_pairing', {
    description: 'Get a one-time code for a local operator to paste into the canvas MCP panel.',
    input: emptyInput,
    output: z.object({ code: z.string().length(22), expiresInSeconds: z.number().int().positive() }),
    summary: () => 'Pairing code generated for the local operator.',
    mutates: true,
  }],
  ['get_canvas_state', {
    description: 'Read the paired canvas before editing. Returns the graph, revision, ports, region, pricing status and simulation state.',
    input: emptyInput,
    output: z.object({
      canvasId: id,
      revision: revision.optional(),
      nodes: z.array(node),
      connections: z.array(item),
      annotations: z.array(item),
      network: network.optional(),
      region: z.string(),
      pricing: pricing.optional(),
      currency: z.string(),
      mode: simulationMode,
      tick: z.number().int().nonnegative(),
      totals: z.object({ processed: z.number(), dropped: z.number(), avgLatency: z.number() }),
    }),
    summary: (state) => `Canvas ${state.canvasId} is ${state.mode}. Nodes: ${state.nodes.length}. Connections: ${state.connections.length}.`,
  }],
  ['list_service_types', {
    description: 'Discover canonical service types, aliases, ports, allowed targets and key configuration fields before adding or connecting services. Filter by category or query to see more fields.',
    input: z.strictObject({ category: name.optional(), query: name.optional() }),
    output: z.object({ services: z.array(z.object({
      type: id,
      name: z.string(),
      category: z.string(),
      aliases: z.array(z.string()),
      ports: z.array(item),
      allowedTargets: z.array(z.string()),
      fields: z.array(configField).optional(),
    })) }),
    summary: catalogSummary,
  }],
  ['get_node_config_fields', {
    description: 'Read current editable MCP configuration fields, options, units and limits for one node.',
    input: z.strictObject({ nodeId: id }),
    output: z.object({ nodeId: id, fields: z.array(configField) }),
    summary: jsonSummary,
  }],
  ['can_connect', {
    description: 'Check whether the provided output and input can be connected in the current canvas without creating a link.',
    input: connectNodes,
    output: z.object({ allowed: z.boolean(), message: z.string(), connectionType: z.string().optional() }),
    summary: jsonSummary,
  }],
  ['inspect_canvas', {
    description: 'Check for orphan nodes and potentially overlapping simulation paths without changing or starting the canvas.',
    input: emptyInput,
    output: z.object({ issues: z.array(issue) }),
    summary: jsonSummary,
  }],
  ['add_node', withCompactCreation({
    description: 'Add one service to the idle canvas at the given coordinates. Discover service types and aliases with list_service_types. Returns its ID and ports.',
    input: addNode,
    output: z.object({ node }),
    mutates: true,
    summary: ({ node }) => `Added ${node.name} (${node.id}). Ports: ${JSON.stringify(node.ports)}.`,
  }, nodeId, ({ node: { id, ports } }) => ({ id, ports }))],
  ['connect_nodes', withCompactCreation({
    description: 'Connect one specified output port to one specified input port on the idle canvas. Use can_connect to verify a proposed connection.',
    input: connectNodes,
    output: z.object({ connection: item }),
    mutates: true,
    summary: ({ connection }) => `Added connection ${connection.id}.`,
  }, objectId, ({ connection }) => ({ id: connection.id }))],
  ['set_node_config', {
    description: 'Patch the node configuration atomically in idle mode. Use get_node_config_fields first. Legacy requestRate accepts an integer from 2 to 1000 for a client with Dynamic RPS and Variable Traffic off.',
    input: setNodeConfig,
    output: z.union([configValue.extend({ nodeId: id }), z.object({ nodeId: id, fields })]),
    mutates: true,
    summary: jsonSummary,
  }],
  ['add_annotation', withCompactCreation({
    description: 'Add one plain-text annotation to the idle canvas.',
    input: addAnnotation,
    output: z.object({ annotation: item }),
    mutates: true,
    summary: ({ annotation }) => `Added annotation ${annotation.id}.`,
  }, objectId, ({ annotation }) => ({ id: annotation.id }))],
  ['delete_node', {
    description: 'Delete a node and its incident traffic connections from the idle canvas. Use apply_graph for a replacement.',
    input: deleteNode,
    output: z.object({ nodeId: id, connectionIds: z.array(id), arrowIds: z.array(id).optional() }),
    mutates: true,
    destructive: true,
    summary: jsonSummary,
  }],
  ['delete_connection', {
    description: 'Delete one traffic connection by ID from the idle canvas.',
    input: deleteConnection,
    output: z.object({ connectionId: id }),
    mutates: true,
    destructive: true,
    summary: jsonSummary,
  }],
  ['update_node', {
    description: 'Rename or move a node on the idle canvas. Provide at least one of name, x, and y.',
    input: updateNode,
    output: z.object({ node }),
    mutates: true,
    summary: ({ node }) => `Updated ${node.name} (${node.id}).`,
  }],
  ['set_canvas_region', {
    description: 'Select a region by code for the idle canvas. Read the pricing status to determine whether an estimate is available.',
    input: setCanvasRegion,
    output: z.object({ region: id, pricing }),
    mutates: true,
    summary: jsonSummary,
  }],
  ['add_frame', diagramEdit(frame, 'Add a visual VPC, availability zone or subnet frame to the idle canvas. An optional parent frame groups them.')],
  ['update_frame', diagramEdit(updateFrame, 'Patch a visual frame name, bounds or parent. Supply parentId: null to detach the frame.')],
  ['delete_frame', diagramEdit(deleteFrame, 'Remove a visual frame and its visual links. Keep its contents on the canvas.', true)],
  ['assign_parent', diagramEdit(assignParent, 'Put a service in a visual frame. Supply parentId: null to detach the service.')],
  ['add_arrow', diagramEdit(arrow, 'Add a visual arrow between nodes or frames. Visual arrows do not carry simulation traffic.')],
  ['update_arrow', diagramEdit(updateArrow, 'Change a visual arrow’s endpoints or label. Use an empty label to clear it.')],
  ['delete_arrow', diagramEdit(deleteArrow, 'Remove a visual arrow by ID from the idle canvas.', true)],
  ['apply_graph', {
    description: 'Apply a group of edits atomically to the idle canvas at expectedRevision. Use dryRun to preview without editing. Supply ref on creations and refer to them as $ref. Edits are applied in deletion, creation, update and connection phases.',
    input: applyGraph,
    output: graphChange,
    mutates: true,
    destructive: true,
    summary: jsonSummary,
  }],
  ['import_canvas', {
    description: 'Replace the idle canvas with a simulator project export at expectedRevision. Use dryRun to validate and preview the replacement.',
    input: importCanvas,
    output: graphChange,
    mutates: true,
    destructive: true,
    summary: jsonSummary,
  }],
  ['set_simulation', {
    description: 'Play, pause, resume or stop the simulation. Returns the resulting mode and any issues observed at Play.',
    input: z.strictObject({ action: z.enum(['play', 'pause', 'resume', 'stop']) }),
    output: z.object({ mode: simulationMode, issues: z.array(issue).optional() }),
    mutates: true,
    summary: ({ mode, issues }) => issues?.length ? jsonSummary({ mode, issues }) : `Simulation mode: ${mode}.`,
  }],
]);

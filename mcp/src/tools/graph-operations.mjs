import { z } from 'zod';
import { arrow, dimension, fields, fontWeight, frame, id, name, position, revision } from './schemas.mjs';

export const MAX_GRAPH_OPERATIONS = 100;
const MAX_GRAPH_REQUEST_BYTES = 900 * 1024;
const reference = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);

export const addNode = z.strictObject({
  serviceType: id,
  name,
  x: position,
  y: position,
  fields: fields.optional(),
  parentId: id.optional(),
});

export const connectNodes = z.strictObject({
  sourceNodeId: id,
  sourcePortId: id,
  targetNodeId: id,
  targetPortId: id,
});

const legacyConfig = z.strictObject({ nodeId: id, key: z.literal('requestRate'), value: z.number().int().min(2).max(1000) });
const configPatch = z.strictObject({ nodeId: id, fields });
export const setNodeConfig = z.union([legacyConfig, configPatch]);

export const addAnnotation = z.strictObject({
  text: z.string().min(1).max(500).regex(/\S/),
  x: position,
  y: position,
  width: dimension,
  height: dimension,
  fontSize: z.number().min(8).max(72),
  fontWeight,
});

export const setCanvasRegion = z.strictObject({ region: id });
export const deleteNode = z.strictObject({ nodeId: id });
export const deleteConnection = z.strictObject({ connectionId: id });
export const updateNode = z.strictObject({ nodeId: id, name: name.optional(), x: position.optional(), y: position.optional() });
export const assignParent = z.strictObject({ nodeId: id, parentId: id.nullable() });
export const updateFrame = z.strictObject({
  frameId: id,
  name: name.optional(),
  x: position.optional(),
  y: position.optional(),
  width: dimension.optional(),
  height: dimension.optional(),
  parentId: id.nullable().optional(),
});
export const deleteFrame = z.strictObject({ frameId: id });
export const updateArrow = arrow.partial().extend({ arrowId: id });
export const deleteArrow = z.strictObject({ arrowId: id });

const batchOperations = {
  add_node: addNode.extend({ ref: reference.optional() }),
  connect_nodes: connectNodes.extend({ ref: reference.optional() }),
  set_node_config: setNodeConfig,
  add_annotation: addAnnotation.extend({ ref: reference.optional() }),
  delete_node: deleteNode,
  delete_connection: deleteConnection,
  update_node: updateNode,
  set_canvas_region: setCanvasRegion,
  add_frame: frame.extend({ ref: reference.optional() }),
  update_frame: updateFrame,
  delete_frame: deleteFrame,
  assign_parent: assignParent,
  add_arrow: arrow.extend({ ref: reference.optional() }),
  update_arrow: updateArrow,
  delete_arrow: deleteArrow,
};

const operation = z.discriminatedUnion('type', Object.entries(batchOperations).map(([type, args]) => (
  z.strictObject({ type: z.literal(type), args })
)));

const graphRequest = z.strictObject({ expectedRevision: revision, dryRun: z.boolean().optional() });
const withinTransferBudget = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_GRAPH_REQUEST_BYTES;
const transferBudgetError = 'The graph request exceeds the 900 KiB payload limit.';

export const applyGraph = graphRequest.extend({
  operations: z.array(operation).min(1).max(MAX_GRAPH_OPERATIONS),
}).refine(withinTransferBudget, transferBudgetError);

export const importCanvas = graphRequest.extend({
  project: z.looseObject({}),
}).refine(withinTransferBudget, transferBudgetError);

export const graphChange = z.object({
  revision,
  dryRun: z.boolean(),
  createdIds: z.array(id),
  removedIds: z.array(id),
  updatedIds: z.array(id),
  refs: z.record(id, id),
});

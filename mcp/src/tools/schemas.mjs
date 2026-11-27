import { z } from 'zod';

export const id = z.string().min(1).max(128).regex(/\S/);
export const position = z.number().min(-10_000).max(10_000);
export const dimension = z.number().positive().max(2_000);
export const fontWeight = z.enum(['normal', 'bold']);
export const simulationMode = z.enum(['idle', 'running', 'paused']);
export const item = z.looseObject({ id });
export const node = z.looseObject({ id, name: z.string(), ports: z.array(item) });
export const configValue = z.object({ key: z.literal('requestRate'), value: z.number() });
export const name = z.string().min(1).max(100).regex(/\S/);
export const revision = z.number().int().nonnegative();

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const property = z.strictObject({ key: z.string(), value: z.string() });
const editableValue = z.union([scalar, z.array(property)]);

export const fields = z.record(id, editableValue);
export const configField = z.looseObject({
  key: id,
  type: z.enum(['number', 'enum', 'boolean', 'text', 'properties']),
  value: z.union([editableValue, z.null()]),
  label: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  unit: z.string().optional(),
  options: z.array(z.object({ value: scalar, label: z.string() })).optional(),
  visibleIf: z.string().optional(),
  editable: z.boolean().optional(),
});

export const pricing = z.object({
  status: z.enum(['loading', 'ready', 'unavailable']),
  effectiveRegion: z.string().optional(),
  source: z.enum(['api', 'embedded']).optional(),
});
export const issue = z.object({
  code: id,
  severity: z.enum(['warning', 'error']),
  message: z.string(),
  nodeIds: z.array(id),
  connectionIds: z.array(id),
});

export const frameKind = z.enum(['vpc', 'az', 'subnet']);
export const frame = z.strictObject({ kind: frameKind, name, x: position, y: position, width: dimension, height: dimension, parentId: id.optional() });
export const arrow = z.strictObject({ sourceId: id, targetId: id, label: z.string().max(100).optional() });
export const network = z.object({
  frames: z.array(frame.extend({ id })),
  arrows: z.array(arrow.extend({ id })),
  nodeParents: z.record(id, id),
});

export const canvasIdSchema = id;

import type { Annotation, SimulationMode } from '../../../core/models/architecture.model';

type ConnectionArgs = {
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
};

type FrameFields = { name: string; x: number; y: number; width: number; height: number };
type PatchConfig = { nodeId: string; fields: Record<string, unknown> };
type LegacyConfig = { nodeId: string; key: 'requestRate'; value: number };

export type GraphOperation = { type: GraphTool; args: Record<string, unknown> };

export type CanvasToolInput = {
  get_canvas_state: Record<string, never>;
  get_node_config_fields: { nodeId: string };
  add_node: {
    serviceType: string;
    name: string;
    x: number;
    y: number;
    fields?: Record<string, unknown>;
    parentId?: string;
  };
  connect_nodes: ConnectionArgs;
  can_connect: ConnectionArgs;
  delete_node: { nodeId: string };
  delete_connection: { connectionId: string };
  update_node: { nodeId: string; name?: string; x?: number; y?: number };
  list_service_types: { category?: string; query?: string };
  set_node_config: LegacyConfig | PatchConfig;
  set_canvas_region: { region: string };
  add_frame: FrameFields & { kind: 'vpc' | 'az' | 'subnet'; parentId?: string };
  update_frame: Partial<FrameFields> & { frameId: string; parentId?: string | null };
  delete_frame: { frameId: string };
  add_arrow: { sourceId: string; targetId: string; label?: string };
  update_arrow: { arrowId: string; sourceId?: string; targetId?: string; label?: string };
  delete_arrow: { arrowId: string };
  assign_parent: { nodeId: string; parentId: string | null };
  inspect_canvas: Record<string, never>;
  apply_graph: { expectedRevision: number; operations: GraphOperation[]; dryRun?: boolean };
  import_canvas: { expectedRevision: number; project: Record<string, unknown>; dryRun?: boolean };
  add_annotation: Pick<
    Annotation,
    'text' | 'x' | 'y' | 'width' | 'height' | 'fontSize' | 'fontWeight'
  >;
  set_simulation: { action: 'play' | 'pause' | 'resume' | 'stop' };
};

type CanvasTool = keyof CanvasToolInput;
const readTools = [
  'get_canvas_state',
  'get_node_config_fields',
  'list_service_types',
  'can_connect',
  'inspect_canvas',
] as const;
type ReadTool = (typeof readTools)[number];
type CanvasMutation = Exclude<CanvasTool, ReadTool>;
export type GraphTool = Exclude<CanvasMutation, 'apply_graph' | 'import_canvas' | 'set_simulation'>;
export type GraphRequest = Extract<CanvasRequest, { tool: GraphTool }>;

export type CanvasRequest = {
  [Tool in CanvasTool]: {
    requestId: string;
    canvasId: string;
    tool: Tool;
    args: CanvasToolInput[Tool];
  };
}[CanvasTool];

export type GraphPresentationTarget = 'node' | 'frame' | 'connection' | 'annotation' | 'arrow';

export type CanvasAction = {
  targetId: string;
  description: string;
} & (
  | { tool: 'add_node' | 'connect_nodes' | 'add_annotation' }
  | { tool: 'set_node_config'; value?: number; fields?: Record<string, unknown> }
  | {
      tool: 'apply_graph' | 'import_canvas';
      target?: GraphPresentationTarget;
      removedIds: string[];
    }
  | {
      tool: Exclude<
        CanvasMutation,
        | 'add_node'
        | 'connect_nodes'
        | 'add_annotation'
        | 'set_node_config'
        | 'set_simulation'
        | 'apply_graph'
        | 'import_canvas'
      >;
    }
  | { tool: 'set_simulation'; mode: SimulationMode }
);

export type CanvasActionMarker = CanvasAction & {
  canvasId: string;
  sequence: number;
};

export type CanvasResult =
  | { ok: false; error: { code: string; message: string } }
  | { ok: true; data: Record<string, unknown>; action?: CanvasAction };

export function canvasError(code: string, message: string): Extract<CanvasResult, { ok: false }> {
  return { ok: false, error: { code, message } };
}

export function isCanvasRead(tool: CanvasTool): tool is ReadTool {
  return (readTools as readonly string[]).includes(tool);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && value.trim().length > 0;
}

function between(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

type ArgumentValidator = (value: unknown) => boolean;
const identifier: ArgumentValidator = (value) => text(value, 128);
const coordinate: ArgumentValidator = (value) => between(value, -10000, 10000);
const dimension: ArgumentValidator = (value) => between(value, Number.MIN_VALUE, 2000);

type Validators = Record<string, ArgumentValidator>;
type InputShape = { required: Validators; optional?: Validators };
const name: ArgumentValidator = (value) => text(value, 100);
const label: ArgumentValidator = (value) => typeof value === 'string' && value.length <= 100;
const nullableId: ArgumentValidator = (value) => value === null || identifier(value);
const revision: ArgumentValidator = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const dryRun: ArgumentValidator = (value) => typeof value === 'boolean';
const point = { x: coordinate, y: coordinate };
const frame = { ...point, name, width: dimension, height: dimension };
const connection = {
  sourceNodeId: identifier,
  sourcePortId: identifier,
  targetNodeId: identifier,
  targetPortId: identifier,
};
const inputShapes: Record<CanvasTool, InputShape[]> = {
  get_canvas_state: [{ required: {} }],
  get_node_config_fields: [{ required: { nodeId: identifier } }],
  list_service_types: [{ required: {}, optional: { category: name, query: name } }],
  can_connect: [{ required: connection }],
  inspect_canvas: [{ required: {} }],
  add_node: [
    {
      required: { serviceType: identifier, name, ...point },
      optional: { fields: isRecord, parentId: identifier },
    },
  ],
  connect_nodes: [{ required: connection }],
  delete_node: [{ required: { nodeId: identifier } }],
  delete_connection: [{ required: { connectionId: identifier } }],
  update_node: [{ required: { nodeId: identifier }, optional: { name, ...point } }],
  set_node_config: [
    { required: { nodeId: identifier, fields: isRecord } },
    {
      required: {
        nodeId: identifier,
        key: (value) => value === 'requestRate',
        value: (value) => between(value, 2, 1000) && Number.isInteger(value),
      },
    },
  ],
  set_canvas_region: [{ required: { region: identifier } }],
  add_frame: [
    {
      required: {
        ...frame,
        kind: (value) => value === 'vpc' || value === 'az' || value === 'subnet',
      },
      optional: { parentId: identifier },
    },
  ],
  update_frame: [
    { required: { frameId: identifier }, optional: { ...frame, parentId: nullableId } },
  ],
  delete_frame: [{ required: { frameId: identifier } }],
  add_arrow: [{ required: { sourceId: identifier, targetId: identifier }, optional: { label } }],
  update_arrow: [
    {
      required: { arrowId: identifier },
      optional: { sourceId: identifier, targetId: identifier, label },
    },
  ],
  delete_arrow: [{ required: { arrowId: identifier } }],
  assign_parent: [{ required: { nodeId: identifier, parentId: nullableId } }],
  apply_graph: [
    {
      required: {
        expectedRevision: revision,
        operations: (value) =>
          Array.isArray(value) &&
          value.length >= 1 &&
          value.length <= 100 &&
          value.every(isGraphOperation),
      },
      optional: { dryRun },
    },
  ],
  import_canvas: [
    { required: { expectedRevision: revision, project: isRecord }, optional: { dryRun } },
  ],
  add_annotation: [
    {
      required: {
        text: (value) => text(value, 500),
        ...point,
        width: dimension,
        height: dimension,
        fontSize: (value) => between(value, 8, 72),
        fontWeight: (value) => value === 'normal' || value === 'bold',
      },
    },
  ],
  set_simulation: [
    {
      required: {
        action: (value) =>
          value === 'play' || value === 'pause' || value === 'resume' || value === 'stop',
      },
    },
  ],
};

function matchesShape(
  args: Record<string, unknown>,
  { required, optional = {} }: InputShape,
): boolean {
  return (
    Object.entries(required).every(
      ([key, validate]) => Object.hasOwn(args, key) && validate(args[key]),
    ) &&
    Object.entries(args).every(
      ([key, value]) =>
        Object.hasOwn(required, key) || (Object.hasOwn(optional, key) && optional[key](value)),
    )
  );
}

function isGraphOperation(operation: unknown): boolean {
  if (!isRecord(operation) || Object.keys(operation).length !== 2) return false;
  const { type, args } = operation;
  if (typeof type !== 'string' || !Object.hasOwn(inputShapes, type) || !isRecord(args))
    return false;
  const tool = type as CanvasTool;
  if (
    isCanvasRead(tool) ||
    tool === 'apply_graph' ||
    tool === 'import_canvas' ||
    tool === 'set_simulation'
  )
    return false;
  const { ref, ...payload } = args;
  if (
    Object.hasOwn(args, 'ref') &&
    (typeof ref !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(ref) ||
      !['add_node', 'add_frame', 'add_arrow', 'add_annotation', 'connect_nodes'].includes(tool))
  )
    return false;
  return inputShapes[tool].some((shape) => matchesShape(payload, shape));
}

export function isCanvasReadRequest(request: CanvasRequest): boolean {
  return (
    isCanvasRead(request.tool) ||
    ((request.tool === 'apply_graph' || request.tool === 'import_canvas') &&
      request.args.dryRun === true)
  );
}

export function readCanvasRequest(message: Record<string, unknown>): CanvasRequest | undefined {
  const { requestId, canvasId, tool, args } = message;
  if (
    !identifier(requestId) ||
    !identifier(canvasId) ||
    typeof tool !== 'string' ||
    !Object.hasOwn(inputShapes, tool) ||
    !isRecord(args)
  )
    return undefined;

  if (!inputShapes[tool as CanvasTool].some((shape) => matchesShape(args, shape))) return undefined;
  return { requestId, canvasId, tool, args } as CanvasRequest;
}

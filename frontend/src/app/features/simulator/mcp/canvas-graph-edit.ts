import type {
  Annotation,
  ArchitectureConnection,
  ArchitectureNode,
  AwsServiceDefinition,
} from '../../../core/models/architecture.model';
import type { ArchitectureFactoryService } from '../../../core/services/architecture-factory.service';
import type { ValidationRuleService } from '../../../core/services/validation-rule.service';
import type { CanvasNetwork } from '../../../core/models/canvas-network.model';
import { newId } from '../../../core/utils/graph-clone';
import {
  editCanvasNetwork,
  pruneCanvasNetworkNodes,
  type NetworkOperation,
} from '../../../core/utils/canvas-network';
import type {
  CanvasToolInput,
  GraphOperation,
  GraphRequest,
  GraphTool,
} from './canvas-mcp-contract';
import { patchMcpNodeConfig, resolveServiceType } from './canvas-mcp-domain';

export interface EditableCanvasGraph {
  nodes: ArchitectureNode[];
  connections: ArchitectureConnection[];
  annotations: Annotation[];
  network: CanvasNetwork;
  region: string;
}

export interface CanvasEditDependencies {
  factory: ArchitectureFactoryService;
  validation: ValidationRuleService;
  catalog: AwsServiceDefinition[];
  regions: readonly { code: string }[];
}

export interface CanvasEdit {
  graph: EditableCanvasGraph;
  targetId: string;
  description: string;
  data: Record<string, unknown>;
  createdIds?: string[];
  removedIds?: string[];
  updatedIds?: string[];
}

export function checkCanvasConnection(
  graph: Pick<EditableCanvasGraph, 'nodes' | 'connections'>,
  args: CanvasToolInput['connect_nodes'],
  validation: ValidationRuleService,
) {
  const source = graph.nodes.find((node) => node.id === args.sourceNodeId);
  const target = graph.nodes.find((node) => node.id === args.targetNodeId);
  const output = source?.ports.find(
    (port) => port.id === args.sourcePortId && port.direction === 'output',
  );
  const input = target?.ports.find(
    (port) => port.id === args.targetPortId && port.direction === 'input',
  );
  if (!source || !target || !output || !input) {
    return {
      allowed: false as const,
      message: 'Choose existing output and input ports from get_canvas_state.',
    };
  }

  const result = validation.validate(source, output, target, input, graph.connections);
  if (!result.allowed) {
    const guidance =
      source.type === 'vpc' && target.type === 'vpc'
        ? 'Use add_arrow for visual peering between VPCs.'
        : 'Use list_service_types for port and target guidance.';
    return {
      allowed: false as const,
      message: `${result.message.replace(' Check the architecture rules in aws-services.json.', '')} ${guidance}`,
    };
  }
  return {
    allowed: true as const,
    message: result.message,
    connectionType: result.connectionType ?? output.type,
  };
}

function requireItem<T extends { id: string }>(items: T[], id: string, label: string): T {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`${label} ${id} is not on this canvas.`);
  return item;
}

export function stageCanvasEdit(
  graph: EditableCanvasGraph,
  operation: PickGraphOperation,
  { factory, validation, catalog, regions }: CanvasEditDependencies,
  previewId?: () => string,
): CanvasEdit {
  switch (operation.tool) {
    case 'delete_node': {
      const node = requireItem(graph.nodes, operation.args.nodeId, 'Node');
      const nodes = graph.nodes.filter((candidate) => candidate.id !== node.id);
      const incident = (connection: ArchitectureConnection) =>
        connection.sourceNodeId === node.id || connection.targetNodeId === node.id;
      const connectionIds = graph.connections.filter(incident).map((connection) => connection.id);
      const connections = graph.connections.filter((connection) => !incident(connection));
      const network = pruneCanvasNetworkNodes(graph.network, [node.id]);
      const liveArrowIds = new Set(network.arrows.map((arrow) => arrow.id));
      const arrowIds = graph.network.arrows
        .filter((arrow) => !liveArrowIds.has(arrow.id))
        .map((arrow) => arrow.id);
      return {
        graph: { ...graph, nodes, connections, network },
        data: { nodeId: node.id, connectionIds, ...(arrowIds.length ? { arrowIds } : {}) },
        targetId: node.id,
        description: `Deleted ${node.name} and ${connectionIds.length} connection(s).`,
        removedIds: [node.id, ...connectionIds, ...arrowIds],
      };
    }
    case 'delete_connection': {
      const connection = requireItem(graph.connections, operation.args.connectionId, 'Connection');
      return {
        graph: {
          ...graph,
          connections: graph.connections.filter((item) => item.id !== connection.id),
        },
        data: { connectionId: connection.id },
        targetId: connection.id,
        description: 'Deleted a connection.',
        removedIds: [connection.id],
      };
    }
    case 'add_node': {
      const { serviceType, name, x, y, fields, parentId } = operation.args;
      const resolved = resolveServiceType(catalog, serviceType);
      if ('error' in resolved) throw new Error(resolved.error);
      let node = factory.createNode(resolved.service.type, x, y);
      node = {
        ...node,
        id: previewId?.() ?? node.id,
        name,
        config: { ...node.config, ...resolved.defaults },
      };
      if (fields) {
        for (const [key, value] of Object.entries(resolved.defaults)) {
          if (Object.hasOwn(fields, key) && fields[key] !== value) {
            throw new Error(
              `${serviceType} requires ${key}=${String(value)}. Use ${resolved.service.type} for other variants.`,
            );
          }
        }
        const patched = patchMcpNodeConfig(node, fields);
        if ('error' in patched) throw new Error(patched.error);
        node = patched.node;
      }
      const nodes = [...graph.nodes, node];
      const network = parentId
        ? editCanvasNetwork(
            graph.network,
            nodes,
            { type: 'assign_parent', args: { nodeId: node.id, parentId } },
            newId,
          ).network
        : graph.network;
      return {
        graph: { ...graph, nodes, network },
        data: { node },
        targetId: node.id,
        description: `Added ${node.name}.`,
        createdIds: [node.id],
      };
    }
    case 'update_node': {
      const { nodeId, ...fields } = operation.args;
      if (!Object.keys(fields).length) throw new Error('Provide a name or position to update.');
      const original = requireItem(graph.nodes, nodeId, 'Node');
      const node = { ...original, ...fields };
      return {
        graph: { ...graph, nodes: graph.nodes.map((item) => (item.id === nodeId ? node : item)) },
        data: { node },
        targetId: nodeId,
        description: `Updated ${node.name}.`,
        updatedIds: [nodeId],
      };
    }
    case 'connect_nodes': {
      const checked = checkCanvasConnection(graph, operation.args, validation);
      if (!checked.allowed) throw new Error(checked.message);
      const args = operation.args;
      const created = factory.createConnection(
        args.sourceNodeId,
        args.sourcePortId,
        args.targetNodeId,
        args.targetPortId,
        checked.connectionType,
        checked.message,
      );
      const connection = previewId ? { ...created, id: previewId() } : created;
      const source = requireItem(graph.nodes, args.sourceNodeId, 'Node');
      const target = requireItem(graph.nodes, args.targetNodeId, 'Node');
      return {
        graph: { ...graph, connections: [...graph.connections, connection] },
        data: { connection },
        targetId: connection.id,
        description: `Connected ${source.name} to ${target.name}.`,
        createdIds: [connection.id],
      };
    }
    case 'set_node_config': {
      const { nodeId } = operation.args;
      const node = requireItem(graph.nodes, nodeId, 'Node');
      const fields =
        'fields' in operation.args
          ? operation.args.fields
          : { [operation.args.key]: operation.args.value };
      const patched = patchMcpNodeConfig(node, fields);
      if ('error' in patched) throw new Error(patched.error);
      return {
        graph: {
          ...graph,
          nodes: graph.nodes.map((item) => (item.id === nodeId ? patched.node : item)),
        },
        data: 'fields' in operation.args ? { nodeId, fields: patched.fields } : operation.args,
        targetId: nodeId,
        description:
          'fields' in operation.args
            ? `Configured ${node.name}.`
            : `${node.name} now sends ${operation.args.value} RPS.`,
        updatedIds: [nodeId],
      };
    }
    case 'add_annotation': {
      const annotation: Annotation = { id: (previewId ?? newId)(), ...operation.args };
      return {
        graph: { ...graph, annotations: [...graph.annotations, annotation] },
        data: { annotation },
        targetId: annotation.id,
        description: 'Added a note.',
        createdIds: [annotation.id],
      };
    }
    case 'set_canvas_region': {
      const { region } = operation.args;
      if (!regions.some((item) => item.code === region))
        throw new Error(`Region ${region} is unavailable in the region selector.`);
      return {
        graph: { ...graph, region },
        data: { region },
        targetId: region,
        description: `Selected region ${region}.`,
      };
    }
    default:
      return stageNetworkEdit(
        graph,
        { type: operation.tool, args: operation.args } as NetworkOperation,
        previewId ?? newId,
      );
  }
}

type PickGraphOperation = {
  [Tool in GraphTool]: Pick<Extract<GraphRequest, { tool: Tool }>, 'tool' | 'args'>;
}[GraphTool];

function stageNetworkEdit(
  graph: EditableCanvasGraph,
  operation: NetworkOperation,
  generateId: () => string,
): CanvasEdit {
  const { network, nodes, id } = editCanvasNetwork(
    graph.network,
    graph.nodes,
    operation,
    generateId,
  );
  const previous = new Map(
    [...graph.network.frames, ...graph.network.arrows].map((item) => [item.id, item]),
  );
  const next = new Map([...network.frames, ...network.arrows].map((item) => [item.id, item]));
  const updatedIds = [...next.values()]
    .filter((item) => {
      const previousItem = previous.get(item.id);
      if (!previousItem || previousItem === item) return false;
      if ('kind' in item && 'kind' in previousItem) {
        return (
          item.x !== previousItem.x ||
          item.y !== previousItem.y ||
          item.name !== previousItem.name ||
          item.width !== previousItem.width ||
          item.height !== previousItem.height ||
          item.parentId !== previousItem.parentId
        );
      }
      if (!('kind' in item) && !('kind' in previousItem)) {
        return (
          item.sourceId !== previousItem.sourceId ||
          item.targetId !== previousItem.targetId ||
          item.label !== previousItem.label
        );
      }
      return true;
    })
    .map((item) => item.id);
  for (const [index, node] of nodes.entries()) {
    if (
      node !== graph.nodes[index] ||
      network.nodeParents[node.id] !== graph.network.nodeParents[node.id]
    ) {
      updatedIds.push(node.id);
    }
  }
  return {
    graph: { ...graph, network, nodes },
    data: { id },
    targetId: id,
    description: {
      add_frame: 'Added a network frame.',
      update_frame: 'Updated a network frame.',
      delete_frame: 'Removed a network frame.',
      add_arrow: 'Added a visual link.',
      update_arrow: 'Updated a visual link.',
      delete_arrow: 'Removed a visual link.',
      assign_parent: 'Updated frame membership.',
    }[operation.type],
    createdIds: [...next.keys()].filter((key) => !previous.has(key)),
    removedIds: [...previous.keys()].filter((key) => !next.has(key)),
    updatedIds,
  };
}

const referenceFields = new Set([
  'nodeId',
  'frameId',
  'arrowId',
  'parentId',
  'connectionId',
  'sourceId',
  'targetId',
  'sourceNodeId',
  'targetNodeId',
]);
const batchPhase: Record<GraphTool, number> = {
  delete_connection: 0,
  delete_arrow: 0,
  delete_node: 1,
  delete_frame: 1,
  add_frame: 2,
  add_node: 3,
  add_annotation: 3,
  update_node: 4,
  update_frame: 4,
  set_node_config: 4,
  assign_parent: 4,
  set_canvas_region: 4,
  connect_nodes: 5,
  add_arrow: 5,
  update_arrow: 6,
};

function previewIds(graph: EditableCanvasGraph): () => string {
  const used = new Set(
    [
      ...graph.nodes,
      ...graph.connections,
      ...graph.annotations,
      ...graph.network.frames,
      ...graph.network.arrows,
    ].map(({ id }) => id),
  );
  let counter = 0;
  return () => {
    let id: string;
    do {
      // Match the normal UUID width so previewed and applied batches use the same byte budget.
      id = `preview:${String(++counter).padStart(28, '0')}`;
    } while (used.has(id));
    return id;
  };
}

export function stageCanvasBatch(
  original: EditableCanvasGraph,
  operations: GraphOperation[],
  dependencies: CanvasEditDependencies,
  dryRun = false,
) {
  let graph = original;
  const refs = new Map<string, string>();
  const created = new Set<string>();
  const removed = new Set<string>();
  const updated = new Set<string>();
  const ordered = [...operations].sort(
    (first, second) => batchPhase[first.type] - batchPhase[second.type],
  );
  const previewId = dryRun ? previewIds(original) : undefined;

  for (const { type, args } of ordered) {
    const { ref, ...payload } = args;
    const resolved = Object.fromEntries(
      Object.entries(payload).map(([key, value]) => {
        if (!referenceFields.has(key) || typeof value !== 'string' || !value.startsWith('$'))
          return [key, value];
        const id = refs.get(value.slice(1));
        if (!id)
          throw new Error(
            `Unknown temporary reference ${value}. Define it on an earlier creation.`,
          );
        return [key, id];
      }),
    );
    if (typeof ref === 'string' && refs.has(ref))
      throw new Error(`Duplicate temporary reference ${ref}.`);
    const edit = stageCanvasEdit(
      graph,
      { tool: type, args: resolved } as PickGraphOperation,
      dependencies,
      previewId,
    );
    graph = edit.graph;
    for (const id of edit.createdIds ?? []) created.add(id);
    for (const id of edit.removedIds ?? []) {
      removed.add(id);
      updated.delete(id);
    }
    for (const id of edit.updatedIds ?? []) if (!created.has(id)) updated.add(id);
    if (typeof ref === 'string') refs.set(ref, edit.targetId);
  }

  return {
    graph,
    createdIds: [...created],
    removedIds: [...removed],
    updatedIds: [...updated],
    refs: Object.fromEntries(refs),
  };
}

import type { ArchitectureNode } from '../models/architecture.model';
import type { CanvasNetwork, NetworkArrow, NetworkFrame } from '../models/canvas-network.model';

type FramePatch = Partial<Omit<NetworkFrame, 'id' | 'kind' | 'parentId'>> & {
  parentId?: string | null;
};

export type NetworkOperation =
  | { type: 'add_frame'; args: Omit<NetworkFrame, 'id'> }
  | { type: 'update_frame'; args: FramePatch & { frameId: string } }
  | { type: 'delete_frame'; args: { frameId: string } }
  | { type: 'add_arrow'; args: Omit<NetworkArrow, 'id'> }
  | { type: 'update_arrow'; args: Partial<Omit<NetworkArrow, 'id'>> & { arrowId: string } }
  | { type: 'delete_arrow'; args: { arrowId: string } }
  | { type: 'assign_parent'; args: { nodeId: string; parentId: string | null } };

export function emptyCanvasNetwork(): CanvasNetwork {
  return { frames: [], arrows: [], nodeParents: {} };
}

export function hasCanvasNetwork(network: CanvasNetwork): boolean {
  return Boolean(
    network.frames.length || network.arrows.length || Object.keys(network.nodeParents).length,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && /\S/.test(value);
}

function validPosition(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000;
}

function validDimension(value: unknown): boolean {
  return typeof value === 'number' && value > 0 && value <= 2_000;
}

function isFrame(value: unknown): value is NetworkFrame {
  return (
    isRecord(value) &&
    validId(value['id']) &&
    (value['kind'] === 'vpc' || value['kind'] === 'az' || value['kind'] === 'subnet') &&
    typeof value['name'] === 'string' &&
    value['name'].length <= 100 &&
    /\S/.test(value['name']) &&
    validPosition(value['x']) &&
    validPosition(value['y']) &&
    validDimension(value['width']) &&
    validDimension(value['height']) &&
    (value['parentId'] === undefined || validId(value['parentId']))
  );
}

function isArrow(value: unknown): value is NetworkArrow {
  return (
    isRecord(value) &&
    validId(value['id']) &&
    validId(value['sourceId']) &&
    validId(value['targetId']) &&
    (value['label'] === undefined ||
      (typeof value['label'] === 'string' && value['label'].length <= 100))
  );
}

function acceptsFrame(parent: NetworkFrame, child: NetworkFrame): boolean {
  return (
    (parent.kind === 'vpc' && child.kind !== 'vpc') ||
    (parent.kind === 'az' && child.kind === 'subnet')
  );
}

export function validateCanvasNetwork(
  value: unknown,
  nodes: readonly Pick<ArchitectureNode, 'id'>[],
): CanvasNetwork {
  if (value === undefined) return emptyCanvasNetwork();
  if (
    !isRecord(value) ||
    !Array.isArray(value['frames']) ||
    !Array.isArray(value['arrows']) ||
    !isRecord(value['nodeParents'])
  ) {
    throw new Error('Network data must contain frames, arrows and nodeParents.');
  }

  const frames = new Map<string, NetworkFrame>();
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const frame of value['frames']) {
    if (!isFrame(frame))
      throw new Error('Invalid network frame. Check its name, kind, position and size.');
    if (frames.has(frame.id) || nodeIds.has(frame.id))
      throw new Error(`Duplicate diagram ID: ${frame.id}.`);
    const { id, kind, name, x, y, width, height, parentId } = frame;
    frames.set(id, {
      id,
      kind,
      name,
      x,
      y,
      width,
      height,
      ...(parentId !== undefined && { parentId }),
    });
  }
  for (const frame of frames.values()) {
    if (frame.parentId === undefined) continue;
    const parent = frames.get(frame.parentId);
    // Each nesting level has a distinct kind, which precludes cycles.
    if (!parent || !acceptsFrame(parent, frame))
      throw new Error(`Invalid parent for the ${frame.name} frame.`);
  }

  const arrowIds = new Set<string>();
  const targetsBySource = new Map<string, Set<string>>();
  const arrows: NetworkArrow[] = [];
  for (const arrow of value['arrows']) {
    if (!isArrow(arrow)) throw new Error('Invalid diagram link. Check the endpoints and label.');
    if (arrowIds.has(arrow.id) || frames.has(arrow.id) || nodeIds.has(arrow.id))
      throw new Error(`Duplicate diagram ID: ${arrow.id}.`);
    const endpoints = [arrow.sourceId, arrow.targetId];
    if (
      arrow.sourceId === arrow.targetId ||
      endpoints.some((id) => !frames.has(id) && !nodeIds.has(id))
    ) {
      throw new Error('A diagram link requires two different existing nodes or frames.');
    }
    const targets = targetsBySource.get(arrow.sourceId) ?? new Set<string>();
    if (targets.has(arrow.targetId)) throw new Error('That diagram link already exists.');
    targets.add(arrow.targetId);
    targetsBySource.set(arrow.sourceId, targets);
    arrowIds.add(arrow.id);
    const { id, sourceId, targetId, label } = arrow;
    arrows.push({ id, sourceId, targetId, ...(label !== undefined && { label }) });
  }

  const assignments: [string, string][] = [];
  for (const [nodeId, frameId] of Object.entries(value['nodeParents'])) {
    if (!nodeIds.has(nodeId) || !validId(frameId) || !frames.has(frameId))
      throw new Error('Frame membership refers to a missing node or frame.');
    assignments.push([nodeId, frameId]);
  }

  return {
    frames: Array.from(frames.values()),
    arrows,
    nodeParents: Object.fromEntries(assignments),
  };
}

export function pruneCanvasNetworkNodes(
  network: CanvasNetwork,
  deletedNodeIds: readonly string[],
): CanvasNetwork {
  if (!hasCanvasNetwork(network) || !deletedNodeIds.length) return network;
  const deleted = new Set(deletedNodeIds);
  return {
    frames: network.frames,
    arrows: network.arrows.filter(
      (arrow) => !deleted.has(arrow.sourceId) && !deleted.has(arrow.targetId),
    ),
    nodeParents: Object.fromEntries(
      Object.entries(network.nodeParents).filter(([nodeId]) => !deleted.has(nodeId)),
    ),
  };
}

function descendants(frames: NetworkFrame[], frameId: string): Set<string> {
  const members = new Set<string>([frameId]);
  const pending = [frameId];
  while (pending.length) {
    const parentId = pending.pop();
    for (const frame of frames) {
      if (frame.parentId !== parentId || members.has(frame.id)) continue;
      members.add(frame.id);
      pending.push(frame.id);
    }
  }
  return members;
}

function requireFrame(network: CanvasNetwork, frameId: string): NetworkFrame {
  const frame = network.frames.find((candidate) => candidate.id === frameId);
  if (!frame) throw new Error('The network frame is not on this canvas.');
  return frame;
}

function requireArrow(network: CanvasNetwork, arrowId: string): NetworkArrow {
  const arrow = network.arrows.find((candidate) => candidate.id === arrowId);
  if (!arrow) throw new Error('The diagram link is not on this canvas.');
  return arrow;
}

function reparentFrame(frame: NetworkFrame, parentId?: string): NetworkFrame {
  return { ...frame, parentId };
}

export function editCanvasNetwork(
  currentNetwork: CanvasNetwork,
  currentNodes: ArchitectureNode[],
  operation: NetworkOperation,
  newId: () => string,
): { network: CanvasNetwork; nodes: ArchitectureNode[]; id: string } {
  let nodes = currentNodes;
  let network = currentNetwork;
  let id: string;

  switch (operation.type) {
    case 'add_frame': {
      id = newId();
      const frame = { ...operation.args, id };
      network = { ...currentNetwork, frames: [...currentNetwork.frames, frame] };
      break;
    }
    case 'update_frame': {
      const { frameId, parentId, ...patch } = operation.args;
      const frame = requireFrame(network, frameId);
      id = frameId;
      const updated = reparentFrame(
        { ...frame, ...patch },
        parentId === undefined ? frame.parentId : (parentId ?? undefined),
      );
      const dx = updated.x - frame.x;
      const dy = updated.y - frame.y;
      const members = descendants(network.frames, id);
      const frames = network.frames.map((current) => {
        if (current.id === id) return updated;
        return members.has(current.id)
          ? { ...current, x: current.x + dx, y: current.y + dy }
          : current;
      });
      if (dx || dy) {
        nodes = nodes.map((node) =>
          members.has(network.nodeParents[node.id])
            ? { ...node, x: node.x + dx, y: node.y + dy }
            : node,
        );
        if (
          nodes.some(
            (node, index) =>
              node !== currentNodes[index] && (!validPosition(node.x) || !validPosition(node.y)),
          )
        ) {
          throw new Error(
            'Moving the frame would push a service outside the allowed canvas coordinates.',
          );
        }
      }
      network = { ...network, frames };
      break;
    }
    case 'delete_frame': {
      id = operation.args.frameId;
      const frame = requireFrame(network, id);
      const frames = network.frames
        .filter((current) => current.id !== id)
        .map((current) =>
          current.parentId === id ? reparentFrame(current, frame.parentId) : current,
        );
      const nodeParents: Record<string, string> = { ...network.nodeParents };
      for (const [nodeId, parentId] of Object.entries(nodeParents)) {
        if (parentId !== id) continue;
        if (frame.parentId) nodeParents[nodeId] = frame.parentId;
        else delete nodeParents[nodeId];
      }
      network = {
        frames,
        nodeParents,
        arrows: network.arrows.filter((arrow) => arrow.sourceId !== id && arrow.targetId !== id),
      };
      break;
    }
    case 'add_arrow': {
      id = newId();
      const arrow = { ...operation.args, id };
      network = { ...network, arrows: [...network.arrows, arrow] };
      break;
    }
    case 'update_arrow': {
      const { arrowId, ...patch } = operation.args;
      const arrow = requireArrow(network, arrowId);
      id = arrowId;
      network = {
        ...network,
        arrows: network.arrows.map((current) =>
          current.id === id ? { ...arrow, ...patch } : current,
        ),
      };
      break;
    }
    case 'delete_arrow': {
      id = operation.args.arrowId;
      requireArrow(network, id);
      network = { ...network, arrows: network.arrows.filter((arrow) => arrow.id !== id) };
      break;
    }
    case 'assign_parent': {
      const { nodeId, parentId } = operation.args;
      if (!nodes.some((node) => node.id === nodeId))
        throw new Error('The service is not on this canvas.');
      id = nodeId;
      const nodeParents =
        parentId === null
          ? Object.fromEntries(Object.entries(network.nodeParents).filter(([id]) => id !== nodeId))
          : { ...network.nodeParents, [nodeId]: parentId };
      network = { ...network, nodeParents };
      break;
    }
  }

  return { network: validateCanvasNetwork(network, nodes), nodes, id };
}

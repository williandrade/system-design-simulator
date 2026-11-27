import type {
  ArchitectureConnection,
  ArchitectureNode,
} from '../../../core/models/architecture.model';

export interface CanvasIssue {
  code: 'ORPHAN_NODE' | 'PARALLEL_PATHS';
  severity: 'warning';
  message: string;
  nodeIds: string[];
  connectionIds: string[];
}

function trafficWeight(connection: ArchitectureConnection): number {
  return connection.trafficWeight ?? 100;
}

interface RouteStep {
  id: string;
  branch: ArchitectureConnection;
  incoming: ArchitectureConnection;
}

function findConvergence(
  source: ArchitectureNode,
  branches: ArchitectureConnection[],
  outgoing: ReadonlyMap<string, ArchitectureConnection[]>,
): RouteStep[] | undefined {
  const queue = branches.map((branch) => ({ id: branch.targetNodeId, branch, incoming: branch }));
  const arrivals = new Map<string, RouteStep[]>();
  for (let index = 0; index < queue.length; index += 1) {
    const step = queue[index];
    if (step.id === source.id) continue;
    const seen = arrivals.get(step.id) ?? [];
    if (seen.some(({ branch }) => branch.id === step.branch.id)) continue;
    seen.push(step);
    if (seen.reduce((total, { branch }) => total + trafficWeight(branch), 0) > 100) return seen;
    arrivals.set(step.id, seen);
    for (const connection of outgoing.get(step.id) ?? []) {
      queue.push({ id: connection.targetNodeId, branch: step.branch, incoming: connection });
    }
  }
  return undefined;
}

export function inspectCanvas(
  nodes: readonly ArchitectureNode[],
  connections: readonly ArchitectureConnection[],
): { issues: CanvasIssue[] } {
  const issues: CanvasIssue[] = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incident = new Set<string>();
  const outgoing = new Map<string, ArchitectureConnection[]>();
  for (const connection of connections) {
    const { sourceNodeId, targetNodeId } = connection;
    if (!byId.has(sourceNodeId) || !byId.has(targetNodeId)) continue;
    incident.add(sourceNodeId);
    incident.add(targetNodeId);
    if (trafficWeight(connection) <= 0) continue;
    const edges = outgoing.get(sourceNodeId) ?? [];
    edges.push(connection);
    outgoing.set(sourceNodeId, edges);
  }
  const orphanIds = nodes.filter(({ id }) => !incident.has(id)).map(({ id }) => id);
  if (orphanIds.length) {
    issues.push({
      code: 'ORPHAN_NODE',
      severity: 'warning',
      message: `${orphanIds.length} service(s) have no simulation connections.`,
      nodeIds: orphanIds,
      connectionIds: [],
    });
  }

  for (const node of nodes) {
    // Use the actual HTTP output, not the rule's connection type. API Gateway can
    // connect that port to Lambda as "event" and to a load balancer as "http".
    for (const port of node.ports) {
      if (port.direction !== 'output' || port.type !== 'http') continue;
      const branches = (outgoing.get(node.id) ?? []).filter(
        ({ sourcePortId }) => sourcePortId === port.id,
      );
      if (
        branches.length < 2 ||
        branches.reduce((total, item) => total + trafficWeight(item), 0) <= 100
      )
        continue;
      const convergence = findConvergence(node, branches, outgoing);
      if (!convergence) continue;
      const destination = convergence[0].id;
      issues.push({
        code: 'PARALLEL_PATHS',
        severity: 'warning',
        message: `Routes from ${node.name} converge at ${byId.get(destination)?.name ?? destination}. Verify the routes and traffic weights before simulating.`,
        nodeIds: [
          ...new Set([
            node.id,
            destination,
            ...convergence.map(({ branch }) => branch.targetNodeId),
          ]),
        ],
        connectionIds: [
          ...new Set(convergence.flatMap(({ branch, incoming }) => [branch.id, incoming.id])),
        ],
      });
    }
  }
  return { issues };
}

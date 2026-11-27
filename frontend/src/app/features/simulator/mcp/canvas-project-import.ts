import type {
  Annotation,
  ArchitectureConnection,
  ArchitectureNode,
  Currency,
} from '../../../core/models/architecture.model';
import { hasValidGenericServiceMetadata } from '../../../core/utils/generic-service-metadata';
import { validateCanvasNetwork } from '../../../core/utils/canvas-network';
import type { CanvasEditDependencies, EditableCanvasGraph } from './canvas-graph-edit';
import { getCatalogConfigFields } from './canvas-mcp-config';
import { isRecord } from './canvas-mcp-contract';

const currencies = new Set(['USD', 'EUR', 'GBP', 'INR', 'JPY']);
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 128;

function isConfigScalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || finite(value);
}

function validateImportedConfig(node: ArchitectureNode, config: Record<string, unknown>): void {
  const types = new Map(Object.entries(node.config).map(([key, value]) => [key, typeof value]));
  const options = new Map<string, Set<string | number | boolean>>();
  for (const field of getCatalogConfigFields(node.type, node.config)) {
    if (field.type === 'number' || field.type === 'boolean') types.set(field.key, field.type);
    else if (field.type === 'enum') {
      if (field.editable === false) continue;
      types.delete(field.key);
      const choices = options.get(field.key) ?? new Set();
      for (const option of field.options ?? []) choices.add(option.value);
      if (
        typeof field.value === 'string' ||
        typeof field.value === 'number' ||
        typeof field.value === 'boolean'
      ) {
        choices.add(field.value);
      }
      options.set(field.key, choices);
    }
  }
  for (const [key, value] of Object.entries(config)) {
    if (
      key === '_syncSnapshot' &&
      node.type === 'client' &&
      isRecord(value) &&
      Object.values(value).every(
        (entry) => finite(entry) || (isRecord(entry) && Object.values(entry).every(isConfigScalar)),
      )
    ) {
      continue;
    }
    const expected = types.get(key);
    const choices = options.get(key);
    const equivalent =
      typeof value === 'number'
        ? String(value)
        : typeof value === 'string' && value.trim() && String(Number(value)) === value
          ? Number(value)
          : undefined;
    if (
      !isConfigScalar(value) ||
      (key === 'requestRegion' &&
        node.type === 'client' &&
        value !== null &&
        typeof value !== 'string') ||
      (value !== null && expected && typeof value !== expected) ||
      (value !== null &&
        choices?.size &&
        !choices.has(value as string | number | boolean) &&
        (equivalent === undefined || !choices.has(equivalent)))
    ) {
      throw new Error(`Invalid configuration field ${key} on node ${node.id}.`);
    }
  }
}

export function canvasGraphIds(graph: EditableCanvasGraph): string[] {
  return [
    ...graph.nodes,
    ...graph.connections,
    ...graph.annotations,
    ...graph.network.frames,
    ...graph.network.arrows,
  ].map((item) => item.id);
}

export function stageProjectImport(
  project: Record<string, unknown>,
  { factory, catalog, regions }: CanvasEditDependencies,
): { graph: EditableCanvasGraph; name: string; currency: Currency } {
  const {
    name: title,
    nodes,
    connections,
    annotations = [],
    region = 'us-east-1',
    currency = 'USD',
  } = project;
  if (
    typeof title !== 'string' ||
    typeof currency !== 'string' ||
    !currencies.has(currency) ||
    typeof region !== 'string' ||
    !regions.some((item) => item.code === region)
  ) {
    throw new Error('Use a valid exported project name, currency and region.');
  }
  if (!Array.isArray(nodes) || !Array.isArray(connections) || !Array.isArray(annotations)) {
    throw new Error('An exported project needs node, connection, and optional annotation arrays.');
  }

  const definitions = new Map<string, (typeof catalog)[number]>(
    catalog.map((entry) => [entry.type, entry]),
  );
  const nodeMap = new Map<string, ArchitectureNode>();
  const importedNodes = nodes.map((input): ArchitectureNode => {
    if (
      !isRecord(input) ||
      !validId(input['id']) ||
      typeof input['name'] !== 'string' ||
      !finite(input['x']) ||
      !finite(input['y']) ||
      typeof input['type'] !== 'string' ||
      !isRecord(input['config'])
    ) {
      throw new Error(
        'A project node is missing a valid ID, type, name, position or configuration.',
      );
    }
    const id = input['id'];
    const definition = definitions.get(input['type']);
    if (!definition) throw new Error(`Unknown project node type ${input['type']}.`);
    if (nodeMap.has(id)) throw new Error(`Duplicate node ID ${id}.`);

    const node = factory.createNode(definition.type, input['x'], input['y']);
    node.id = id;
    node.name = input['name'];
    if (node.type !== 'generic') validateImportedConfig(node, input['config']);
    node.config = { ...node.config, ...input['config'] };
    if (node.type === 'client' && !(Number(node.config['requestRate']) >= 2))
      node.config['requestRate'] = 100;
    if (node.type === 'generic') {
      if (!hasValidGenericServiceMetadata(input as unknown as ArchitectureNode)) {
        throw new Error(`Invalid generic metadata on node ${id}.`);
      }
      node.genericMetadata =
        (input as unknown as ArchitectureNode).genericMetadata ?? node.genericMetadata;
    }
    const normalized = factory.withFixedGenericConfig(node);
    nodeMap.set(id, normalized);
    return normalized;
  });

  const importedConnections = connections.map((input): ArchitectureConnection => {
    if (
      !isRecord(input) ||
      !validId(input['id']) ||
      !validId(input['sourceNodeId']) ||
      !validId(input['targetNodeId']) ||
      !validId(input['sourcePortId']) ||
      !validId(input['targetPortId'])
    ) {
      throw new Error('A project connection is missing a valid ID or endpoint.');
    }
    const source = nodeMap.get(input['sourceNodeId']);
    const target = nodeMap.get(input['targetNodeId']);
    const output = source?.ports.find(
      (port) => port.id === input['sourcePortId'] && port.direction === 'output',
    );
    const port = target?.ports.find(
      (candidate) => candidate.id === input['targetPortId'] && candidate.direction === 'input',
    );
    if (!source || !target || !output || !port || source === target) {
      throw new Error(`Connection ${input['id']} has an invalid or missing endpoint.`);
    }
    // Existing projects can contain edges made before current connection rules.
    const type = source.type === 'generic' ? port.type : output.type;
    const storedType = input['type'];
    const allowedType = catalog.some((entry) =>
      entry.ports.some((endpoint) => endpoint.type === storedType),
    );
    const edge = factory.createConnection(
      source.id,
      output.id,
      target.id,
      port.id,
      allowedType ? (storedType as ArchitectureConnection['type']) : type,
    );
    edge.id = input['id'];
    if (typeof input['label'] === 'string') edge.label = input['label'];
    if (typeof input['allowed'] === 'boolean') edge.allowed = input['allowed'];
    const weight = input['trafficWeight'];
    if (weight != null) {
      if (!finite(weight) || weight < 0 || weight > 100) {
        throw new Error(`Connection ${edge.id} requires a traffic weight from 0 to 100.`);
      }
      edge.trafficWeight = weight;
    }
    if (finite(input['animationOffset'])) edge.animationOffset = input['animationOffset'];
    return edge;
  });

  const importedAnnotations = annotations.map((input): Annotation => {
    if (
      !isRecord(input) ||
      !validId(input['id']) ||
      typeof input['text'] !== 'string' ||
      !finite(input['x']) ||
      !finite(input['y']) ||
      !finite(input['width']) ||
      input['width'] <= 0 ||
      !finite(input['height']) ||
      input['height'] <= 0 ||
      !finite(input['fontSize']) ||
      (input['fontWeight'] !== 'normal' && input['fontWeight'] !== 'bold')
    ) {
      throw new Error('A project annotation is missing valid text or geometry.');
    }
    return {
      id: input['id'],
      text: input['text'],
      x: input['x'],
      y: input['y'],
      width: input['width'],
      height: input['height'],
      fontSize: input['fontSize'],
      fontWeight: input['fontWeight'],
    };
  });

  const network = validateCanvasNetwork(project['network'], importedNodes);
  const graph = {
    nodes: importedNodes,
    connections: importedConnections,
    annotations: importedAnnotations,
    network,
    region,
  };
  const ids = canvasGraphIds(graph);
  if (new Set(ids).size !== ids.length) throw new Error('Project item IDs must be unique.');
  return { graph, name: title, currency: currency as Currency };
}

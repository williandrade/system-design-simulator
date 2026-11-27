import { describe, expect, it } from 'vitest';
import type {
  ArchitectureConnection,
  ArchitectureNode,
  AwsServiceType,
} from '../../../core/models/architecture.model';
import { ArchitectureFactoryService } from '../../../core/services/architecture-factory.service';
import { AwsCatalogService } from '../../../core/services/aws-catalog.service';
import { ValidationRuleService } from '../../../core/services/validation-rule.service';
import { emptyCanvasNetwork } from '../../../core/utils/canvas-network';
import {
  checkCanvasConnection,
  stageCanvasBatch,
  stageCanvasEdit,
  type EditableCanvasGraph,
} from './canvas-graph-edit';
import type { GraphOperation } from './canvas-mcp-contract';
import { stageProjectImport } from './canvas-project-import';

const catalog = new AwsCatalogService().services;
const factory = new ArchitectureFactoryService(new AwsCatalogService());
const validation = new ValidationRuleService();
const deps = {
  catalog,
  factory,
  validation,
  regions: [{ code: 'us-east-1' }, { code: 'ap-southeast-2' }],
};

function canvas(
  nodes: ArchitectureNode[] = [],
  connections: ArchitectureConnection[] = [],
): EditableCanvasGraph {
  return {
    nodes,
    connections,
    annotations: [],
    network: emptyCanvasNetwork(),
    region: 'us-east-1',
  };
}

function addNode(serviceType: string, ref: string, x = 0, y = 0): GraphOperation {
  return { type: 'add_node', args: { serviceType, ref, name: ref, x, y } };
}

function connect(
  sourceNodeId: string,
  sourcePortId: string,
  targetNodeId: string,
  targetPortId: string,
): {
  type: 'connect_nodes';
  args: { sourceNodeId: string; sourcePortId: string; targetNodeId: string; targetPortId: string };
} {
  return {
    type: 'connect_nodes',
    args: { sourceNodeId, sourcePortId, targetNodeId, targetPortId },
  };
}

function node(type: AwsServiceType, x = 0, y = 0): ArchitectureNode {
  return factory.createNode(type, x, y);
}

describe('MCP staged graph edits', () => {
  it('reimports display names that the canvas editor can export', () => {
    const nodes = [
      { ...node('client'), name: '' },
      { ...node('lambda'), name: 'named '.repeat(24) },
    ];
    nodes[0].config = { ...nodes[0].config, _syncSnapshot: { [nodes[1].id]: 120 } };
    const imported = stageProjectImport({ name: 'Canvas', nodes, connections: [] }, deps);
    expect(imported.graph.nodes.map(({ name }) => name)).toEqual(nodes.map(({ name }) => name));
    expect(imported.graph.nodes[0].config['_syncSnapshot']).toEqual({ [nodes[1].id]: 120 });
    const cloudFront = node('cloudfront');
    cloudFront.config['region'] = 'ap-southeast-2';
    expect(stageProjectImport({ name: 'Canvas', nodes: [cloudFront], connections: [] }, deps)
      .graph.nodes[0].config['region']).toBe('ap-southeast-2');
  });

  it('rejects invalid runtime configuration and connection weights during import', () => {
    const client = node('client');
    const target = node('apiGateway');
    const edge = factory.createConnection(client.id, 'out-http', target.id, 'in-http', 'http');
    const project = { name: 'Canvas', nodes: [client, target], connections: [edge] };

    expect(() =>
      stageProjectImport(
        {
          ...project,
          nodes: [{ ...client, config: { ...client.config, requestRegion: 3 } }, target],
        },
        deps,
      ),
    ).toThrow('requestRegion');
    expect(() =>
      stageProjectImport(
        {
          ...project,
          connections: [{ ...edge, trafficWeight: 101 }],
        },
        deps,
      ),
    ).toThrow('traffic weight');
    const database = node('dynamoDb');
    expect(() =>
      stageProjectImport(
        {
          ...project,
          nodes: [{ ...database, config: { ...database.config, writesM: '10' } }],
          connections: [],
        },
        deps,
      ),
    ).toThrow('writesM');
    const ecs = node('ecs');
    const ecsProject = { ...project, nodes: [ecs], connections: [] };
    ecs.config['vCPU'] = 'invalid';
    expect(() => stageProjectImport(ecsProject, deps)).toThrow('vCPU');
    ecs.config['vCPU'] = 0.5;
    expect(stageProjectImport(ecsProject, deps).graph.nodes[0].config['vCPU']).toBe(0.5);
  });

  it('atomically replaces two Lambda paths and preserves an unrelated connection', () => {
    const users = node('client');
    const api = node('apiGateway', 160);
    const first = node('lambda', 320, 80);
    const second = node('lambda', 490, 80);
    const destinations = [
      { node: node('rds'), port: 'database' },
      { node: node('elastiCache'), port: 'cache' },
      { node: node('dynamoDb'), port: 'database' },
      { node: node('s3'), port: 'storage' },
      { node: node('sqs'), port: 'queue' },
      { node: node('sns'), port: 'topic' },
    ] as const;
    const stable = factory.createConnection(users.id, 'out-http', api.id, 'in-http', 'http');
    const incident = [
      factory.createConnection(api.id, 'out-http', first.id, 'in-http', 'event'),
      factory.createConnection(api.id, 'out-http', second.id, 'in-http', 'event'),
      ...destinations.map(({ node: target, port }) =>
        factory.createConnection(first.id, `out-${port}`, target.id, `in-${port}`, port),
      ),
      ...destinations
        .slice(0, 3)
        .map(({ node: target, port }) =>
          factory.createConnection(second.id, `out-${port}`, target.id, `in-${port}`, port),
        ),
    ];
    const initial = canvas(
      [users, api, first, second, ...destinations.map((item) => item.node)],
      [stable, ...incident],
    );
    const original = structuredClone(initial);
    const operations: GraphOperation[] = [
      { type: 'delete_node', args: { nodeId: first.id } },
      { type: 'delete_node', args: { nodeId: second.id } },
      // Explicit deletion is applied before node cascades.
      { type: 'delete_connection', args: { connectionId: incident[0].id } },
      // Connections can point at creations in another phase.
      connect(api.id, 'out-http', '$alb', 'in-http'),
      connect('$alb', 'out-http', '$ecs', 'in-http'),
      {
        type: 'set_node_config',
        args: { nodeId: '$ecs', fields: { tasks: 3, vCPU: '1', memoryGB: 2 } },
      },
      addNode('alb', 'alb', first.x, first.y),
      addNode('ecs', 'ecs', second.x, second.y),
      ...destinations.map(({ node: target, port }) =>
        connect('$ecs', `out-${port}`, target.id, `in-${port}`),
      ),
    ];

    const preview = stageCanvasBatch(initial, operations, deps, true);
    const applied = stageCanvasBatch(initial, operations, deps);
    expect(initial).toEqual(original);
    expect(preview.removedIds).toEqual(applied.removedIds);
    expect(preview.createdIds.every((id) => id.startsWith('preview:') && id.length === 36)).toBe(
      true,
    );
    expect(preview.refs).toEqual(stageCanvasBatch(initial, operations, deps, true).refs);
    expect(applied.createdIds).toHaveLength(10);
    expect(applied.removedIds).toHaveLength(13);
    expect(applied.graph.connections).toHaveLength(9);
    expect(applied.graph.connections).toContain(stable);
    expect(applied.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: applied.refs['alb'],
          type: 'elb',
          x: 320,
          config: expect.objectContaining({ lbType: 'alb' }),
        }),
        expect.objectContaining({
          id: applied.refs['ecs'],
          type: 'ecs',
          x: 490,
          config: expect.objectContaining({ tasks: 3, vCPU: '1', memoryGB: 2 }),
        }),
      ]),
    );
    expect(
      incident.every(({ id }) => !applied.graph.connections.some((edge) => edge.id === id)),
    ).toBe(true);
  });

  it('preserves the input state when a later operation fails', () => {
    const originalNode = node('lambda');
    const anotherNode = node('ecs');
    const edge = factory.createConnection(
      originalNode.id,
      'out-http',
      anotherNode.id,
      'in-http',
      'http',
    );
    const initial = canvas([originalNode, anotherNode], [edge]);
    const before = structuredClone(initial);
    expect(() =>
      stageCanvasBatch(
        initial,
        [
          { type: 'delete_node', args: { nodeId: originalNode.id } },
          addNode('ecs', 'newEcs'),
          { type: 'set_canvas_region', args: { region: 'ap-southeast-2' } },
          connect('$newEcs', 'out-http', 'missing', 'in-http'),
        ],
        deps,
      ),
    ).toThrow('Choose existing output and input ports');
    expect(initial).toEqual(before);
  });

  it('reports frame descendants moved, and visual links removed by a node cascade', () => {
    const initialNode = node('ecs', 10, 60);
    const initial = canvas([initialNode]);
    initial.network = {
      frames: [
        { id: 'vpc', kind: 'vpc', name: 'VPC', x: 0, y: 0, width: 500, height: 360 },
        {
          id: 'zone',
          kind: 'az',
          name: 'Zone',
          x: 20,
          y: 20,
          width: 420,
          height: 300,
          parentId: 'vpc',
        },
      ],
      arrows: [{ id: 'diagram', sourceId: 'vpc', targetId: initialNode.id }],
      nodeParents: { [initialNode.id]: 'zone' },
    };
    const shifted = stageCanvasBatch(
      initial,
      [{ type: 'update_frame', args: { frameId: 'vpc', x: 100, y: 54 } }],
      deps,
    );
    expect(shifted.updatedIds).toHaveLength(3);
    expect(shifted.updatedIds).toEqual(expect.arrayContaining(['vpc', 'zone', initialNode.id]));
    expect(shifted.graph.nodes[0]).toMatchObject({ x: 110, y: 114 });
    const deleted = stageCanvasEdit(
      shifted.graph,
      { tool: 'delete_node', args: { nodeId: initialNode.id } },
      deps,
    );
    expect(deleted.removedIds).toEqual([initialNode.id, 'diagram']);
    expect(deleted.data).toEqual({
      nodeId: initialNode.id,
      connectionIds: [],
      arrowIds: ['diagram'],
    });
    expect(deleted.graph.network.arrows).toEqual([]);
  });

  it('checks the same VPC and duplicate-connection rules used for the write', () => {
    const source = node('vpc');
    const otherVpc = node('vpc');
    const lambda = node('lambda');
    const initial = canvas([source, otherVpc, lambda]);
    const invalid = connect(source.id, 'out-network', otherVpc.id, 'in-network');
    expect(checkCanvasConnection(initial, invalid.args, validation)).toMatchObject({
      allowed: false,
      message: expect.stringContaining('add_arrow'),
    });
    const valid = connect(source.id, 'out-network', lambda.id, 'in-network');
    expect(checkCanvasConnection(initial, valid.args, validation)).toMatchObject({
      allowed: true,
      connectionType: 'network',
    });
    const staged = stageCanvasBatch(initial, [valid], deps);
    expect(checkCanvasConnection(staged.graph, valid.args, validation)).toMatchObject({
      allowed: false,
      message: expect.stringContaining('That connection already exists.'),
    });
  });
});

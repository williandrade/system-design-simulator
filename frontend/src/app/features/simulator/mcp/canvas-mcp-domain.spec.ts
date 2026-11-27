import { describe, expect, it } from 'vitest';
import { AwsCatalogService } from '../../../core/services/aws-catalog.service';
import { ArchitectureFactoryService } from '../../../core/services/architecture-factory.service';
import { ValidationRuleService } from '../../../core/services/validation-rule.service';
import type { AwsServiceType } from '../../../core/models/architecture.model';
import {
  getEditableConfigFields,
  inspectCanvas,
  listServiceTypes,
  patchMcpNodeConfig,
  resolveServiceType,
} from './canvas-mcp-domain';

const catalog = new AwsCatalogService();
const factory = new ArchitectureFactoryService(catalog);
const rules = new ValidationRuleService().rules;

function create(type: AwsServiceType) {
  return factory.createNode(type, 0, 0);
}

describe('MCP service discovery', () => {
  it('looks up human names and load-balancer aliases without allocating nodes', () => {
    expect(resolveServiceType(catalog.services, 'Network Load Balancer')).toMatchObject({
      service: { type: 'elb' },
      defaults: { lbType: 'nlb' },
    });
    expect(resolveServiceType(catalog.services, 'api-gateway')).toMatchObject({
      service: { type: 'apiGateway' },
      defaults: {},
    });
    expect(resolveServiceType(catalog.services, 'ApiGatway')).toMatchObject({
      error: expect.stringContaining('Did you mean apiGateway?'),
    });
  });

  it('returns the current ports, target hints and relevant select values', () => {
    expect(
      listServiceTypes(catalog.services, rules, { category: 'Networking', query: 'ALB' }),
    ).toMatchObject({
      services: [
        expect.objectContaining({
          type: 'elb',
          aliases: expect.arrayContaining(['alb']),
          ports: expect.arrayContaining([expect.objectContaining({ id: 'in-http' })]),
          fields: expect.arrayContaining([
            expect.objectContaining({ key: 'lbType', type: 'enum' }),
          ]),
        }),
      ],
    });
    const { services } = listServiceTypes(catalog.services, rules, {});
    expect(services.map(({ type }) => type)).toEqual(
      expect.arrayContaining(['generic', 'natGateway', 'transitGateway', 'privateLink']),
    );
    expect(services.find(({ type }) => type === 'vpc')?.allowedTargets).not.toContain('vpc');
  });
});

describe('MCP node configuration', () => {
  it('edits Tasks, vCPU and memory in the units consumed by ECS', () => {
    const node = create('ecs');
    const fields = { tasks: 3, vCPU: '1', memoryGB: 2 };
    const result = patchMcpNodeConfig(node, fields);
    expect(result).toMatchObject({ node: { config: fields }, fields });
    expect(patchMcpNodeConfig(node, { ...fields, tasks: 3.5 })).toHaveProperty('error');
    expect(patchMcpNodeConfig(node, { launchType: 'ec2', tasks: 3 })).toHaveProperty('error');
    expect(node.config['tasks']).toBe(2);
    expect(getEditableConfigFields(node)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'memoryGB', unit: 'GB', type: 'number' }),
      ]),
    );
  });

  it('keeps the legacy Users requestRate descriptor and validates the traffic range as one patch', () => {
    const node = create('client');
    expect(getEditableConfigFields(node)[0]).toEqual({
      key: 'requestRate',
      type: 'number',
      min: 2,
      max: 1000,
      value: node.config.requestRate,
    });
    expect(patchMcpNodeConfig(node, { requestRate: 1 })).toHaveProperty('error');
    expect(
      patchMcpNodeConfig(node, { variableTraffic: true, variableMinRps: 80, variableMaxRps: 50 }),
    ).toHaveProperty('error');
    expect(
      patchMcpNodeConfig(node, { variableTraffic: true, variableMinRps: 20, variableMaxRps: 60 }),
    ).toMatchObject({ node: { config: { variableTraffic: true, requestRate: 40 } } });
    const dynamic = { ...node, config: { ...node.config, syncRpsToServices: true } };
    expect(patchMcpNodeConfig(dynamic, { requestRate: 50 })).toHaveProperty('error');
  });

  it('changes a controlling option together with one of its conditional fields', () => {
    const node = create('elb');
    expect(patchMcpNodeConfig(node, { lbType: 'nlb', rules: 55 })).toHaveProperty('error');
    expect(patchMcpNodeConfig(node, { lbType: 'nlb', activeConnections: 90 })).toMatchObject({
      node: { config: { lbType: 'nlb', activeConnections: 90 } },
    });
    expect(patchMcpNodeConfig(node, { packageSizeKB: 500 })).toHaveProperty('error');
  });

  it('resets a Bedrock model when its provider changes without an explicit model', () => {
    const node = create('bedrock');
    const result = patchMcpNodeConfig(node, { provider: 'amazon' });
    expect(result).toMatchObject({
      node: { config: { provider: 'amazon', model: expect.any(String) } },
    });
    if ('error' in result) throw Error(result.error);
    const modelField = getEditableConfigFields(result.node).find(({ key }) => key === 'model');
    expect(modelField?.options?.some(({ value }) => value === result.node.config['model'])).toBe(
      true,
    );
  });

  it('edits ordered Generic Service metadata without changing its simulation config', () => {
    const node = create('generic');
    const metadata = {
      label: 'Internet Gateway',
      properties: [
        { key: 'CIDR', value: '10.0.0.0/16' },
        { key: 'CIDR', value: '' },
      ],
    };
    const result = patchMcpNodeConfig(node, metadata);
    expect(result).toMatchObject({ node: { genericMetadata: metadata, config: node.config } });
    expect(patchMcpNodeConfig(node, { label: 'Broken', latency: 100 })).toHaveProperty('error');
    expect(patchMcpNodeConfig(node, { properties: [{ key: 'CIDR', value: 7 }] })).toHaveProperty(
      'error',
    );
    expect(node.genericMetadata).toEqual({ label: '', properties: [] });
  });
});

describe('MCP pre-simulation inspection', () => {
  it('flags converging HTTP branches even if one is modeled as an event edge', () => {
    const gateway = create('apiGateway');
    const old = create('lambda');
    const alb = create('elb');
    const ecs = create('ecs');
    const db = create('rds');
    const orphan = create('generic');
    const oldEntry = factory.createConnection(gateway.id, 'out-http', old.id, 'in-event', 'event');
    const newEntry = factory.createConnection(gateway.id, 'out-http', alb.id, 'in-http', 'http');
    const oldDb = factory.createConnection(
      old.id,
      'out-database',
      db.id,
      'in-database',
      'database',
    );
    const newEcs = factory.createConnection(alb.id, 'out-http', ecs.id, 'in-http', 'http');
    const newDb = factory.createConnection(
      ecs.id,
      'out-database',
      db.id,
      'in-database',
      'database',
    );
    const nodes = [gateway, old, alb, ecs, db, orphan];
    const connections = [oldEntry, newEntry, oldDb, newEcs, newDb];
    expect(inspectCanvas(nodes, connections).issues).toEqual([
      expect.objectContaining({ code: 'ORPHAN_NODE', severity: 'warning', nodeIds: [orphan.id] }),
      expect.objectContaining({
        code: 'PARALLEL_PATHS',
        severity: 'warning',
        nodeIds: expect.arrayContaining([gateway.id, old.id, alb.id, db.id]),
        connectionIds: expect.arrayContaining([oldEntry.id, newEntry.id, oldDb.id, newDb.id]),
      }),
    ]);
    const split = connections.map((connection) =>
      connection.sourceNodeId === gateway.id ? { ...connection, trafficWeight: 50 } : connection,
    );
    expect(inspectCanvas(nodes, split).issues.map(({ code }) => code)).toEqual(['ORPHAN_NODE']);
  });

  it('flags combined weight above 100 even when no pair exceeds 100', () => {
    const gateway = create('apiGateway');
    const destination = create('rds');
    const branches = Array.from({ length: 3 }, () => create('lambda'));
    const connections = branches.flatMap((branch) => [
      {
        ...factory.createConnection(gateway.id, 'out-http', branch.id, 'in-http', 'event'),
        trafficWeight: 40,
      },
      factory.createConnection(
        branch.id,
        'out-database',
        destination.id,
        'in-database',
        'database',
      ),
    ]);
    expect(inspectCanvas([gateway, destination, ...branches], connections).issues).toEqual([
      expect.objectContaining({
        code: 'PARALLEL_PATHS',
        connectionIds: expect.arrayContaining(connections.map(({ id }) => id)),
      }),
    ]);
  });

  it('permits intentional fan-out to different targets', () => {
    const gateway = create('apiGateway');
    const first = create('lambda');
    const second = create('ecs');
    const firstRoute = factory.createConnection(
      gateway.id,
      'out-http',
      first.id,
      'in-http',
      'event',
    );
    const secondRoute = factory.createConnection(
      gateway.id,
      'out-http',
      second.id,
      'in-http',
      'http',
    );
    expect(inspectCanvas([gateway, first, second], [firstRoute, secondRoute])).toEqual({
      issues: [],
    });
  });
});

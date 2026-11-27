import { VPC_ATTACHABLE_TYPES } from '../../../core/constants/connection-rules.constants';
import type {
  AwsServiceDefinition,
  ConnectionRule,
  ServiceConfig,
} from '../../../core/models/architecture.model';
import { getCatalogConfigFields, type McpConfigField } from './canvas-mcp-config';

export {
  getEditableConfigFields,
  patchMcpNodeConfig,
  type McpConfigField,
} from './canvas-mcp-config';
export { inspectCanvas, type CanvasIssue } from './canvas-mcp-inspection';

export interface ServiceCatalogEntry {
  type: AwsServiceDefinition['type'];
  name: string;
  category: AwsServiceDefinition['category'];
  ports: AwsServiceDefinition['ports'];
  allowedTargets: string[];
  aliases: string[];
  fields?: McpConfigField[];
}

const LOAD_BALANCER_ALIASES = [
  { name: 'alb', title: 'Application Load Balancer' },
  { name: 'nlb', title: 'Network Load Balancer' },
  { name: 'clb', title: 'Classic Load Balancer' },
  { name: 'gwlb', title: 'Gateway Load Balancer' },
] as const;

const CATALOG_FIELDS: Partial<Record<AwsServiceDefinition['type'], string[]>> = {
  client: ['requestRate'],
  ecs: ['launchType', 'tasks', 'vCPU', 'memoryGB'],
  elb: ['lbType'],
  generic: ['label', 'properties'],
};

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function matchLoadBalancerAlias(query: string) {
  return LOAD_BALANCER_ALIASES.find(
    ({ name, title }) => normalizeName(name) === query || normalizeName(title) === query,
  );
}

function alternatives(catalog: readonly AwsServiceDefinition[], query: string): string[] {
  const matches: { label: string; distance: number }[] = catalog.map(({ type, name }) => ({
    label: type,
    distance: Math.min(
      editDistance(query, normalizeName(type)),
      editDistance(query, normalizeName(name)),
    ),
  }));
  if (catalog.some(({ type }) => type === 'elb')) {
    for (const { name, title } of LOAD_BALANCER_ALIASES) {
      matches.push({
        label: `${name} (elb with lbType=${name})`,
        distance: Math.min(editDistance(query, name), editDistance(query, normalizeName(title))),
      });
    }
  }
  return matches
    .filter(({ distance }) => distance <= (query.length > 5 ? 3 : 2))
    .sort((first, second) => first.distance - second.distance)
    .slice(0, 3)
    .map(({ label }) => label);
}

function editDistance(left: string, right: string): number {
  let distances = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const nextRow = [row];
    for (let column = 1; column <= right.length; column += 1) {
      nextRow[column] = Math.min(
        nextRow[column - 1] + 1,
        distances[column] + 1,
        distances[column - 1] + Number(left[row - 1] !== right[column - 1]),
      );
    }
    distances = nextRow;
  }
  return distances[right.length];
}

export function resolveServiceType(
  catalog: readonly AwsServiceDefinition[],
  query: string,
): { service: AwsServiceDefinition; defaults: Partial<ServiceConfig> } | { error: string } {
  const normalized = normalizeName(query);
  const alias = matchLoadBalancerAlias(normalized);
  const service =
    catalog.find(({ type }) => type === query) ??
    catalog.find(({ type }) => type === 'elb' && alias !== undefined) ??
    catalog.find(
      ({ type, name }) => normalizeName(type) === normalized || normalizeName(name) === normalized,
    );
  if (service) {
    return { service, defaults: alias && service.type === 'elb' ? { lbType: alias.name } : {} };
  }
  const suggestions = normalized ? alternatives(catalog, normalized) : [];
  const nextStep = suggestions.length ? ` Did you mean ${suggestions.join(', ')}?` : '';
  return {
    error: `Unknown service type "${query}".${nextStep} Use list_service_types to find services and aliases.`,
  };
}

function targetHints(
  service: AwsServiceDefinition,
  catalog: readonly AwsServiceDefinition[],
  rules: readonly ConnectionRule[],
): string[] {
  const outputs = new Set(
    service.ports.filter(({ direction }) => direction === 'output').map(({ type }) => type),
  );
  if (outputs.size === 0) return [];
  const sourceRules = rules.filter(
    ({ source, sourcePortTypes }) =>
      (source === service.type || source === '*') &&
      sourcePortTypes.some((type) => outputs.has(type)),
  );
  return catalog
    .filter(({ type, ports }) => {
      const inputs = ports.filter(({ direction }) => direction === 'input');
      if (inputs.length === 0) return false;
      if (type === 'generic' || service.type === 'generic') return true;
      if (service.type === 'vpc' && !VPC_ATTACHABLE_TYPES.includes(type)) return false;
      return sourceRules.some(
        (rule) =>
          (rule.target === type || rule.target === '*') &&
          inputs.some((port) => rule.targetPortTypes.includes(port.type)),
      );
    })
    .map(({ type }) => type);
}

export function listServiceTypes(
  catalog: readonly AwsServiceDefinition[],
  rules: readonly ConnectionRule[],
  filter: { category?: string; query?: string },
): { services: ServiceCatalogEntry[] } {
  const category = normalizeName(filter.category ?? '');
  const query = normalizeName(filter.query ?? '');
  const services = catalog.flatMap((service): ServiceCatalogEntry[] => {
    const { type, name, category: serviceCategory, ports, defaults } = service;
    const aliases =
      type === 'elb' ? LOAD_BALANCER_ALIASES.flatMap((alias) => [alias.name, alias.title]) : [];
    if (
      !normalizeName(serviceCategory).includes(category) ||
      ![type, name, ...aliases].some((value) => normalizeName(value).includes(query))
    ) {
      return [];
    }
    const entry = {
      type,
      name,
      category: serviceCategory,
      ports,
      aliases,
      allowedTargets: targetHints(service, catalog, rules),
    };
    if (query || category) return [{ ...entry, fields: getCatalogConfigFields(type, defaults) }];
    const keys = CATALOG_FIELDS[type];
    if (!keys) return [entry];
    return [
      {
        ...entry,
        fields: getCatalogConfigFields(type, defaults).filter(({ key }) => keys.includes(key)),
      },
    ];
  });
  return { services };
}

import serviceCostModelData from '../../../core/data/service-cost-model.json';
import type {
  ArchitectureNode,
  AwsServiceType,
  GenericServiceProperty,
  ServiceConfig,
} from '../../../core/models/architecture.model';
import { isFieldLocked } from '../../../core/utils/field-lock';
import { isGenericServiceMetadata } from '../../../core/utils/generic-service-metadata';
import { evaluateVisibleIf } from '../../../core/utils/visible-if';

type ConfigScalar = string | number | boolean;
type ConfigValue = ConfigScalar | GenericServiceProperty[] | null;

export interface McpConfigField {
  key: string;
  type: 'number' | 'enum' | 'boolean' | 'text' | 'properties';
  value: ConfigValue;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: ConfigScalar; label: string }[];
  visibleIf?: string;
  editable?: boolean;
}

interface ModelField extends Omit<McpConfigField, 'value'> {
  default?: ConfigScalar | null;
  readonly?: boolean;
}

interface ServiceCostModel {
  primaryParams?: ModelField[];
  costParams?: ModelField[];
}

const model = serviceCostModelData.serviceCostModel as Partial<
  Record<AwsServiceType, ServiceCostModel>
>;
const VARIABLE_TRAFFIC_FIELDS = new Set(['variableTraffic', 'variableMinRps', 'variableMaxRps']);
const REQUEST_RATE_BOUNDS = { min: 2, max: 1000 };

function modelFields(type: AwsServiceType): ModelField[] {
  const service = model[type];
  return [...(service?.primaryParams ?? []), ...(service?.costParams ?? [])].map((field) => {
    if (type === 'client' && field.key === 'requestRate')
      return { ...field, ...REQUEST_RATE_BOUNDS };
    if (type === 'ecs' && field.key === 'tasks') return { ...field, step: 1 };
    return field;
  });
}

function visibleFields(type: AwsServiceType, config: ServiceConfig): ModelField[] {
  return modelFields(type).filter(({ visibleIf }) => evaluateVisibleIf(visibleIf, config));
}

function describeField(field: ModelField, value: unknown, editable: boolean): McpConfigField {
  const { key, type, label, min, max, step, unit, options, visibleIf } = field;
  const typedValue =
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'boolean'
      ? value
      : null;
  const choices =
    type === 'enum'
      ? (options ??
        (field.default == null ? [] : [{ value: field.default, label: String(field.default) }]))
      : undefined;
  return {
    key,
    type,
    value: typedValue,
    ...(label === undefined ? {} : { label }),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(step === undefined ? {} : { step }),
    ...(unit === undefined ? {} : { unit }),
    ...(choices === undefined ? {} : { options: choices }),
    ...(visibleIf === undefined ? {} : { visibleIf }),
    editable,
  };
}

function canEditField(node: ArchitectureNode, field: ModelField): boolean {
  if (isFieldLocked(node, field)) return false;
  if (node.type !== 'client') return true;
  if (field.key === 'syncRpsToServices') return false;
  return (
    !node.config['syncRpsToServices'] ||
    !(field.key === 'requestRate' || VARIABLE_TRAFFIC_FIELDS.has(field.key))
  );
}

function genericFields(node?: ArchitectureNode): McpConfigField[] {
  return [
    {
      key: 'label',
      label: 'Service Label',
      type: 'text',
      value: node?.genericMetadata?.label ?? '',
    },
    {
      key: 'properties',
      label: 'Properties',
      type: 'properties',
      value: node?.genericMetadata?.properties ?? [],
    },
  ];
}

export function getCatalogConfigFields(
  type: AwsServiceType,
  defaults: ServiceConfig,
): McpConfigField[] {
  if (type === 'generic') return genericFields();
  return modelFields(type).map((field) =>
    describeField(
      field,
      field.visibleIf ? field.default : (defaults[field.key] ?? field.default),
      !field.readonly && field.key !== 'syncRpsToServices',
    ),
  );
}

export function getEditableConfigFields(node: ArchitectureNode): McpConfigField[] {
  if (node.type === 'generic') return genericFields(node);
  return visibleFields(node.type, node.config).map((field) => {
    if (node.type === 'client' && field.key === 'requestRate') {
      const value = Number(node.config['requestRate']);
      const editable = canEditField(node, field);
      if (editable && Number.isFinite(value)) {
        // Keep the descriptor used by the original Users-node MCP contract.
        return { key: 'requestRate', type: 'number', ...REQUEST_RATE_BOUNDS, value };
      }
      return describeField(field, value, editable);
    }
    return describeField(
      field,
      node.config[field.key] === undefined ? field.default : node.config[field.key],
      canEditField(node, field),
    );
  });
}

function validFieldValue(field: ModelField, value: unknown): boolean {
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'enum') {
    return field.options?.length
      ? field.options.some((option) => option.value === value)
      : value === field.default;
  }
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (field.min === undefined || value >= field.min) &&
    (field.max === undefined || value <= field.max)
  );
}

type ConfigPatch = { node: ArchitectureNode; fields: Record<string, unknown> } | { error: string };

function patchGeneric(node: ArchitectureNode, fields: Record<string, unknown>): ConfigPatch {
  const metadata = { label: '', properties: [], ...node.genericMetadata, ...fields };
  if (
    Object.keys(fields).some((key) => key !== 'label' && key !== 'properties') ||
    !isGenericServiceMetadata(metadata)
  ) {
    return {
      error: 'Generic Service accepts only a text label and ordered text key/value properties.',
    };
  }
  const { label, properties } = metadata;
  return {
    node: {
      ...node,
      genericMetadata: { label, properties: properties.map(({ key, value }) => ({ key, value })) },
    },
    fields,
  };
}

function reconcileClientTraffic(
  config: ServiceConfig,
  fields: Record<string, unknown>,
): string | undefined {
  if (!config['variableTraffic']) return undefined;
  if (![...VARIABLE_TRAFFIC_FIELDS].some((key) => Object.hasOwn(fields, key))) return undefined;
  const min = Number(config['variableMinRps'] ?? 50);
  const max = Number(config['variableMaxRps'] ?? 200);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    return 'Variable Traffic needs a valid minimum RPS at or below the maximum RPS.';
  }
  config['variableMinRps'] = min;
  config['variableMaxRps'] = max;
  config.requestRate = Math.round((min + max) / 2);
  return undefined;
}

export function patchMcpNodeConfig(
  node: ArchitectureNode,
  fields: Record<string, unknown>,
): ConfigPatch {
  const entries = Object.entries(fields);
  if (!entries.length) return { error: 'Provide at least one field to edit.' };
  if (node.type === 'generic') return patchGeneric(node, fields);

  const config = { ...node.config, ...fields };
  const activeFields = visibleFields(node.type, config);
  const candidate = { ...node, config };
  for (const [key, value] of entries) {
    const descriptor = activeFields.find((field) => field.key === key);
    if (!descriptor || !canEditField(candidate, descriptor)) {
      return {
        error: `Field "${key}" is unknown, inactive or read-only. Check get_node_config_fields for this node.`,
      };
    }
    if (node.type === 'client' && key === 'requestRate') {
      if (!Number.isInteger(value) || !validFieldValue(descriptor, value)) {
        return { error: 'requestRate must be an integer from 2 to 1000.' };
      }
    } else if (
      !validFieldValue(descriptor, value) ||
      (node.type === 'ecs' && key === 'tasks' && !Number.isInteger(value))
    ) {
      return {
        error: `Invalid value for "${key}". Check the type, options and bounds in get_node_config_fields.`,
      };
    }
  }

  if (node.type === 'client') {
    const error = reconcileClientTraffic(config, fields);
    if (error) return { error };
  }
  if (
    node.type === 'bedrock' &&
    Object.hasOwn(fields, 'provider') &&
    !Object.hasOwn(fields, 'model')
  ) {
    const field = activeFields.find(({ key }) => key === 'model');
    const defaultModel = field?.default ?? field?.options?.[0]?.value;
    if (defaultModel !== undefined) config['model'] = defaultModel;
  }
  return { node: candidate, fields };
}

import type { ArchitectureNode, GenericServiceMetadata } from '../models/architecture.model';

export function isGenericServiceMetadata(value: unknown): value is GenericServiceMetadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    'label' in value &&
    typeof value.label === 'string' &&
    'properties' in value &&
    Array.isArray(value.properties) &&
    value.properties.every(
      (property: unknown) =>
        typeof property === 'object' &&
        property !== null &&
        'key' in property &&
        typeof property.key === 'string' &&
        'value' in property &&
        typeof property.value === 'string',
    )
  );
}

export function hasValidGenericServiceMetadata(node: unknown): boolean {
  if (typeof node !== 'object' || node === null || !('type' in node)) return false;
  return (
    node.type !== 'generic' ||
    !('genericMetadata' in node) ||
    node.genericMetadata === undefined ||
    isGenericServiceMetadata(node.genericMetadata)
  );
}

export function recoverGenericServiceMetadata(nodes: ArchitectureNode[]): ArchitectureNode[] {
  return nodes.map((node) => {
    if (node?.type !== 'generic' || hasValidGenericServiceMetadata(node)) return node;
    const recovered = { ...node };
    delete recovered.genericMetadata;
    return recovered;
  });
}

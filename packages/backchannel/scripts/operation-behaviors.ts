import { compareStrings } from '../src/json-schema-utilities.ts';
import type { CatalogOperationSnapshot } from '../src/operation-catalog-snapshot.ts';

/** Emit only declared public metadata, with no server or transport imports. */
export function renderOperationBehaviors(
  operations: readonly CatalogOperationSnapshot[],
): string | undefined {
  if (!operations.some((operation) => operation.behavior !== undefined)) return undefined;
  const descriptors = Object.fromEntries(
    operations
      .toSorted((a, b) => compareStrings(a.name, b.name))
      .map((operation) => [
        operation.name,
        {
          mcpExposable: operation.mcpExposable ?? false,
          ...(operation.behavior === undefined ? {} : { behavior: operation.behavior }),
        },
      ]),
  );
  return `export const CATALOG_OPERATION_BEHAVIORS = ${JSON.stringify(descriptors, null, 2)} as const;\n`;
}

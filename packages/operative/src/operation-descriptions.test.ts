/**
 * COR-1801. Operative exports its operations for any host's catalog to serve, so each one
 * describes itself on the wire at the source: a description, and a zod `.describe()` on every
 * top-level parameter, which is the text OpenAPI and OpenRPC publish. A host that serves one
 * of these operations must not have to re-declare its input to make it self-describing.
 */
import { describe, expect, it } from 'bun:test';

import { findUndescribedOperations } from '@lostgradient/weft';

import * as operative from './index.ts';
import { runEventsSubscriptionOperation } from './index.ts';

type ExportedOperation = Parameters<typeof findUndescribedOperations>[0] extends infer Argument
  ? Argument extends Iterable<infer Operation>
    ? Operation
    : never
  : never;

/** Every export that is a Weft operation definition, so an operation added later is covered. */
function exportedOperations(): ExportedOperation[] {
  return (Object.values(operative) as unknown[]).filter(
    (value): value is ExportedOperation =>
      typeof value === 'object' &&
      value !== null &&
      'inputSchema' in value &&
      'access' in value &&
      'name' in value,
  );
}

describe('operative operation descriptions', () => {
  it('finds the run-events operation among the exports', () => {
    expect(exportedOperations()).toContain(runEventsSubscriptionOperation);
  });

  it('describes every exported operation and each of its parameters', () => {
    expect(findUndescribedOperations(exportedOperations())).toEqual([]);
  });
});

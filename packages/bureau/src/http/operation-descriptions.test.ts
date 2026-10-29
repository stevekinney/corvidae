/**
 * COR-1750. Every discoverable operation `createBureauHandler` serves describes itself on the wire:
 * it carries a description, and each top-level parameter carries a zod `.describe()`, which is the
 * text OpenAPI and OpenRPC publish. The served operations are read from the handler's own registry,
 * `BUREAU_HANDLER_OPERATIONS`, so an operation or a field added later is covered without editing
 * this file.
 */
import { describe, expect, it } from 'bun:test';

import { findUndescribedOperations } from '@lostgradient/weft';

import { BUREAU_HANDLER_OPERATIONS } from './create-bureau-handler.ts';

describe('bureau operation descriptions', () => {
  it('describes every discoverable operation and each of its parameters', () => {
    expect(findUndescribedOperations(BUREAU_HANDLER_OPERATIONS)).toEqual([]);
  });
});

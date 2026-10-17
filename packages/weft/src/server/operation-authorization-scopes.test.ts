/**
 * Authorization scopes on Weft's catalog operations (COR-1466).
 *
 * Every operation except `weft.system.principal` requires a scope. These tests
 * pin the scope each operation requires, prove each is refused without it and
 * allowed with it, and fail the suite when a new operation is declared
 * `public`.
 */

import { describe, expect, it } from 'bun:test';

import { AUTHORIZATION_SCOPES, type AuthorizationScope } from './authorization-scope.ts';
import { evaluateAccess } from './authorization.ts';
import { anonymousPrincipal, principalFromApiKey } from './principal.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';

/** The scope table from COR-1466: operation name → the scope it requires. */
const REQUIRED_SCOPE_BY_OPERATION: Readonly<Record<string, AuthorizationScope>> = {
  'weft.workflows.get': 'workflows:read',
  'weft.workflows.list': 'workflows:read',
  'weft.workflows.aggregate': 'workflows:read',
  'weft.workflows.timeline.get': 'workflows:read',
  'weft.workflows.result.get': 'workflows:read',
  'weft.workflows.checkpoints.get': 'workflows:read',
  'weft.workflows.checkpoints.list': 'workflows:read',
  'weft.workflows.scheduleprovenance.get': 'workflows:read',
  'weft.workflows.finalizer.get': 'workflows:read',
  'weft.updates.result.get': 'workflows:read',
  'weft.workflows.start': 'workflows:write',
  'weft.workflows.startorsignal': 'workflows:write',
  'weft.workflows.fork': 'workflows:write',
  'weft.workflows.cancel': 'workflows:write',
  'weft.workflows.suspend': 'workflows:write',
  'weft.workflows.resume': 'workflows:write',
  'weft.workflows.timeout': 'workflows:write',
  'weft.workflows.signal': 'signals:write',
  'weft.workflows.tags.add': 'tags:write',
  'weft.workflows.tags.remove': 'tags:write',
  'weft.workflows.purge': 'workflows:admin',
  'weft.recover.all': 'workflows:admin',
  'weft.workflows.update': 'updates:write',
  'weft.workflows.query': 'queries:read',
  'weft.workflows.events.list': 'events:read',
  'weft.workflows.attributes.get': 'attributes:read',
  'weft.workflows.attributes.set': 'attributes:write',
  'weft.workflows.streams.chunks': 'streams:read',
  'weft.workflows.streams.sse': 'streams:read',
  'weft.schedules.create': 'schedules:write',
  'weft.schedules.update': 'schedules:write',
  'weft.schedules.pause': 'schedules:write',
  'weft.schedules.resume': 'schedules:write',
  'weft.schedules.cancel': 'schedules:write',
  'weft.reviews.get': 'reviews:read',
  'weft.reviews.decision.submit': 'reviews:write',
  'weft.retention.get': 'system:read',
};

const registry = createLiveOperationRegistry();

function accessOf(operationName: string) {
  const operation = registry.get(operationName);
  if (operation === undefined) throw new Error(`operation ${operationName} is not registered`);
  return operation.access;
}

function principalHolding(scopes: readonly AuthorizationScope[]) {
  return principalFromApiKey({ subject: 'scope-table-test', scopes });
}

describe('the scope an operation requires', () => {
  for (const [operationName, scope] of Object.entries(REQUIRED_SCOPE_BY_OPERATION)) {
    describe(`${operationName} requires ${scope}`, () => {
      it('declares the scope', () => {
        expect(accessOf(operationName)).toEqual({
          kind: 'scoped',
          scopes: { kind: 'anyOf', scopes: [scope] },
        });
      });

      it('is allowed with the scope', () => {
        expect(evaluateAccess(accessOf(operationName), principalHolding([scope]))).toEqual({
          allowed: true,
        });
      });

      it('is refused with every other scope', () => {
        const others = AUTHORIZATION_SCOPES.filter((candidate) => candidate !== scope);
        const result = evaluateAccess(accessOf(operationName), principalHolding(others));
        expect(result).toMatchObject({ allowed: false, classification: 'forbidden' });
      });

      it('is refused to an anonymous caller', () => {
        expect(evaluateAccess(accessOf(operationName), anonymousPrincipal())).toMatchObject({
          allowed: false,
          classification: 'unauthorized',
        });
      });

      it('is discoverable although it is no longer public', () => {
        expect(registry.get(operationName)?.discoverable).toBe(true);
      });
    });
  }
});

describe('public operations', () => {
  it('are exactly weft.system.principal, so a new public operation fails the suite', () => {
    const publicOperations = registry
      .list()
      .filter((operation) => operation.access.kind === 'public')
      .map((operation) => operation.name)
      .toSorted();
    expect(publicOperations).toEqual(['weft.system.principal']);
  });

  it('leave every operation in the scope table registered', () => {
    for (const operationName of Object.keys(REQUIRED_SCOPE_BY_OPERATION)) {
      expect(registry.get(operationName)).toBeDefined();
    }
  });
});

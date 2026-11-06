import type { WorkspaceIdentity } from '@lostgradient/weft';
import { expect, test } from 'bun:test';
import { createHostMutationContext, parseHostMutationInput } from './host-mutation-context.ts';

const administrator: WorkspaceIdentity = {
  version: 1,
  workspaceId: 'workspace',
  actorId: 'actor',
  owner: 'owner',
  actorKind: 'user',
  membershipRevision: '1',
  capabilities: ['workspace:use', 'workspace:manage'],
};

test('mutation context pins identity while allowing current membership revisions', async () => {
  let current: WorkspaceIdentity | undefined = administrator;
  const input = { operationId: 'client-operation', expectedRevision: 'configuration-1' };
  const context = createHostMutationContext(administrator, input, async () => current);
  input.operationId = 'changed';
  expect(context.operationId).toBe('client-operation');
  expect(Object.isFrozen(context)).toBe(true);
  current = { ...administrator, membershipRevision: '2' };
  const refreshed = await context.revalidate();
  expect(refreshed.membershipRevision).toBe('2');
  for (const replacement of [
    undefined,
    { ...administrator, actorId: 'other' },
    { ...administrator, owner: 'other' },
    { ...administrator, workspaceId: 'other' },
    { ...administrator, capabilities: [] },
  ]) {
    current = replacement;
    const result = await context.revalidate().then(
      () => 'allowed',
      () => 'forbidden',
    );
    expect(result).toBe('forbidden');
  }
});

test('publication operation IDs are stable and scoped by resource and identity', () => {
  const make = (identity = administrator) =>
    createHostMutationContext(
      identity,
      { operationId: 'client-id', expectedRevision: null },
      async () => identity,
    );
  const context = make();
  const id = context.operationIdFor('provider', 'anthropic');
  expect(id).toMatch(/^[a-f0-9]{64}$/);
  expect(make().operationIdFor('provider', 'anthropic')).toBe(id);
  expect(context.operationIdFor('plugin', 'anthropic')).not.toBe(id);
  expect(context.operationIdFor('provider', 'openai')).not.toBe(id);
  expect(
    make({ ...administrator, actorId: 'another' }).operationIdFor('provider', 'anthropic'),
  ).not.toBe(id);
});

test('transport mutation input requires an explicit bounded ID and revision', () => {
  expect(parseHostMutationInput({ operationId: 'id', expectedRevision: null })).toEqual({
    operationId: 'id',
    expectedRevision: null,
  });
  for (const input of [
    {},
    { operationId: 'id' },
    { operationId: 'x'.repeat(129), expectedRevision: null },
    { operationId: 'private value', expectedRevision: null },
    { operationId: 'id', expectedRevision: 1 },
  ]) {
    expect(() => parseHostMutationInput(input)).toThrow('bounded operation ID');
  }
});

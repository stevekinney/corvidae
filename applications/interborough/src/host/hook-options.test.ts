/** COR-1978: what a remote home needs of hooks before they are on there. */
import { describe, expect, test } from 'bun:test';

import { DEPLOYMENT_HOOK_SECRETS, hookOptionsFor } from './hook-options.ts';

describe('the hooks a home turns on', () => {
  test('a home on the person’s own machine takes Bureau’s defaults', () => {
    expect(hookOptionsFor('local')).toEqual({});
  });

  test('a remote home locks secret writes and refuses private networks, both or not at all', () => {
    const options = hookOptionsFor('remote');

    expect(options.secrets?.writeLock?.()).toBe('deployment');
    expect(options.urlPolicy).toEqual({ allowPrivateNetworks: false });
  });

  test('the port of a remote home holds nothing, and cannot be written', async () => {
    expect(await DEPLOYMENT_HOOK_SECRETS.get('hook-1')).toBeUndefined();
    await DEPLOYMENT_HOOK_SECRETS.delete('hook-1');
    expect(
      await DEPLOYMENT_HOOK_SECRETS.set('hook-1', {} as never).then(
        () => 'written',
        () => 'refused',
      ),
    ).toBe('refused');
  });
});

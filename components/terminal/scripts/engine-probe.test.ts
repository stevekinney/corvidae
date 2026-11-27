import { describe, expect, test } from 'bun:test';
import { classifyBrowserFailure } from './engine-probe.ts';

describe('terminal engine probe', () => {
  test('serializes browser failure phase in the Bun context', async () => {
    const requests = ['/'];
    const diagnostics = ['console:info:fixture'];
    const result = await classifyBrowserFailure(
      async () => ({ phase: 'after-init' }),
      new Error('TimeoutError: forced probe failure'),
      requests,
      diagnostics,
    );

    expect(result.status).toBe('unavailable');
    expect(result.requests).toBe(requests);
    expect(result.diagnostics).toContain('phase:{"phase":"after-init"}');
    expect(result.cells['input-return-semantics']?.observation).toContain(
      'unavailable:timeout:{"phase":"after-init"}',
    );
  });
});

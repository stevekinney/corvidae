import { hasDefinitionResolver, OPERATIVE_RESOLVE_RUN_OPTIONS } from '@lostgradient/operative';
import { getToolboxApprovalOptions } from 'armorer';
import { expect, spyOn, test } from 'bun:test';

import {
  createRegenerationProofAgent,
  EXPIRING_APPROVAL_AGENT,
} from './e2e/regeneration-proof-agent.ts';

test('the fresh retry approval remains resumable after the original binding lifetime', async () => {
  let currentTime = Date.parse('2026-11-21T13:15:00Z');
  const clock = spyOn(Date, 'now').mockImplementation(() => currentTime);
  try {
    const agent = createRegenerationProofAgent()[EXPIRING_APPROVAL_AGENT];
    if (!hasDefinitionResolver(agent)) throw new Error('expected a fixture agent definition');
    const { generate, toolbox } = await agent[OPERATIVE_RESOLVE_RUN_OPTIONS]('Approve the proof.');
    const { approvalNow, approvalBindingTtlMs } = getToolboxApprovalOptions(toolbox);
    if (approvalNow === undefined || approvalBindingTtlMs === undefined) {
      throw new Error('expected the fixture approval clock and binding lifetime');
    }
    const generateFor = (userTurns: number) =>
      generate({
        conversation: {
          getMessages: () => Array.from({ length: userTurns }, () => ({ role: 'user' })),
        },
      } as never);

    await generateFor(1);
    const firstExpiry = approvalNow() + approvalBindingTtlMs;
    expect(firstExpiry).toBe(currentTime + 20_000);
    currentTime += 22_720;
    expect(approvalNow()).toBeGreaterThan(firstExpiry);

    await generateFor(2);
    const retryExpiry = approvalNow() + approvalBindingTtlMs;
    currentTime += 22_720;
    // The host advertises the retry's expiry in real time. Armorer must still accept the same
    // binding on its own clock after the original 20-second interval has passed.
    expect(retryExpiry).toBeGreaterThan(currentTime);
    expect(approvalNow()).toBeLessThan(retryExpiry);
  } finally {
    clock.mockRestore();
  }
});

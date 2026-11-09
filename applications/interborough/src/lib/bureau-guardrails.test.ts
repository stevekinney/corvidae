import { rejectionOf } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';

import { listGuardrails } from './bureau-guardrails.ts';
import { installBureauStub, type BureauStub } from './bureau-stub.test-support.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

const GROUNDING = {
  id: 'guardrails:grounding',
  family: 'output',
  description: 'Flags claims the conversation does not support.',
  configurable: true,
  configuration: { type: 'object', properties: { threshold: { type: 'number', default: 0.8 } } },
  source: 'plugin',
  plugin: 'guardrails',
};

describe('the installed guardrails', () => {
  test('asks the Bureau for them and reads each one’s configuration schema', async () => {
    stub = installBureauStub({ 'bureau.guardrails.list': () => ({ guardrails: [GROUNDING] }) });

    expect(await listGuardrails()).toEqual([GROUNDING] as never);
    expect(stub.callsTo('bureau.guardrails.list')[0]?.params).toEqual({});
  });

  test('refuses an answer whose family it does not know, rather than mislabel it', async () => {
    stub = installBureauStub({
      'bureau.guardrails.list': () => ({ guardrails: [{ ...GROUNDING, family: 'network' }] }),
    });

    expect(await rejectionOf(listGuardrails())).toBeInstanceOf(Error);
  });
});

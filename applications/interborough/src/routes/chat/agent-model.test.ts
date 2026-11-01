/** Which model an agent's chat runs on when it was never switched. */
import { describe, expect, test } from 'bun:test';

import type { AgentModels } from '../../lib/bureau-client.ts';
import { agentModel } from './agent-model.ts';

const SONNET = { provider: 'anthropic', model: 'claude-sonnet-5', displayName: 'Sonnet' };
const HAIKU = { provider: 'anthropic', model: 'claude-haiku-4-5', displayName: 'Haiku' };

function listing(models: AgentModels['models'], defaultModel: AgentModels['default']): AgentModels {
  return { selectable: models.length > 1, models, default: defaultModel };
}

describe('agentModel', () => {
  test('is the default the Bureau names', () => {
    const named = { provider: 'anthropic', model: 'claude-haiku-4-5' };
    expect(agentModel(listing([SONNET, HAIKU], named))).toEqual(named);
  });

  test('is the one model an agent allows when the Bureau names no default', () => {
    expect(agentModel(listing([SONNET], null))).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
  });

  test('is unknown when there is no default and the agent allows none, or several', () => {
    expect(agentModel(listing([], null))).toBeNull();
    expect(agentModel(listing([SONNET, HAIKU], null))).toBeNull();
  });

  test('is unknown until the Bureau has answered', () => {
    expect(agentModel(undefined)).toBeNull();
  });
});

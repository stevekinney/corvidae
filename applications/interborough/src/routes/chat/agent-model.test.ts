/** Which model an agent's chat runs on when it was never switched. */
import { describe, expect, test } from 'bun:test';

import type { AgentModels } from '../../lib/bureau-client.ts';
import { agentModel, modelDisplayName, modelInUse } from './agent-model.ts';

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

describe('modelInUse', () => {
  test('names the chat’s own model by the agent’s listing', () => {
    const own = { provider: 'anthropic', model: 'claude-haiku-4-5' };
    expect(modelInUse(own, listing([SONNET, HAIKU], null))).toEqual({
      displayName: 'Haiku',
      model: 'claude-haiku-4-5',
    });
  });

  test('is the agent’s model for a chat that was never switched', () => {
    const named = { provider: 'anthropic', model: 'claude-sonnet-5' };
    expect(modelInUse(null, listing([SONNET, HAIKU], named))).toEqual({
      displayName: 'Sonnet',
      model: 'claude-sonnet-5',
    });
  });

  test('says the model’s own name when the agent no longer lists it, and nothing when none is known', () => {
    const own = { provider: 'anthropic', model: 'claude-old' };
    expect(modelInUse(own, listing([SONNET], null))).toEqual({
      displayName: 'claude-old',
      model: 'claude-old',
    });
    expect(modelInUse(undefined, listing([SONNET, HAIKU], null))).toBeNull();
    expect(modelInUse(null, undefined)).toBeNull();
  });
});

describe('modelDisplayName', () => {
  test('reads an Anthropic model name as the product name', () => {
    expect(modelDisplayName('claude-sonnet-5-5')).toBe('Claude Sonnet 5.5');
    expect(modelDisplayName('claude-haiku-5-5')).toBe('Claude Haiku 5.5');
    expect(modelDisplayName('claude-opus-5')).toBe('Claude Opus 5');
    expect(modelDisplayName('claude-sonnet-4-5-20250929')).toBe('Claude Sonnet 4.5');
  });

  test('leaves any other name as it is', () => {
    expect(modelDisplayName('gpt-4o')).toBe('gpt-4o');
    expect(modelDisplayName('gemini-2.5-pro')).toBe('gemini-2.5-pro');
    expect(modelDisplayName('claude-old')).toBe('claude-old');
  });
});

describe('modelInUse with the latest reply’s model', () => {
  const reply = { provider: 'anthropic', model: 'claude-sonnet-5-5' };

  test('falls back to the model that wrote the latest reply when the chat and its agent name none', () => {
    expect(modelInUse(null, listing([SONNET, HAIKU], null), reply)).toEqual({
      displayName: 'Claude Sonnet 5.5',
      model: 'claude-sonnet-5-5',
    });
    expect(modelInUse(null, undefined, reply)).toEqual({
      displayName: 'Claude Sonnet 5.5',
      model: 'claude-sonnet-5-5',
    });
  });

  test('prefers the chat’s own model and the agent’s default to the reply’s', () => {
    const own = { provider: 'anthropic', model: 'claude-haiku-4-5' };
    expect(modelInUse(own, listing([SONNET, HAIKU], null), reply)?.model).toBe('claude-haiku-4-5');
    const named = { provider: 'anthropic', model: 'claude-sonnet-5' };
    expect(modelInUse(null, listing([SONNET, HAIKU], named), reply)?.model).toBe('claude-sonnet-5');
  });

  test('uses the listing’s label when it has one, and the product name when the label is the model name', () => {
    const bare = {
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      displayName: 'claude-sonnet-5-5',
    };
    expect(modelInUse(null, listing([bare], null))).toEqual({
      displayName: 'Claude Sonnet 5.5',
      model: 'claude-sonnet-5-5',
    });
  });
});

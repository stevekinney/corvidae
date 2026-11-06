/**
 * The model a reply names (COR-2014, row 16k): the one the Bureau recorded on the reply's row, by
 * its name for a person, never the one the chat runs on now.
 */
import { describe, expect, test } from 'bun:test';

import { REPLY_MODEL_METADATA_KEY, replyModelLabel, replyModelOf } from './reply-model.ts';

const CHOICES = [
  { provider: 'anthropic', model: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' },
  { provider: 'anthropic', model: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5' },
];

describe('replyModelOf', () => {
  test('reads the provider and model the row records', () => {
    expect(
      replyModelOf({
        [REPLY_MODEL_METADATA_KEY]: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      }),
    ).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
  });

  test('reads no model from a row that records none, or records one malformed', () => {
    expect(replyModelOf(undefined)).toBeUndefined();
    expect(replyModelOf({})).toBeUndefined();
    expect(replyModelOf({ [REPLY_MODEL_METADATA_KEY]: 'claude' })).toBeUndefined();
    expect(replyModelOf({ [REPLY_MODEL_METADATA_KEY]: { provider: 'anthropic' } })).toBeUndefined();
    expect(
      replyModelOf({ [REPLY_MODEL_METADATA_KEY]: { provider: 'anthropic', model: '' } }),
    ).toBeUndefined();
  });
});

describe('replyModelLabel', () => {
  test('names the model by its display name', () => {
    expect(replyModelLabel({ provider: 'anthropic', model: 'claude-haiku-5-5' }, CHOICES)).toBe(
      'Claude Haiku 5.5',
    );
  });

  test('names a model the agent no longer lists, or another provider’s of the same name, by its own name', () => {
    expect(replyModelLabel({ provider: 'anthropic', model: 'claude-opus-5-5' }, CHOICES)).toBe(
      'claude-opus-5-5',
    );
    expect(replyModelLabel({ provider: 'bedrock', model: 'claude-sonnet-5-5' }, CHOICES)).toBe(
      'claude-sonnet-5-5',
    );
  });
});

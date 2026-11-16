import { describe, expect, test } from 'bun:test';

import { PluginReactionError } from './index.ts';

describe('PluginReactionError', () => {
  test('is exported by the package as an error that is not permanent by default', () => {
    const error = new PluginReactionError('Slack is down');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PluginReactionError');
    expect(error.message).toBe('Slack is down');
    expect(error.permanent).toBe(false);
    expect(error.cause).toBeUndefined();
  });

  test('carries permanent: true and the cause it is given', () => {
    const cause = new Error('404');
    const error = new PluginReactionError('No such channel', { permanent: true, cause });
    expect(error.permanent).toBe(true);
    expect(error.cause).toBe(cause);
  });

  test('is permanent only when permanent is exactly true', () => {
    expect(new PluginReactionError('x', { permanent: false }).permanent).toBe(false);
    expect(new PluginReactionError('x', {}).permanent).toBe(false);
  });
});

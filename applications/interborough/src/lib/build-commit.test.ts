import { describe, expect, test } from 'bun:test';

import { buildCommit } from './build-commit.ts';

describe('buildCommit', () => {
  test('reads the publication label from the document', () => {
    const config = document.createElement('script');
    config.id = 'weft-ui-config';
    config.type = 'application/json';
    config.textContent = JSON.stringify({ baseUrl: '', buildCommit: 'abc1234' });
    document.head.append(config);
    try {
      expect(buildCommit()).toBe('abc1234');
    } finally {
      config.remove();
    }
  });

  test('is empty for a source that was not built', () => {
    expect(buildCommit()).toBe('');
  });
});

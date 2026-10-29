import { describe, expect, it } from 'bun:test';

import * as api from './index.ts';

describe('package entry', () => {
  it('exports the adapter and nothing else at runtime', () => {
    expect(Object.keys(api)).toEqual(['PostgresStorage']);
    expect(api.PostgresStorage).toBeFunction();
  });
});

import { describe, expect, it } from 'bun:test';

import * as api from './index.ts';

describe('package entry', () => {
  it('exports the adapter and nothing else', () => {
    expect(Object.keys(api)).toEqual(['IndexedDBStorage']);
    expect(api.IndexedDBStorage).toBeFunction();
  });
});

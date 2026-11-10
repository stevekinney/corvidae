import { describe, expect, test } from 'bun:test';

import { API_SCOPES, isApiScope } from './api-scopes.ts';

describe('isApiScope', () => {
  test('accepts every scope in the catalog', () => {
    for (const scope of API_SCOPES) expect(isApiScope(scope)).toBe(true);
  });

  test('rejects unknown, empty, and inherited-key names', () => {
    for (const value of ['', 'runs', 'runs:admin', 'RUNS:READ', 'constructor', '__proto__']) {
      expect(isApiScope(value)).toBe(false);
    }
  });
});

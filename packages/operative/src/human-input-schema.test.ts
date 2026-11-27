import { describe, expect, it } from 'bun:test';

import { checkHumanInputSchema, HumanInputSchemaError } from './human-input-schema';

describe('human-input schema references', () => {
  it('refuses an unresolved remote reference before an optional answer uses it', () => {
    expect(() =>
      checkHumanInputSchema('deploy', {
        type: 'object',
        properties: { optional: { $ref: 'https://example.invalid/schema.json' } },
      }),
    ).toThrow(HumanInputSchemaError);
  });
});

import { describe, expect, it } from 'bun:test';

import { checkHumanInputSchema, HumanInputSchemaError } from './human-input-schema';

describe('interpreted schema reference admission', () => {
  it('refuses a remote dynamic reference below an optional property', () => {
    expect(() =>
      checkHumanInputSchema('deploy', {
        type: 'object',
        properties: { optional: { $dynamicRef: 'https://example.invalid/schema.json' } },
      }),
    ).toThrow(HumanInputSchemaError);
  });

  it('keeps a nested local dynamic reference usable', () => {
    expect(() =>
      checkHumanInputSchema('deploy', {
        type: 'object',
        properties: { optional: { $dynamicRef: '#/$defs/value' } },
        $defs: { value: { type: 'string', $dynamicAnchor: 'value' } },
      }),
    ).not.toThrow();
  });
});

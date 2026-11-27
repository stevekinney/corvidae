import { describe, expect, it } from 'bun:test';

import { InteractiveSurfaceSchemaCompiler, InteractiveSurfaceValidationError } from './validation';

describe('the surface schema compiler', () => {
  it('rejects unsafe schemas without poisoning valid compilation', () => {
    const compiler = new InteractiveSurfaceSchemaCompiler();
    const asynchronous = { $async: true, type: 'object' };
    const patterned = { type: 'object', properties: { code: { type: 'string', pattern: '^a+$' } } };

    for (const schema of [asynchronous, patterned]) {
      expect(() => compiler.compile(schema, 'schema')).toThrow(InteractiveSurfaceValidationError);
    }
    const valid = compiler.compile({ type: 'object', required: ['name'] }, 'schema');
    expect(valid.validate({ name: 'Ada' })).toBe(true);
    expect(valid.validate({})).toBe(false);
  });
});

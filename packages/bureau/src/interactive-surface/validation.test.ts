import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'bun:test';

import { InteractiveSurfaceSchemaCompiler, InteractiveSurfaceValidationError } from './validation';

const removeSchema = Ajv2020.prototype.removeSchema;

afterEach(() => {
  Ajv2020.prototype.removeSchema = removeSchema;
});

describe('the surface schema compiler', () => {
  it('evicts every schema it rejects after compiling began, so rejected schemas cannot pile up', () => {
    const evicted: unknown[] = [];
    Ajv2020.prototype.removeSchema = function (
      this: Ajv2020,
      ...args: Parameters<typeof removeSchema>
    ) {
      evicted.push(args[0]);
      return removeSchema.apply(this, args);
    };
    const compiler = new InteractiveSurfaceSchemaCompiler();
    const asynchronous = { $async: true, type: 'object' };
    const patterned = { type: 'object', properties: { code: { type: 'string', pattern: '^a+$' } } };

    for (const schema of [asynchronous, patterned]) {
      expect(() => compiler.compile(schema, 'schema')).toThrow(InteractiveSurfaceValidationError);
    }

    expect(evicted).toContain(asynchronous);
    expect(evicted).toContain(patterned);
  });
});

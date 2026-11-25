import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { projectedInputSchema } from './input-schema.ts';

describe('projected input schemas', () => {
  it('accepts an ordinary object validator', () => {
    const schema = z.object({ assetId: z.string().min(1) });
    expect(projectedInputSchema(schema, undefined, 'equipment.lookup')).toBe(schema);
  });

  it('rejects unsupported schemas and transforms with the selection name', () => {
    expect(() => projectedInputSchema(z.string(), undefined, 'equipment.lookup')).toThrow(
      'equipment.lookup',
    );
    expect(() =>
      projectedInputSchema(
        z.object({ value: z.string().transform(Number) }),
        undefined,
        'equipment.lookup',
      ),
    ).toThrow('equipment.lookup');
  });

  it('rejects a wire schema that disagrees with the validator', () => {
    expect(() =>
      projectedInputSchema(
        z.object({ assetId: z.string() }),
        { type: 'object', properties: { assetId: { type: 'number' } }, required: ['assetId'] },
        'equipment.lookup',
      ),
    ).toThrow('equipment.lookup');
  });
});

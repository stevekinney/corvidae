/**
 * COR-2009 (sweep W70) — Settings shows each setting's description as the Bureau publishes it
 * (`bureau.settings.schema()`), so no description may use an internal product name. Every
 * description in the published schema, nested ones included, goes through the `product-word` rule
 * the app's own copy is held to.
 */
import { SETTING_KEYS, settingsSchema } from '@lostgradient/bureau';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { productWords } from './check-interface-rules.ts';

/** Every `description` in a JSON Schema, with the path it sits at. */
function descriptionsIn(node: unknown, path: string): Array<[string, string]> {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => descriptionsIn(item, `${path}[${index}]`));
  }
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([key, value]): Array<[string, string]> => {
    if (key === 'description' && typeof value === 'string') return [[path, value]];
    return descriptionsIn(value, `${path}.${key}`);
  });
}

// Built the way `bureau.settings.schema()` builds what it publishes.
const published = z.toJSONSchema(settingsSchema, { io: 'input' }) as {
  properties: Record<string, { description?: string }>;
};

describe('the settings descriptions Settings shows', () => {
  test('every setting has one', () => {
    const missing = SETTING_KEYS.filter(
      (key) => typeof published.properties[key]?.description !== 'string',
    );
    expect(missing).toEqual([]);
  });

  test('none uses an internal product name', () => {
    const offending = descriptionsIn(published, 'schema').flatMap(([path, text]) =>
      productWords(text).map((word) => `${path}: ${word}`),
    );
    expect(offending).toEqual([]);
  });

  test('the rule catches each product name a description could use', () => {
    expect(productWords("How long Bureau's feed keeps events, as Weft's engine sees it.")).toEqual([
      "Bureau's",
      "Weft's",
      'engine',
    ]);
    // An identifier and the command a person types are not product words.
    expect(productWords('Grants bureau.memory:write; run weft codegen.')).toEqual([]);
  });
});

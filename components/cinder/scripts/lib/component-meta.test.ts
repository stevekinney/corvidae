import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

import Ajv from 'ajv/dist/2020.js';

import {
  buildComponentMetaSchema,
  COMPONENT_META_SCHEMA_PATH,
  COMPONENT_PACKAGE_ROOTS,
  discoverMetaComponents,
  metaPath,
  parseComponentMeta,
  readComponentMeta,
} from './component-meta.ts';

const components = COMPONENT_PACKAGE_ROOTS.flatMap(discoverMetaComponents);

describe('authored component metadata', () => {
  test('finds the components of all four packages', () => {
    const packages = new Set(components.map((component) => component.packageRoot));
    expect(packages.size).toBe(4);
    expect(components.length).toBeGreaterThan(200);
  });

  test('every component directory has a <name>.meta.json that validates against its $schema', () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validators = new Map<string, ReturnType<typeof ajv.compile>>();
    const failures: string[] = [];
    for (const { id, directory } of components) {
      const file = metaPath(directory, id);
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        failures.push(`${file}: ${(error as Error).message}`);
        continue;
      }
      const schemaPath = resolve(dirname(file), String(value['$schema']));
      let validate = validators.get(schemaPath);
      if (validate === undefined) {
        validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
        validators.set(schemaPath, validate);
      }
      if (!validate(value)) failures.push(`${file}: ${ajv.errorsText(validate.errors)}`);
      const read = readComponentMeta(directory, id);
      if (!read.ok) failures.push(`${file}: ${read.error.reason}`);
    }
    expect(failures).toEqual([]);
    expect([...validators.keys()]).toEqual([COMPONENT_META_SCHEMA_PATH]);
  });

  test('the committed schema is the one manifest.meta.ts derives', () => {
    expect(JSON.parse(readFileSync(COMPONENT_META_SCHEMA_PATH, 'utf8'))).toEqual(
      buildComponentMetaSchema(),
    );
  });

  test('the reader rejects what the schema rejects', () => {
    const valid = {
      $schema: '../../schemas/component-meta.schema.json',
      category: 'action',
      status: 'stable',
      purpose: 'A fixture.',
      tags: [],
      useWhen: [],
      avoidWhen: [{ reason: 'Never.', alternative: 'button' }],
      related: ['button'],
    };
    expect(parseComponentMeta(valid, 'fixture', 'fixture.meta.json').ok).toBe(true);
    for (const invalid of [
      { ...valid, category: 'gadget' },
      { ...valid, status: 'retired' },
      { ...valid, purpose: 'x'.repeat(201) },
      { ...valid, related: ['NotKebab'] },
      { ...valid, avoidWhen: [{ reason: 'Never.', alternative: 'Not Kebab' }] },
      { ...valid, a11y: { keyboard: [{ keys: 'Enter' }] } },
      { ...valid, compound: { parts: [] } },
      { ...valid, unexpected: true },
    ]) {
      const result = parseComponentMeta(invalid, 'fixture', 'fixture.meta.json');
      expect(result.ok).toBe(false);
    }
  });
});

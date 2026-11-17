import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

import Ajv from 'ajv/dist/2020.js';

import {
  buildComponentMetaSchema,
  COMPONENT_META_SCHEMA_PATH,
  COMPONENT_PACKAGE_ROOTS,
  componentsRootOf,
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

  // Six part files outside the component directories (`toolbar/toolbar-group.svelte`, the
  // underscore-private `_radio`, `_timeline-item`, `_tree-expand-all` and `_tree-select-all`)
  // carried @cinder tags too. No generator reads them, but they are authored metadata like the
  // rest, so every meta.json in the four packages is held to the same schema.
  test('every meta.json in the four packages, part files included, validates against its $schema', () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(JSON.parse(readFileSync(COMPONENT_META_SCHEMA_PATH, 'utf8')));
    const files = COMPONENT_PACKAGE_ROOTS.flatMap((root) =>
      readdirSync(componentsRootOf(root), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.meta.json'))
        .map((entry) => join(entry.parentPath, entry.name)),
    );
    expect(files.length).toBeGreaterThan(components.length);
    const failures = files.flatMap((file) => {
      const value: Record<string, unknown> = JSON.parse(readFileSync(file, 'utf8'));
      const schemaPath = resolve(dirname(file), String(value['$schema']));
      if (schemaPath !== COMPONENT_META_SCHEMA_PATH) return [`${file}: $schema is ${schemaPath}`];
      return validate(value) ? [] : [`${file}: ${ajv.errorsText(validate.errors)}`];
    });
    expect(failures).toEqual([]);
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

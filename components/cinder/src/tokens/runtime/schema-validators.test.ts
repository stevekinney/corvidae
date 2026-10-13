import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { fixtureDirectory } from '../../../scripts/tokens/authoring-test-support.ts';
import {
  runtimeDirectory,
  schemaDirectory,
} from '../../../scripts/tokens/generator-configuration.ts';
import { CINDER_BASE } from './base-corpus.ts';
import validateFormat from './format-validator.generated.js';
import validateResolver from './resolver-validator.generated.js';

const fixtures = join(fixtureDirectory, '..');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The pre-extraction approach: compile the vendored schema with Ajv at runtime. */
function referenceValidator(schemaFile: string) {
  const ajv = new Ajv({ allErrors: true, strict: false, logger: false, addUsedSchema: false });
  addFormats(ajv, ['uri-reference', 'json-pointer-uri-fragment']);
  const schema = readJson(join(schemaDirectory, schemaFile));
  if (typeof schema !== 'object' || schema === null) throw new Error('schema');
  return ajv.compile(schema);
}

function documentsIn(directory: string): Array<[string, unknown]> {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.tokens.json'))
    .toSorted()
    .map((name) => [
      `${directory.slice(fixtures.length)}/${name}`,
      readJson(join(directory, name)),
    ]);
}

describe('the generated standalone validators', () => {
  for (const module of ['format-validator', 'resolver-validator']) {
    test(`${module} is self-contained: no eval, no Function constructor, no imports`, () => {
      const source = readFileSync(join(runtimeDirectory, `${module}.generated.js`), 'utf8');
      expect(source.length).toBeGreaterThan(10_000);
      expect(source).not.toMatch(/\bnew Function\b|\beval\(|\brequire\(|^import /m);
    });
  }

  test('agree with a runtime-compiled Ajv validator on every token fixture and bundled document', () => {
    const reference = referenceValidator('dtcg-format-2025-10.json');
    const documents = [
      ...documentsIn(join(fixtures, 'valid')),
      ...documentsIn(join(fixtures, 'invalid')),
      ...documentsIn(fixtureDirectory),
      ...documentsIn(join(fixtureDirectory, 'negative')),
      ...Object.entries(CINDER_BASE.documents),
    ];
    expect(documents.length).toBeGreaterThan(40);
    let rejected = 0;
    for (const [name, document] of documents) {
      const expected = reference(document);
      expect(validateFormat(document), name).toBe(expected);
      if (!expected) {
        rejected++;
        expect(validateFormat.errors, name).toEqual(reference.errors);
      }
    }
    expect(rejected).toBeGreaterThan(15);
  });

  test('agree with a runtime-compiled Ajv validator on resolver documents', () => {
    const reference = referenceValidator('dtcg-resolver-2025-10.json');
    const candidates: unknown[] = [
      CINDER_BASE.resolver,
      readJson(join(fixtureDirectory, 'profile.resolver.json')),
      readJson(join(fixtureDirectory, 'negative', 'unknown-set.resolver.json')),
      { version: '2025.10', sets: [], modifiers: [], resolutionOrder: [] },
      { version: '2025.10' },
      'resolver',
    ];
    for (const document of candidates) {
      expect(validateResolver(document)).toBe(reference(document));
      if (!reference(document)) expect(validateResolver.errors).toEqual(reference.errors);
    }
    expect(validateResolver(CINDER_BASE.resolver)).toBe(true);
  });

  test('reject strokeStyle none and hidden on the schema alone', () => {
    for (const value of ['none', 'hidden']) {
      expect(validateFormat({ s: { $type: 'strokeStyle', $value: value } })).toBe(false);
    }
    expect(validateFormat({ s: { $type: 'strokeStyle', $value: 'solid' } })).toBe(true);
  });
});

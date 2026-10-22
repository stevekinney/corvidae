/**
 * Tests for the A2UI catalog generator: the failures it must refuse to paper
 * over (a listed component with no schema or no accessible name), validation
 * against the vendored A2UI v0.9.1 schemas, the integrity of those vendored
 * files, and drift between the checked-in catalog and Cinder's schemas.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'bun:test';

import {
  A2UI_LABEL_PROPERTY,
  type A2uiCatalog,
  buildA2uiCatalog,
  CATALOG_PATH,
  type CatalogInputs,
  CINDER_A2UI_CATALOG_ID,
  createA2uiMessageValidator,
  readCatalogInputs,
  readVendoredSchemas,
  validateA2uiCatalog,
  VENDORED_DIRECTORY,
  type VendoredSchemas,
} from './generate-a2ui-catalog.ts';
import { parseJsonFile } from './lib/read-json-file.ts';

function syntheticInputs(overrides: Partial<CatalogInputs> = {}): CatalogInputs {
  return {
    allowlist: ['meter'],
    schemas: {
      meter: {
        properties: {
          ariaLabel: { type: 'string', description: 'Names the meter.' },
          value: { type: 'number' },
          size: { enum: ['sm', 'md'] },
          class: { type: 'string' },
          id: { type: 'string' },
          onchange: { type: 'string' },
          'aria-describedby': { type: 'string' },
          items: { type: 'array' },
        },
        required: ['value'],
      },
    },
    components: { meter: { name: 'Meter', purpose: 'Shows a measurement.' } },
    ...overrides,
  };
}

let vendored: VendoredSchemas;
let inputs: CatalogInputs;
let catalog: A2uiCatalog;

beforeAll(async () => {
  vendored = await readVendoredSchemas();
  inputs = await readCatalogInputs();
  catalog = buildA2uiCatalog(inputs);
});

describe('buildA2uiCatalog', () => {
  it('fails when an allowlisted component has no schema', () => {
    expect(() => buildA2uiCatalog(syntheticInputs({ schemas: {} }))).toThrow(
      'meter: allowlisted component has no *.schema.json',
    );
  });

  it('fails when an allowlisted component has no accessible-name property', () => {
    const base = syntheticInputs();
    const meter = base.schemas['meter'];
    if (meter === undefined) throw new Error('fixture has no meter');
    const { ariaLabel: _ariaLabel, ...unnamed } = meter.properties;
    expect(() =>
      buildA2uiCatalog({ ...base, schemas: { meter: { ...meter, properties: unnamed } } }),
    ).toThrow('Meter (meter): schema has no accessible-name property');
  });

  it('fails when an allowlisted component is listed twice', () => {
    expect(() => buildA2uiCatalog(syntheticInputs({ allowlist: ['meter', 'meter'] }))).toThrow(
      'meter: listed more than once in the allowlist',
    );
  });

  it('maps the accessible name to a required label and drops properties with ambient authority', () => {
    const entry = buildA2uiCatalog(syntheticInputs()).components['Meter'];
    const allOf = entry?.['allOf'] as Array<{
      properties?: Record<string, unknown>;
      required?: string[];
    }>;
    const own = allOf[1];

    expect(Object.keys(own?.properties ?? {}).toSorted()).toEqual([
      'component',
      A2UI_LABEL_PROPERTY,
      'size',
      'value',
    ]);
    expect(own?.required).toEqual(['component', A2UI_LABEL_PROPERTY, 'value']);
  });

  it('emits the catalog document form A2UI requires of every catalog', () => {
    expect(catalog.$id).toBe(CINDER_A2UI_CATALOG_ID);
    expect(catalog.catalogId).toBe(CINDER_A2UI_CATALOG_ID);
    expect(Object.keys(catalog.$defs).toSorted()).toEqual(['anyComponent', 'anyFunction', 'theme']);
    expect(catalog.$defs.anyComponent['oneOf']).toEqual(
      Object.keys(catalog.components).map((name) => ({ $ref: `#/components/${name}` })),
    );
  });

  it('gives every entry in the real catalog a required label', () => {
    expect(Object.keys(catalog.components)).toHaveLength(inputs.allowlist.length);
    for (const entry of Object.values(catalog.components)) {
      const allOf = entry['allOf'] as Array<{ required?: string[] }>;
      expect(allOf[1]?.required).toContain(A2UI_LABEL_PROPERTY);
    }
  });
});

describe('validateA2uiCatalog', () => {
  it('accepts the generated catalog', () => {
    expect(validateA2uiCatalog(catalog, vendored)).toEqual([]);
  });

  it('rejects a catalog whose $id and catalogId differ', () => {
    expect(
      validateA2uiCatalog({ ...catalog, $id: 'https://example.test/other' }, vendored),
    ).toContain('(root): $id and catalogId must be the same URI');
  });

  it('rejects a component entry that is not a schema', () => {
    const broken = { ...catalog, components: { ...catalog.components, Broken: { type: 'nope' } } };
    expect(validateA2uiCatalog(broken, vendored).join('\n')).toContain('data/components/Broken');
  });
});

describe('A2UI messages against the Cinder catalog', () => {
  const surfaceId = 'cinder-surface';

  it('accepts a surface built from Cinder components', () => {
    const validate = createA2uiMessageValidator(catalog, vendored);

    expect(
      validate({ version: 'v0.9.1', createSurface: { surfaceId, catalogId: catalog.catalogId } }),
    ).toEqual([]);
    expect(
      validate({
        version: 'v0.9.1',
        updateComponents: {
          surfaceId,
          components: [
            { id: 'root', component: 'Meter', label: 'Disk usage', value: { path: '/disk' } },
            { id: 'done', component: 'Checkbox', label: 'Done', checked: true },
          ],
        },
      }),
    ).toEqual([]);
  });

  it('rejects a component the catalog does not list, and one without its label', () => {
    const validate = createA2uiMessageValidator(catalog, vendored);
    const update = (component: Record<string, unknown>) => ({
      version: 'v0.9.1',
      updateComponents: { surfaceId, components: [{ id: 'root', ...component }] },
    });

    expect(validate(update({ component: 'Text', text: 'hello' }))).not.toEqual([]);
    expect(validate(update({ component: 'Meter', value: 1 }))).not.toEqual([]);
    expect(validate(update({ component: 'Meter', label: 'Disk', class: 'x' }))).not.toEqual([]);
  });
});

describe('vendored A2UI schemas', () => {
  it('match the SHA-256 digests recorded in PROVENANCE.json', () => {
    const provenance = parseJsonFile<{
      commit: string;
      files: Record<string, { sha256: string }>;
    }>(readFileSync(join(VENDORED_DIRECTORY, 'PROVENANCE.json'), 'utf8'));

    expect(provenance.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(provenance.files).toSorted()).toEqual([
      'client_capabilities.json',
      'common_types.json',
      'server_to_client.json',
    ]);
    for (const [name, { sha256 }] of Object.entries(provenance.files)) {
      const digest = createHash('sha256')
        .update(readFileSync(join(VENDORED_DIRECTORY, name)))
        .digest('hex');
      expect(`${name} ${digest}`).toBe(`${name} ${sha256}`);
    }
  });
});

// The tests run under the `browser` export condition, where `prettier` resolves
// to its standalone build, so they compare the catalog's content and leave its
// formatting to `format:check`. `bun run a2ui-catalog:check` compares the bytes.
describe('a2ui-catalog.json', () => {
  const committed = (): A2uiCatalog =>
    parseJsonFile<A2uiCatalog>(readFileSync(CATALOG_PATH, 'utf8'));

  it('is current with the Cinder schemas (run `bun run a2ui-catalog:generate` to fix)', () => {
    expect(buildA2uiCatalog(inputs)).toEqual(committed());
  });

  it('would drift when a listed component schema changes', () => {
    const meter = inputs.schemas['meter'];
    if (meter === undefined) throw new Error('the real allowlist no longer lists meter');
    const changed = buildA2uiCatalog({
      ...inputs,
      schemas: {
        ...inputs.schemas,
        meter: { ...meter, properties: { ...meter.properties, extra: { type: 'boolean' } } },
      },
    });

    expect(changed).not.toEqual(committed());
  });
});

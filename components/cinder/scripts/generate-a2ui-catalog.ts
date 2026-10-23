/**
 * Builds and writes `components/cinder/a2ui-catalog.json`, Cinder's opt-in A2UI
 * catalog: a projection of an explicit allowlist of Cinder components, taken
 * from their generated `*.schema.json` files and `components.json`.
 *
 * Usage:
 *   bun run scripts/generate-a2ui-catalog.ts           # write a2ui-catalog.json
 *   bun run scripts/generate-a2ui-catalog.ts --check   # diff against the committed file; non-zero on drift
 *
 * The catalog has the form A2UI v0.9.1 requires of every catalog: a JSON Schema
 * document whose `$id` and `catalogId` are the same URI, with its components
 * under `components` and the `theme`, `anyComponent`, and `anyFunction`
 * definitions that A2UI's message schema reaches through its `catalog.json`
 * placeholder.
 *
 * The generator fails loudly (and writes nothing) when a listed component has no
 * schema, has no accessible-name property, or the result does not validate
 * against the vendored A2UI v0.9.1 schemas (see `scripts/a2ui/PROVENANCE.json`).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import addFormats from 'ajv-formats';
import Ajv, { type ValidateFunction } from 'ajv/dist/2020.js';
import * as prettier from 'prettier';

import type { Manifest } from './generate-manifest.ts';
import { assertPrettierResolvesToRoot } from './lib/prettier-resolution.ts';
import { readJsonFile } from './lib/read-json-file.ts';

// ---------------------------------------------------------------------------
// Public types and constants
// ---------------------------------------------------------------------------

/**
 * The catalog id Cinder advertises, which is also the catalog document's `$id`.
 * One-way door: clients list this string in `supportedCatalogIds`, so it must
 * not change casually.
 *
 * - `cinder.website` is Cinder's site.
 * - `v0_9_1` is the pinned A2UI specification version (upstream's path style).
 * - `v1` is the Cinder catalog revision. Bump it on any breaking change to a
 *   listed entry (a removed or retyped property, a removed component).
 */
export const CINDER_A2UI_CATALOG_ID =
  'https://cinder.website/a2ui/v0_9_1/catalogs/cinder/v1/catalog.json';

/**
 * The `$id` of the vendored A2UI common types, which every entry references.
 * Upstream keeps the `v0_9` path in the `$id` of its v0.9.1 schemas, so this is
 * the v0.9.1 file despite the name.
 */
export const A2UI_COMMON_TYPES_ID = 'https://a2ui.org/specification/v0_9/common_types.json';

/**
 * The URI A2UI's schemas resolve their `catalog.json` placeholder against. A
 * validator maps it to the catalog in use, here Cinder's.
 */
export const A2UI_CATALOG_PLACEHOLDER_ID = 'https://a2ui.org/specification/v0_9/catalog.json';

/**
 * Cinder properties that never reach the catalog. Model-generated UI must not
 * receive ambient authority: styling hooks (`class`, `style`), DOM identity and
 * form association (`id`, `form`, `name`), anything that fetches or navigates
 * (`href`, `src`), and raw markup (`html`). Event handlers (`on*`, either
 * case, since Svelte's are lowercase), ARIA references to other elements
 * ({@link ARIA_REFERENCE_PROPERTIES}), and `data-*` attributes are dropped by
 * pattern (see {@link isExcludedProperty}), and anything under a schema's
 * `metadata.unsupportedProps` is dropped too.
 */
export const EXCLUDED_CINDER_PROPERTIES: ReadonlySet<string> = new Set([
  'class',
  'style',
  'id',
  'form',
  'name',
  'href',
  'src',
  'html',
  'groupClassName',
]);

/**
 * Cinder properties that can carry a component's accessible name, in
 * precedence order. The first one a schema declares becomes the A2UI `label`.
 * A visible `label` wins, so a component keeps its visible label; a component
 * whose `label` is something else is listed in {@link ACCESSIBLE_NAME_OVERRIDES}.
 */
export const ACCESSIBLE_NAME_SOURCES: readonly string[] = [
  'label',
  'ariaLabel',
  'aria-label',
  'alt',
  'title',
];

/**
 * Components whose accessible name is not the first source they declare.
 * Progress's `label` is its `aria-valuetext`, so its name is `ariaLabel`.
 */
export const ACCESSIBLE_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  progress: 'ariaLabel',
};

/**
 * Per-component decisions the name-based rules below cannot make, applied
 * before them: a string maps the Cinder property to that A2UI property, and
 * `null` drops it. Every one is a reviewed exception:
 *
 * - Progress's `label` and Meter's `ariaValueText` are `aria-valuetext`, not a
 *   name, so both map to `valueText`.
 * - Toggle's `value` is submitted only with `name`, which the catalog excludes,
 *   so on its own it does nothing.
 */
export const PROPERTY_DECISIONS: Readonly<Record<string, Readonly<Record<string, string | null>>>> =
  {
    meter: { ariaValueText: 'valueText' },
    progress: { label: 'valueText' },
    toggle: { value: null },
  };

/**
 * ARIA properties that name or describe a component by reference to other
 * elements, which an agent's message cannot point at. They are dropped; any
 * other ARIA property must have a {@link PROPERTY_DECISIONS} entry, so a
 * property that carries content is never dropped by its name alone.
 */
export const ARIA_REFERENCE_PROPERTIES: ReadonlySet<string> = new Set([
  'ariaLabelledby',
  'aria-labelledby',
  'ariaDescribedby',
  'aria-describedby',
]);

/** The A2UI property that carries the accessible name on every entry. */
export const A2UI_LABEL_PROPERTY = 'label';

/** A plain JSON object. */
export type JsonObject = { [key: string]: unknown };

/** The slice of a Cinder `*.schema.json` this generator reads. */
export type CinderSchema = {
  properties: Record<string, JsonObject>;
  required?: string[];
  metadata?: { unsupportedProps?: Array<{ name: string; required?: boolean }> };
};

/** The manifest fields this generator reads for one component. */
export type CatalogComponentInfo = { name: string; purpose: string };

/** The A2UI catalog document this script emits. */
export type A2uiCatalog = {
  $schema: string;
  $id: string;
  title: string;
  description: string;
  catalogId: string;
  components: Record<string, JsonObject>;
  functions: Record<string, JsonObject>;
  $defs: { theme: JsonObject; anyComponent: JsonObject; anyFunction: JsonObject };
};

/** Everything {@link buildA2uiCatalog} needs, in memory. */
export type CatalogInputs = {
  /** Kebab-case component ids to project. */
  allowlist: readonly string[];
  /** Cinder schemas keyed by component id; a missing key means "no schema". */
  schemas: Readonly<Record<string, CinderSchema | undefined>>;
  /** Manifest data keyed by component id. */
  components: Readonly<Record<string, CatalogComponentInfo | undefined>>;
};

/** The vendored A2UI schemas, parsed. */
export type VendoredSchemas = {
  clientCapabilities: JsonObject;
  commonTypes: JsonObject;
  serverToClient: JsonObject;
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = join(import.meta.dir, '..');

/** Absolute path of the checked-in catalog. */
export const CATALOG_PATH = join(PACKAGE_ROOT, 'a2ui-catalog.json');
/** Absolute path of the checked-in allowlist. */
export const ALLOWLIST_PATH = join(import.meta.dir, 'a2ui-catalog-allowlist.json');
/** Absolute path of the directory holding the vendored A2UI schemas. */
export const VENDORED_DIRECTORY = join(import.meta.dir, 'a2ui');

const MANIFEST_PATH = join(PACKAGE_ROOT, 'components.json');

// ---------------------------------------------------------------------------
// Property mapping
// ---------------------------------------------------------------------------

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for properties the catalog never exposes (see {@link EXCLUDED_CINDER_PROPERTIES}). */
export function isExcludedProperty(name: string): boolean {
  return (
    EXCLUDED_CINDER_PROPERTIES.has(name) ||
    /^on[a-zA-Z]/.test(name) ||
    ARIA_REFERENCE_PROPERTIES.has(name) ||
    name.startsWith('data-')
  );
}

function dynamicReference(typeName: string, source: JsonObject): JsonObject {
  const entry: JsonObject = { $ref: `${A2UI_COMMON_TYPES_ID}#/$defs/${typeName}` };
  if (typeof source['description'] === 'string') entry['description'] = source['description'];
  return entry;
}

/**
 * Map one Cinder property schema to its A2UI form, or `undefined` when the
 * shape has no A2UI mapping (objects, arrays, unions, non-string enums).
 * Strings, numbers, and booleans become A2UI's dynamic types, so an agent can
 * bind them to the surface's data model as well as set them literally.
 */
export function mapProperty(source: JsonObject): JsonObject | undefined {
  // A nullable scalar (`number | null`) maps as its scalar: an agent leaves it
  // unset rather than sending null.
  const anyOf = source['anyOf'];
  if (Array.isArray(anyOf)) {
    const scalars = anyOf.filter((option) => !(isJsonObject(option) && option['type'] === 'null'));
    const [scalar] = scalars;
    if (scalars.length !== 1 || !isJsonObject(scalar) || scalars.length === anyOf.length) {
      return undefined;
    }
    const description = source['description'];
    return mapProperty(typeof description === 'string' ? { ...scalar, description } : scalar);
  }
  if (Array.isArray(source['enum'])) {
    if (!source['enum'].every((value) => typeof value === 'string')) return undefined;
    const entry: JsonObject = { type: 'string' };
    if (typeof source['description'] === 'string') entry['description'] = source['description'];
    entry['enum'] = source['enum'];
    if (typeof source['default'] === 'string') entry['default'] = source['default'];
    return entry;
  }
  switch (source['type']) {
    case 'string':
      return dynamicReference('DynamicString', source);
    case 'number':
    case 'integer':
      return dynamicReference('DynamicNumber', source);
    case 'boolean':
      return dynamicReference('DynamicBoolean', source);
    default:
      return undefined;
  }
}

/** The Cinder property that supplies a schema's accessible name, if any. */
export function findAccessibleNameSource(
  properties: Readonly<Record<string, JsonObject>>,
  componentId?: string,
): string | undefined {
  const override = componentId === undefined ? undefined : ACCESSIBLE_NAME_OVERRIDES[componentId];
  if (override !== undefined && override in properties) return override;
  return ACCESSIBLE_NAME_SOURCES.find((name) => name in properties);
}

type EntryResult = { entry: JsonObject } | { error: string };

function buildEntry(
  id: string,
  schema: CinderSchema,
  info: CatalogComponentInfo,
  nameSource: string,
): EntryResult {
  const unsupportedProps = schema.metadata?.unsupportedProps ?? [];
  const requiredUnsupported = unsupportedProps.filter((prop) => prop.required === true);
  if (requiredUnsupported.length > 0) {
    return {
      error: `${info.name} (${id}): required ${requiredUnsupported.map((prop) => `'${prop.name}'`).join(', ')} has no A2UI mapping, so a catalog entry could not build it`,
    };
  }
  const unsupported = new Set(unsupportedProps.map((prop) => prop.name));
  const nameSchema = schema.properties[nameSource] ?? {};
  if (nameSchema['type'] !== 'string') {
    return {
      error: `${info.name} (${id}): accessible-name property '${nameSource}' is not a string`,
    };
  }

  const decisions = PROPERTY_DECISIONS[id] ?? {};
  const mapped: Record<string, JsonObject> = {};
  for (const [name, source] of Object.entries(schema.properties)) {
    const decision = decisions[name];
    if (decision === null) continue;
    if (decision !== undefined) {
      const property = mapProperty(source);
      if (property === undefined) {
        return { error: `${info.name} (${id}): renamed property '${name}' has no A2UI mapping` };
      }
      property['description'] =
        `${typeof property['description'] === 'string' ? `${property['description']} ` : ''}Maps to Cinder '${name}'.`;
      mapped[decision] = property;
      continue;
    }
    if (name === nameSource) continue;
    if (isExcludedProperty(name) || unsupported.has(name)) continue;
    if (ACCESSIBLE_NAME_SOURCES.includes(name)) continue;
    if (/^aria[-A-Z]/.test(name)) {
      return {
        error: `${info.name} (${id}): ARIA property '${name}' needs a PROPERTY_DECISIONS entry (map it or drop it)`,
      };
    }
    if (name === 'component' || name === 'accessibility') {
      return {
        error: `${info.name} (${id}): property '${name}' collides with an A2UI common property`,
      };
    }
    const property = mapProperty(source);
    if (property !== undefined) mapped[name] = property;
  }

  const label = dynamicReference('DynamicString', nameSchema);
  label['description'] =
    `${typeof nameSchema['description'] === 'string' ? `${nameSchema['description']} ` : ''}Accessible name (Cinder \`${nameSource}\`).`;

  const properties: Record<string, JsonObject> = {
    component: { const: info.name },
    [A2UI_LABEL_PROPERTY]: label,
  };
  for (const name of Object.keys(mapped).toSorted()) properties[name] = mapped[name] ?? {};

  const required = new Set<string>(['component', A2UI_LABEL_PROPERTY]);
  for (const name of schema.required ?? []) {
    const target = decisions[name] ?? name;
    if (target in mapped) required.add(target);
  }

  return {
    entry: {
      type: 'object',
      description: `${info.purpose} A2UI '${A2UI_LABEL_PROPERTY}' maps from Cinder '${nameSource}'.`,
      allOf: [
        { $ref: `${A2UI_COMMON_TYPES_ID}#/$defs/ComponentCommon` },
        { type: 'object', properties, required: [...required].toSorted() },
      ],
      unevaluatedProperties: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Catalog builder (pure)
// ---------------------------------------------------------------------------

/**
 * Build the A2UI catalog from in-memory inputs. Throws one error naming every
 * problem when a listed component lacks a schema, a manifest entry, or an
 * accessible-name property.
 */
export function buildA2uiCatalog(inputs: CatalogInputs): A2uiCatalog {
  const errors: string[] = [];
  const entries: Array<[string, JsonObject]> = [];
  const seen = new Set<string>();

  for (const id of inputs.allowlist) {
    if (seen.has(id)) {
      errors.push(`${id}: listed more than once in the allowlist`);
      continue;
    }
    seen.add(id);
    const schema = inputs.schemas[id];
    const info = inputs.components[id];
    if (schema === undefined) {
      errors.push(`${id}: allowlisted component has no *.schema.json`);
      continue;
    }
    if (info === undefined) {
      errors.push(`${id}: allowlisted component is not in components.json`);
      continue;
    }
    const nameSource = findAccessibleNameSource(schema.properties, id);
    if (nameSource === undefined) {
      errors.push(
        `${info.name} (${id}): schema has no accessible-name property (looked for ${ACCESSIBLE_NAME_SOURCES.join(', ')})`,
      );
      continue;
    }
    const result = buildEntry(id, schema, info, nameSource);
    if ('error' in result) errors.push(result.error);
    else entries.push([info.name, result.entry]);
  }

  if (errors.length > 0) {
    throw new Error(
      `Cannot build the A2UI catalog:\n${errors.map((error) => `  ${error}`).join('\n')}`,
    );
  }

  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: CINDER_A2UI_CATALOG_ID,
    title: 'Cinder A2UI Catalog',
    description:
      "Cinder components an agent may place on an A2UI v0.9.1 surface. Offered only to clients that list this catalog's id in supportedCatalogIds.",
    catalogId: CINDER_A2UI_CATALOG_ID,
    components: Object.fromEntries(entries),
    functions: {},
    $defs: {
      theme: {
        type: 'object',
        description: "Cinder takes no theme from the agent; the host's Cinder theme applies.",
        additionalProperties: false,
      },
      anyComponent: {
        oneOf: entries.map(([name]) => ({ $ref: `#/components/${name}` })),
      },
      anyFunction: {
        description: 'Cinder declares no client functions, so no function call validates.',
        not: {},
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Validation (pure given the vendored schemas)
// ---------------------------------------------------------------------------

/** Read the vendored A2UI schemas from disk. */
export async function readVendoredSchemas(): Promise<VendoredSchemas> {
  return {
    clientCapabilities: await readJsonFile<JsonObject>(
      join(VENDORED_DIRECTORY, 'client_capabilities.json'),
    ),
    commonTypes: await readJsonFile<JsonObject>(join(VENDORED_DIRECTORY, 'common_types.json')),
    serverToClient: await readJsonFile<JsonObject>(
      join(VENDORED_DIRECTORY, 'server_to_client.json'),
    ),
  };
}

function createAjv(catalog: JsonObject, vendored: VendoredSchemas): Ajv {
  // Upstream's schemas use shapes strict mode rejects (an untyped
  // `additionalProperties`, for one), and they are vendored byte-for-byte.
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(vendored.commonTypes);
  ajv.addSchema(vendored.clientCapabilities);
  ajv.addSchema(catalog);
  ajv.addSchema({ ...catalog, $id: A2UI_CATALOG_PLACEHOLDER_ID });
  ajv.addSchema(vendored.serverToClient);
  return ajv;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function schemaProblems(ajv: Ajv, validate: ValidateFunction, value: unknown): string[] {
  if (validate(value)) return [];
  return [ajv.errorsText(validate.errors, { separator: '\n' })];
}

/**
 * Validate a catalog against A2UI v0.9.1. Returns the list of problems (empty
 * when valid). Checks that:
 *
 * - its `$id` and `catalogId` are the same URI, as A2UI requires;
 * - its inline form (`catalogId` and `components`) validates against
 *   `client_capabilities.json#/$defs/Catalog`, the shape a client sends in
 *   `inlineCatalogs`;
 * - it compiles as a JSON Schema document, every component entry included;
 * - A2UI's message schema compiles with this catalog behind its
 *   `catalog.json` placeholder, so messages can be validated against it.
 */
export function validateA2uiCatalog(catalog: unknown, vendored: VendoredSchemas): string[] {
  if (!isJsonObject(catalog)) return ['(root): the catalog is not an object'];
  const problems: string[] = [];
  if (catalog['$id'] !== catalog['catalogId']) {
    problems.push('(root): $id and catalogId must be the same URI');
  }

  let ajv: Ajv;
  try {
    ajv = createAjv(catalog, vendored);
  } catch (error: unknown) {
    return [...problems, `(root): does not load as a schema: ${describeError(error)}`];
  }

  const clientCapabilitiesId = String(vendored.clientCapabilities['$id']);
  const validateInline = ajv.getSchema(`${clientCapabilitiesId}#/$defs/Catalog`);
  if (validateInline === undefined) {
    problems.push('vendored client_capabilities.json has no $defs/Catalog');
  } else {
    const inline = { catalogId: catalog['catalogId'], components: catalog['components'] };
    problems.push(...schemaProblems(ajv, validateInline, inline));
  }

  for (const [id, label] of [
    [String(catalog['$id']), 'the catalog'],
    [String(vendored.serverToClient['$id']), 'the A2UI message schema'],
  ] as const) {
    try {
      if (ajv.getSchema(id) === undefined) problems.push(`${label} did not register`);
    } catch (error: unknown) {
      problems.push(`${label} does not compile: ${describeError(error)}`);
    }
  }
  return problems;
}

/** Throw when {@link validateA2uiCatalog} reports any problem. */
export function assertValidA2uiCatalog(catalog: unknown, vendored: VendoredSchemas): void {
  const problems = validateA2uiCatalog(catalog, vendored);
  if (problems.length > 0) {
    throw new Error(
      `Generated A2UI catalog failed validation:\n${problems.map((problem) => `  ${problem}`).join('\n')}`,
    );
  }
}

/**
 * A validator for A2UI v0.9.1 server-to-client messages whose surfaces use the
 * given catalog: `createSurface`, `updateComponents`, `updateDataModel`, and
 * `deleteSurface`. Returns the problems with one message (empty when valid).
 */
export function createA2uiMessageValidator(
  catalog: A2uiCatalog,
  vendored: VendoredSchemas,
): (message: unknown) => string[] {
  const ajv = createAjv(catalog, vendored);
  const validate = ajv.getSchema(String(vendored.serverToClient['$id']));
  if (validate === undefined) throw new Error('the A2UI message schema did not register');
  return (message) => {
    const problems = schemaProblems(ajv, validate, message);
    // The message schema only checks that a createSurface names some catalog;
    // this validator is for surfaces built from this one.
    const create: unknown =
      typeof message === 'object' && message !== null
        ? Reflect.get(message, 'createSurface')
        : undefined;
    const catalogId: unknown =
      typeof create === 'object' && create !== null ? Reflect.get(create, 'catalogId') : undefined;
    if (catalogId !== undefined && catalogId !== catalog.catalogId) {
      problems.push(
        `createSurface names the catalog ${JSON.stringify(catalogId)}, not "${catalog.catalogId}"`,
      );
    }
    return problems;
  };
}

// ---------------------------------------------------------------------------
// Filesystem entrypoint
// ---------------------------------------------------------------------------

/** Read the allowlist, manifest, and schemas from disk into {@link CatalogInputs}. */
export async function readCatalogInputs(): Promise<CatalogInputs> {
  const allowlist = await readJsonFile<string[]>(ALLOWLIST_PATH);
  const manifest = await readJsonFile<Manifest>(MANIFEST_PATH);
  const components: Record<string, CatalogComponentInfo> = {};
  const schemas: Record<string, CinderSchema | undefined> = {};
  for (const component of manifest.components) {
    components[component.id] = { name: component.name, purpose: component.purpose };
    if (allowlist.includes(component.id)) {
      const schemaPath = join(PACKAGE_ROOT, component.artifacts.schema);
      schemas[component.id] = existsSync(schemaPath)
        ? await readJsonFile<CinderSchema>(schemaPath)
        : undefined;
    }
  }
  return { allowlist, schemas, components };
}

/** Format JSON through Prettier so the file on disk matches the repository's formatting. */
async function formatJson(content: string, filepath: string): Promise<string> {
  assertPrettierResolvesToRoot();
  const options = await prettier.resolveConfig(filepath);
  return prettier.format(content, { ...options, filepath, parser: 'json' });
}

/** Build, validate, and format the catalog from the files on disk. */
export async function renderA2uiCatalog(): Promise<string> {
  const catalog = buildA2uiCatalog(await readCatalogInputs());
  assertValidA2uiCatalog(catalog, await readVendoredSchemas());
  return formatJson(`${JSON.stringify(catalog, null, 2)}\n`, CATALOG_PATH);
}

function reportDiff(committed: string, generated: string): void {
  const committedLines = committed.split('\n');
  const generatedLines = generated.split('\n');
  const maxLines = Math.max(committedLines.length, generatedLines.length);
  let shown = 0;
  for (let index = 0; index < maxLines && shown < 40; index++) {
    if ((committedLines[index] ?? '') !== (generatedLines[index] ?? '')) {
      process.stderr.write(`- ${committedLines[index] ?? ''}\n+ ${generatedLines[index] ?? ''}\n`);
      shown++;
    }
  }
  if (shown >= 40) process.stderr.write('... (diff truncated; run a2ui-catalog:generate)\n');
}

async function main(): Promise<void> {
  const checkMode = process.argv.includes('--check');
  let generated: string;
  try {
    generated = await renderA2uiCatalog();
  } catch (error: unknown) {
    process.stderr.write(
      `a2ui-catalog:${checkMode ? 'check' : 'generate'} - failed:\n${describeError(error)}\n`,
    );
    process.exit(1);
  }

  if (!checkMode) {
    await Bun.write(CATALOG_PATH, generated);
    process.stdout.write('a2ui-catalog:generate - wrote a2ui-catalog.json\n');
    return;
  }

  if (!existsSync(CATALOG_PATH)) {
    process.stderr.write(
      'a2ui-catalog:check - a2ui-catalog.json does not exist. Run `bun run a2ui-catalog:generate`.\n',
    );
    process.exit(1);
  }
  const committed = await Bun.file(CATALOG_PATH).text();
  if (committed === generated) {
    process.stdout.write('a2ui-catalog:check - OK\n');
    return;
  }
  process.stderr.write(
    'a2ui-catalog:check - drift detected. Run `bun run a2ui-catalog:generate` to fix:\n\n',
  );
  reportDiff(committed, generated);
  process.exit(1);
}

if (import.meta.main) {
  await main();
}

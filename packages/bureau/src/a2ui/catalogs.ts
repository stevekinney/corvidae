/**
 * The A2UI catalogs Bureau will emit, and the negotiation that picks one (COR-837).
 *
 * Two catalogs are known and no other is accepted: A2UI's standard basic catalog, which Bureau
 * emits by default, and Cinder's (COR-1310), which Bureau emits only to a client that lists its
 * identifier in `supportedCatalogIds`. Both are vendored files in this directory; an author or a
 * client cannot supply a catalog of its own (`inlineCatalogs` is never read).
 *
 * @experimental A2UI support is pinned to v0.9.1 and may change until a stable A2UI 1.0 review.
 * @module catalogs
 */

import type { SchemaError, SchemaValidator } from '@lostgradient/operative';
import { compileSchema, draft2020, type JsonSchema, type SchemaNode } from 'json-schema-library';

import basicCatalog from './basic-catalog.schema.json' with { type: 'json' };
import cinderCatalog from './cinder-catalog.schema.json' with { type: 'json' };
import commonTypes from './common-types.schema.json' with { type: 'json' };
import serverToClient from './server-to-client.schema.json' with { type: 'json' };

/** The catalog id of A2UI's standard basic catalog, the default. */
export const A2UI_BASIC_CATALOG_ID =
  'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';

/** The catalog id of Cinder's catalog, offered only to a client that lists it. */
export const A2UI_CINDER_CATALOG_ID =
  'https://cinder.website/a2ui/v0_9_1/catalogs/cinder/v1/catalog.json';

/** The A2UI A2A extension of the pinned A2UI release (`v0.9.1`). */
export const A2UI_EXTENSION_URI = 'https://a2ui.org/a2a-extension/a2ui/v0.9.1';

/** The A2UI release Bureau's support is pinned to. */
export const A2UI_SPECIFICATION_VERSION = 'v0.9.1';

/**
 * The status of Bureau's A2UI support. It stays `experimental` until a stable A2UI 1.0 release
 * passes a compatibility review; documentation and capability discovery report it.
 */
export const A2UI_SUPPORT_STATUS = 'experimental';

/** One known catalog, with the validators that hold a surface's content to it. */
export interface A2uiCatalog {
  readonly id: string;
  /** The component names the catalog declares. */
  readonly componentNames: ReadonlySet<string>;
  /** The function names the catalog declares. */
  readonly functionNames: ReadonlySet<string>;
  /**
   * The property names that hold component ids (`child`, `children`, `tabs`, ...), found in the
   * catalog's own schemas by their `ComponentId` and `ChildList` references.
   */
  readonly referenceKeys: ReadonlySet<string>;
  /** A validator for one component, by component name. */
  componentValidator(name: string): A2uiSchemaValidator | undefined;
  /** A validator for one server-to-client message definition, such as `CreateSurfaceMessage`. */
  messageValidator(definition: string): A2uiSchemaValidator;
  /** A validator for `createSurface`'s `theme`. */
  readonly themeValidator: A2uiSchemaValidator;
}

type Schema = Record<string, unknown>;
type A2uiSchemaValidator = SchemaValidator & ((value: unknown) => boolean);

function isRecord(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaDefinition(definitions: Schema, name: string): JsonSchema {
  if (!Object.hasOwn(definitions, name)) throw new Error(`Missing A2UI schema definition: ${name}`);
  return definitions[name] as JsonSchema;
}

/**
 * The A2UI catalog puts schemas below extension keys (`components` and `functions`) rather than
 * JSON Schema's schema-bearing keywords. Give the interpreter conventional locations, and rewrite
 * the catalog's internal pointers to match, without changing the vendored documents themselves.
 */
function normalizedCatalog(schema: Schema): Schema {
  const copy = structuredClone(schema);
  const componentKey = (name: string) => `a2uiComponent${name}`;
  const functionKey = (name: string) => `a2uiFunction${name}`;
  const rewrite = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(rewrite);
      return;
    }
    if (!isRecord(value)) return;
    const reference = value['$ref'];
    if (typeof reference === 'string') {
      value['$ref'] = reference
        .replace(
          /#\/components\/([^/]+)$/u,
          (_match, name: string) => `#/$defs/${componentKey(name)}`,
        )
        .replace(
          /#\/functions\/([^/]+)$/u,
          (_match, name: string) => `#/$defs/${functionKey(name)}`,
        )
        .replace(
          /^https:\/\/a2ui\.org\/specification\/v0_9\/common_types\.json#\/\$defs\/([^/]+)$/u,
          (_match, name: string) => `#/$defs/a2uiCommon${name}`,
        );
    }
    Object.values(value).forEach(rewrite);
  };
  rewrite(copy);
  const definitions = isRecord(copy['$defs']) ? copy['$defs'] : {};
  const components = isRecord(copy['components']) ? copy['components'] : {};
  const functions = isRecord(copy['functions']) ? copy['functions'] : {};
  copy['$defs'] = {
    ...definitions,
    // `$defs` only traverses direct schema entries, so extension containers cannot be registered
    // beneath an extra `components` or `functions` object.
    ...Object.fromEntries(
      Object.entries(components).map(([name, definition]) => [componentKey(name), definition]),
    ),
    ...Object.fromEntries(
      Object.entries(functions).map(([name, definition]) => [functionKey(name), definition]),
    ),
  };
  return copy;
}

function normalizedCommonTypes(): Schema {
  const copy = structuredClone(commonTypes) as Schema;
  const rewrite = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(rewrite);
      return;
    }
    if (!isRecord(value)) return;
    const reference = value['$ref'];
    if (typeof reference === 'string') {
      value['$ref'] = reference
        .replace(/^#\/\$defs\/([^/]+)$/u, (_match, name: string) => `#/$defs/a2uiCommon${name}`)
        .replace(/^catalog\.json#\/\$defs\//u, '#/$defs/');
    }
    Object.values(value).forEach(rewrite);
  };
  rewrite(copy);
  return copy;
}

/** Embed the selected trusted catalog under the server schema's normal `$defs` namespace. */
function serverSchemaWithCatalog(catalog: Schema): Schema {
  const server = structuredClone(serverToClient) as Schema;
  const rewrite = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(rewrite);
      return;
    }
    if (!isRecord(value)) return;
    const reference = value['$ref'];
    if (typeof reference === 'string') {
      value['$ref'] = reference
        .replace(/^catalog\.json#\/\$defs\//u, '#/$defs/')
        .replace(
          /^https:\/\/a2ui\.org\/specification\/v0_9\/common_types\.json#\/\$defs\/([^/]+)$/u,
          (_match, name: string) => `#/$defs/a2uiCommon${name}`,
        );
    }
    Object.values(value).forEach(rewrite);
  };
  rewrite(server);
  const commonDefinitions = normalizedCommonTypes()['$defs'] as Schema;
  server['$defs'] = {
    ...Object.fromEntries(
      Object.entries(commonDefinitions).map(([name, definition]) => [
        `a2uiCommon${name}`,
        definition,
      ]),
    ),
    ...(catalog['$defs'] as Schema),
    ...(server['$defs'] as Schema),
  };
  return server;
}

/** Collects the property names whose subschema reaches a component id or a child list. */
function referenceKeysOf(components: Schema): Set<string> {
  const keys = new Set<string>();
  const reaches = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(reaches);
    if (!isRecord(node)) return false;
    const ref = node['$ref'];
    if (typeof ref === 'string' && /#\/\$defs\/(ComponentId|ChildList)$/u.test(ref)) return true;
    return Object.values(node).some(reaches);
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;
    const properties = node['properties'];
    if (isRecord(properties)) {
      for (const [name, subschema] of Object.entries(properties)) {
        if (reaches(subschema)) keys.add(name);
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(components);
  return keys;
}

function build(schema: Schema): A2uiCatalog {
  const id = schema['catalogId'];
  if (typeof id !== 'string') throw new Error('A catalog must declare a catalogId.');
  const components = schema['components'] as Schema;
  const functions = (schema['functions'] ?? {}) as Schema;
  const catalog = normalizedCatalog(schema);
  const server = serverSchemaWithCatalog(catalog);
  const serverRoot = compileSchema(server, { drafts: [draft2020] });
  const wrap = (node: SchemaNode): A2uiSchemaValidator => {
    let errors: readonly SchemaError[] = [];
    const validate = ((value: unknown): boolean => {
      const result = node.validate(value);
      errors = result.errors.map((error) => {
        const data = error.data as Record<string, unknown>;
        return {
          instancePath: typeof data['pointer'] === 'string' ? data['pointer'].slice(1) : '',
          keyword: (typeof error.code === 'string' ? error.code : 'schema').replace(/-error$/u, ''),
          message: error.message,
          params: data,
        };
      });
      return result.valid;
    }) as A2uiSchemaValidator;
    Object.defineProperty(validate, 'errors', { get: () => errors });
    validate.validate = validate;
    return validate;
  };
  const definitions = server['$defs'] as Schema;
  return {
    id,
    componentNames: new Set(Object.keys(components)),
    functionNames: new Set(Object.keys(functions)),
    referenceKeys: referenceKeysOf(components),
    componentValidator: (name) =>
      Object.hasOwn(components, name)
        ? wrap(serverRoot.compileSchema(schemaDefinition(definitions, `a2uiComponent${name}`)))
        : undefined,
    messageValidator: (definition) =>
      wrap(serverRoot.compileSchema(schemaDefinition(definitions, definition))),
    themeValidator: wrap(serverRoot.compileSchema(schemaDefinition(definitions, 'theme'))),
  };
}

const cache = new Map<string, A2uiCatalog>();

const SOURCES: ReadonlyMap<string, Schema> = new Map([
  [A2UI_BASIC_CATALOG_ID, basicCatalog as Schema],
  [A2UI_CINDER_CATALOG_ID, cinderCatalog as Schema],
]);

/** The ids of every catalog Bureau knows. */
export const A2UI_KNOWN_CATALOG_IDS: readonly string[] = [...SOURCES.keys()];

/** The known catalog with this id, or `undefined` for any other id. Built on first use. */
export function a2uiCatalogOf(id: string): A2uiCatalog | undefined {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  const source = SOURCES.get(id);
  if (source === undefined) return undefined;
  const catalog = build(source);
  cache.set(id, catalog);
  return catalog;
}

/**
 * The `supportedCatalogIds` an A2UI client declared in `a2uiClientCapabilities`, read from its
 * `v0.9` entry. Anything that is not a list of strings reads as no declaration. Inline catalogs
 * are never read.
 *
 * @experimental
 */
export function supportedCatalogIdsOf(capabilities: unknown): readonly string[] | undefined {
  if (!isRecord(capabilities)) return undefined;
  const entry = capabilities['v0.9'];
  if (!isRecord(entry)) return undefined;
  const ids = entry['supportedCatalogIds'];
  if (!Array.isArray(ids) || ids.some((candidate) => typeof candidate !== 'string')) {
    return undefined;
  }
  return ids as string[];
}

/**
 * The catalogs Bureau may emit to a client. With no declaration the basic catalog only; with one,
 * the known catalogs it lists (so a client that lists none of them is offered nothing, and gets a
 * surface's text summary instead).
 *
 * @experimental
 */
export function offeredCatalogIds(supportedCatalogIds: readonly string[] | undefined): string[] {
  if (supportedCatalogIds === undefined) return [A2UI_BASIC_CATALOG_ID];
  return A2UI_KNOWN_CATALOG_IDS.filter((id) => supportedCatalogIds.includes(id));
}

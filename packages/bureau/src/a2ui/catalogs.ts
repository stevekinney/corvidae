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

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';

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

/** The id server-to-client messages use to reach a catalog (`catalog.json#/$defs/...`). */
const CATALOG_ALIAS = 'https://a2ui.org/specification/v0_9/catalog.json';
const SERVER_TO_CLIENT_ID = 'https://a2ui.org/specification/v0_9/server_to_client.json';

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
  componentValidator(name: string): ValidateFunction | undefined;
  /** A validator for one server-to-client message definition, such as `CreateSurfaceMessage`. */
  messageValidator(definition: string): ValidateFunction;
  /** A validator for `createSurface`'s `theme`. */
  readonly themeValidator: ValidateFunction;
}

type Schema = Record<string, unknown>;

function isRecord(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  // Trusted, vendored schemas: unlike an author's, they may use `pattern` and `$id`.
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema(commonTypes);
  ajv.addSchema({ ...schema, $id: CATALOG_ALIAS });
  ajv.addSchema(serverToClient);
  const get = (reference: string): ValidateFunction => {
    const validate = ajv.getSchema(reference);
    if (validate === undefined) throw new Error(`Missing A2UI schema ${reference}.`);
    return validate;
  };
  return {
    id,
    componentNames: new Set(Object.keys(components)),
    functionNames: new Set(Object.keys(functions)),
    referenceKeys: referenceKeysOf(components),
    componentValidator: (name) =>
      Object.hasOwn(components, name) ? get(`${CATALOG_ALIAS}#/components/${name}`) : undefined,
    messageValidator: (definition) => get(`${SERVER_TO_CLIENT_ID}#/$defs/${definition}`),
    themeValidator: get(`${CATALOG_ALIAS}#/$defs/theme`),
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

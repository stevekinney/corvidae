/**
 * Authored component metadata: one `<name>.meta.json` beside each component's `<name>.svelte`, in
 * cinder, chat, editor and terminal.
 *
 * The file is validated twice with the same rules: by its `$schema`
 * (`internal/component-tooling/src/schemas/component-meta.schema.json`, built here from the closed
 * vocabularies in `src/manifest.meta.ts`) while it is edited, and by {@link parseComponentMeta}
 * when a generator or check reads it. The manifest generator reads the manifest fields, the
 * inventory and prose checks read the guidance, and the playground derives its compound families
 * from `compound.parts`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import type { CategoryId, StatusLevel } from '../../src/manifest.meta.ts';
import { categories, statusLevels } from '../../src/manifest.meta.ts';
import {
  componentsRootOf,
  CORE_PACKAGE,
  CORE_ROOT,
  familyPackages,
} from '../discover-component-directories.ts';

export type { CategoryId, StatusLevel };

/** The component tooling's own directory, which holds the schemas. */
const toolingRoot = join(import.meta.dir, '..', '..');
const componentsDirectory = join(toolingRoot, '..', '..', 'components');
const cinderRoot = CORE_ROOT;

/**
 * The four packages whose components carry a `<name>.meta.json`: Cinder's core (which lists its
 * families' components too), chat, editor and terminal.
 */
export const COMPONENT_PACKAGE_ROOTS: readonly string[] = [
  CORE_ROOT,
  ...['chat', 'editor', 'terminal'].map((name) => join(componentsDirectory, name)),
];

/** The schema every `<name>.meta.json` names in its `$schema`. */
export const COMPONENT_META_SCHEMA_PATH = join(
  toolingRoot,
  'src',
  'schemas',
  'component-meta.schema.json',
);

const AVOID_WHEN_REASON_MAX_LENGTH = 140;
const AVOID_WHEN_ALTERNATIVE_MAX_LENGTH = 64;
const USE_WHEN_MAX_LENGTH = 140;
const PURPOSE_MAX_LENGTH = 200;
const A11Y_PATTERN_MAX_LENGTH = 80;
const KEYBOARD_SHORTCUT_HALF_MAX_LENGTH = 120;
const A11Y_NOTE_MAX_LENGTH = 280;
const COMPONENT_ID_PATTERN = '^[a-z][a-z0-9-]*$';

/** One "avoid when" entry: why not, and optionally the component to use instead. */
export type AvoidWhenEntry = {
  /** Why not to use this component in this situation. 1–140 characters. */
  reason: string;
  /** Kebab-case id of the component to use instead, when one applies. */
  alternative?: string;
};

/** One keyboard interaction: a key (or chord) and what it does. */
export type KeyboardShortcut = { keys: string; action: string };

/** Accessibility metadata; absent when nothing was authored. */
export type A11yMetadata = {
  /** WAI-ARIA pattern name this component implements, e.g. `WAI-ARIA Accordion`. */
  pattern?: string;
  /** Keyboard interactions, in author order. */
  keyboard?: KeyboardShortcut[];
  /** Free-form accessibility notes, in author order. */
  notes?: string[];
};

/** The manifest fields of one component, as `components.json` lists them. */
export type ComponentMetadata = {
  /** Kebab-case directory name, the canonical component identifier. */
  id: string;
  category: CategoryId;
  status: StatusLevel;
  /** One-sentence purpose description. 1–200 characters. */
  purpose: string;
  tags: string[];
  useWhen: string[];
  avoidWhen: AvoidWhenEntry[];
  related: string[];
  a11y?: A11yMetadata;
};

/** Everything a `<name>.meta.json` holds: the manifest fields plus authoring-only ones. */
export type ComponentMeta = ComponentMetadata & {
  /** Why no `related` + `avoidWhen` pair applies, naming the nearest alternative. */
  rationale?: string;
  /** For a compound root: its part components, in display order. */
  compound?: { parts: string[] };
  /** A compound part with no standalone use: it is only ever rendered inside its root. */
  composeOnly?: true;
};

/** A structured read failure for one component. */
export type ExtractError = { componentId: string; file: string; reason: string };

/** The result of reading one `<name>.meta.json`. */
export type ExtractResult =
  { ok: true; metadata: ComponentMeta } | { ok: false; error: ExtractError };

/** One component that carries metadata: its id, directory and package root. */
export type MetaComponent = { id: string; directory: string; packageRoot: string };

export { componentsRootOf };

/**
 * Every component directory of a package: a directory under its components root, not `icons/`
 * and not underscore-prefixed, that holds `<name>.svelte`. Sorted by id.
 */
export function discoverMetaComponents(packageRoot: string): MetaComponent[] {
  // Core lists its family packages' components as its own (COR-2085); any other package, its own.
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    name?: unknown;
  };
  const roots =
    manifest.name === CORE_PACKAGE
      ? [packageRoot, ...familyPackages(packageRoot).map(([, root]) => root)]
      : [packageRoot];
  return roots
    .flatMap((owner) => {
      const root = componentsRootOf(owner);
      if (!existsSync(root)) return [];
      return readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.name.startsWith('_') &&
            entry.name !== 'icons' &&
            existsSync(join(root, entry.name, `${entry.name}.svelte`)),
        )
        .map((entry) => ({
          id: entry.name,
          directory: join(root, entry.name),
          packageRoot: owner,
        }));
    })
    .toSorted((left, right) => (left.id < right.id ? -1 : 1));
}

/** The `$schema` value a `<name>.meta.json` in `directory` carries. */
export function metaSchemaReference(directory: string): string {
  return relative(directory, COMPONENT_META_SCHEMA_PATH);
}

/** The JSON Schema of `<name>.meta.json`, derived from `src/manifest.meta.ts`. */
export function buildComponentMetaSchema(): Record<string, unknown> {
  const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
  const componentId = { type: 'string', pattern: COMPONENT_ID_PATTERN };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'component-meta.schema.json',
    title: 'Cinder component metadata',
    description:
      'Authored metadata for one component, in `<name>.meta.json` beside its `<name>.svelte`. Generated from `internal/component-tooling/src/manifest.meta.ts` by `bun internal/component-tooling/scripts/convert-component-metadata.ts`; do not edit.',
    type: 'object',
    additionalProperties: false,
    required: [
      '$schema',
      'category',
      'status',
      'purpose',
      'tags',
      'useWhen',
      'avoidWhen',
      'related',
    ],
    properties: {
      $schema: { type: 'string' },
      category: { enum: Object.keys(categories), description: 'The closed category vocabulary.' },
      status: { enum: Object.keys(statusLevels), description: 'The closed status vocabulary.' },
      purpose: {
        ...text(PURPOSE_MAX_LENGTH),
        description: 'One sentence: what the component is for.',
      },
      tags: { type: 'array', items: { type: 'string', minLength: 1 } },
      useWhen: { type: 'array', items: text(USE_WHEN_MAX_LENGTH) },
      avoidWhen: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['reason'],
          properties: {
            reason: text(AVOID_WHEN_REASON_MAX_LENGTH),
            alternative: { ...componentId, maxLength: AVOID_WHEN_ALTERNATIVE_MAX_LENGTH },
          },
        },
      },
      related: { type: 'array', items: componentId },
      rationale: {
        type: 'string',
        minLength: 1,
        description: 'Why no related + avoidWhen pair applies; name the nearest alternative.',
      },
      a11y: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: {
          pattern: text(A11Y_PATTERN_MAX_LENGTH),
          keyboard: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['keys', 'action'],
              properties: {
                keys: text(KEYBOARD_SHORTCUT_HALF_MAX_LENGTH),
                action: text(KEYBOARD_SHORTCUT_HALF_MAX_LENGTH),
              },
            },
          },
          notes: { type: 'array', minItems: 1, items: text(A11Y_NOTE_MAX_LENGTH) },
        },
      },
      compound: {
        type: 'object',
        additionalProperties: false,
        required: ['parts'],
        description: 'A compound root: the part components composed inside it, in display order.',
        properties: { parts: { type: 'array', minItems: 1, items: componentId } },
      },
      composeOnly: {
        const: true,
        description:
          'A compound part with no standalone use: only ever rendered inside its root, so the playground lists it under the root.',
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCategoryId(value: unknown): value is CategoryId {
  return typeof value === 'string' && Object.hasOwn(categories, value);
}

function isStatusLevel(value: unknown): value is StatusLevel {
  return typeof value === 'string' && Object.hasOwn(statusLevels, value);
}

function stringList(value: unknown, field: string, maxLength?: number): string[] | string {
  if (!Array.isArray(value)) return `${field} must be an array of strings`;
  const list: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return `${field} entries must be non-empty strings`;
    }
    if (maxLength !== undefined && entry.length > maxLength) {
      return `${field} entry exceeds ${maxLength} characters (got ${entry.length}): "${entry.slice(0, 40)}…"`;
    }
    list.push(entry);
  }
  return list;
}

const KEBAB = new RegExp(COMPONENT_ID_PATTERN);
const KNOWN_FIELDS = new Set([
  '$schema',
  'category',
  'status',
  'purpose',
  'tags',
  'useWhen',
  'avoidWhen',
  'related',
  'rationale',
  'a11y',
  'compound',
  'composeOnly',
]);

function parseAvoidWhen(value: unknown): AvoidWhenEntry[] | string {
  if (!Array.isArray(value)) return 'avoidWhen must be an array';
  const entries: AvoidWhenEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry['reason'] !== 'string' || entry['reason'].trim() === '') {
      return 'avoidWhen entries need a non-empty reason';
    }
    const reason = entry['reason'];
    if (reason.length > AVOID_WHEN_REASON_MAX_LENGTH) {
      return `avoidWhen reason exceeds ${AVOID_WHEN_REASON_MAX_LENGTH} characters (got ${reason.length}): "${reason.slice(0, 40)}…"`;
    }
    const alternative = entry['alternative'];
    if (alternative === undefined) {
      entries.push({ reason });
      continue;
    }
    if (
      typeof alternative !== 'string' ||
      !KEBAB.test(alternative) ||
      alternative.length > AVOID_WHEN_ALTERNATIVE_MAX_LENGTH
    ) {
      return `avoidWhen alternative ${JSON.stringify(alternative)} must be a kebab-case component id of at most ${AVOID_WHEN_ALTERNATIVE_MAX_LENGTH} characters`;
    }
    entries.push({ reason, alternative });
  }
  return entries;
}

function parseA11y(value: unknown): A11yMetadata | string {
  if (!isRecord(value)) return 'a11y must be an object';
  const a11y: A11yMetadata = {};
  const pattern = value['pattern'];
  if (pattern !== undefined) {
    if (typeof pattern !== 'string' || pattern.trim() === '')
      return 'a11y.pattern must be non-empty';
    if (pattern.length > A11Y_PATTERN_MAX_LENGTH) {
      return `a11y.pattern exceeds ${A11Y_PATTERN_MAX_LENGTH} characters (got ${pattern.length})`;
    }
    a11y.pattern = pattern;
  }
  const keyboard = value['keyboard'];
  if (keyboard !== undefined) {
    if (!Array.isArray(keyboard)) return 'a11y.keyboard must be an array';
    a11y.keyboard = [];
    for (const shortcut of keyboard) {
      const keys = isRecord(shortcut) ? shortcut['keys'] : undefined;
      const action = isRecord(shortcut) ? shortcut['action'] : undefined;
      if (typeof keys !== 'string' || typeof action !== 'string' || !keys || !action) {
        return 'a11y.keyboard entries need non-empty keys and action';
      }
      if (keys.length > KEYBOARD_SHORTCUT_HALF_MAX_LENGTH) {
        return `a11y.keyboard keys exceed ${KEYBOARD_SHORTCUT_HALF_MAX_LENGTH} characters`;
      }
      if (action.length > KEYBOARD_SHORTCUT_HALF_MAX_LENGTH) {
        return `a11y.keyboard action exceeds ${KEYBOARD_SHORTCUT_HALF_MAX_LENGTH} characters`;
      }
      a11y.keyboard.push({ keys, action });
    }
  }
  if (value['notes'] !== undefined) {
    const notes = stringList(value['notes'], 'a11y.notes', A11Y_NOTE_MAX_LENGTH);
    if (typeof notes === 'string') return notes;
    a11y.notes = notes;
  }
  const unknown = Object.keys(value).filter(
    (key) => !['pattern', 'keyboard', 'notes'].includes(key),
  );
  if (unknown.length > 0) return `a11y has unknown field(s): ${unknown.join(', ')}`;
  if (a11y.keyboard?.length === 0 || a11y.notes?.length === 0 || Object.keys(a11y).length === 0) {
    return 'a11y and its keyboard and notes lists must not be empty';
  }
  return a11y;
}

/** Validate a parsed `<name>.meta.json` with the rules its schema states. */
export function parseComponentMeta(
  value: unknown,
  componentId: string,
  file: string,
): ExtractResult {
  const fail = (reason: string): ExtractResult => ({
    ok: false,
    error: { componentId, file, reason },
  });
  if (!isRecord(value)) return fail('the file must hold a JSON object');
  const unknown = Object.keys(value).filter((key) => !KNOWN_FIELDS.has(key));
  if (unknown.length > 0) return fail(`unknown field(s): ${unknown.join(', ')}`);
  const { category, status, purpose } = value;
  if (!isCategoryId(category)) {
    return fail(
      `unknown category '${String(category)}'. Valid values: ${Object.keys(categories).join(', ')}`,
    );
  }
  if (!isStatusLevel(status)) {
    return fail(
      `unknown status '${String(status)}'. Valid values: ${Object.keys(statusLevels).join(', ')}`,
    );
  }
  if (typeof purpose !== 'string' || purpose.trim() === '')
    return fail('purpose must be non-empty');
  if (purpose.length > PURPOSE_MAX_LENGTH) {
    return fail(
      `purpose exceeds ${PURPOSE_MAX_LENGTH} characters (got ${purpose.length}): "${purpose.slice(0, 40)}…"`,
    );
  }
  const tags = stringList(value['tags'], 'tags');
  if (typeof tags === 'string') return fail(tags);
  const useWhen = stringList(value['useWhen'], 'useWhen', USE_WHEN_MAX_LENGTH);
  if (typeof useWhen === 'string') return fail(useWhen);
  const avoidWhen = parseAvoidWhen(value['avoidWhen']);
  if (typeof avoidWhen === 'string') return fail(avoidWhen);
  const related = stringList(value['related'], 'related');
  if (typeof related === 'string') return fail(related);
  const badRelated = related.find((id) => !KEBAB.test(id));
  if (badRelated !== undefined) return fail(`related id '${badRelated}' must be kebab-case`);
  const metadata: ComponentMeta = {
    id: componentId,
    category,
    status,
    purpose,
    tags,
    useWhen,
    avoidWhen,
    related,
  };
  if (value['a11y'] !== undefined) {
    const a11y = parseA11y(value['a11y']);
    if (typeof a11y === 'string') return fail(a11y);
    metadata.a11y = a11y;
  }
  if (value['rationale'] !== undefined) {
    if (typeof value['rationale'] !== 'string' || value['rationale'].trim() === '') {
      return fail('rationale must be non-empty');
    }
    metadata.rationale = value['rationale'];
  }
  if (value['compound'] !== undefined) {
    const parts = isRecord(value['compound'])
      ? stringList(value['compound']['parts'], 'compound.parts')
      : 'compound must be an object with parts';
    if (typeof parts === 'string') return fail(parts);
    const badPart = parts.find((id) => !KEBAB.test(id));
    if (parts.length === 0 || badPart !== undefined) {
      return fail('compound.parts must list at least one kebab-case component id');
    }
    metadata.compound = { parts };
  }
  if (value['composeOnly'] !== undefined) {
    if (value['composeOnly'] !== true) return fail('composeOnly is either true or absent');
    metadata.composeOnly = true;
  }
  return { ok: true, metadata };
}

/** The `<name>.meta.json` path of a component directory. */
export function metaPath(directory: string, id: string): string {
  return join(directory, `${id}.meta.json`);
}

/** Read and validate one component's `<name>.meta.json`. Never throws. */
export function readComponentMeta(directory: string, id: string): ExtractResult {
  const file = metaPath(directory, id);
  if (!existsSync(file)) {
    return {
      ok: false,
      error: {
        componentId: id,
        file,
        reason: `missing ${relative(dirname(directory), file)}; author it, or move module-script @cinder tags into it with \`bun internal/component-tooling/scripts/convert-component-metadata.ts\``,
      },
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      error: { componentId: id, file, reason: `invalid JSON: ${(error as Error).message}` },
    };
  }
  return parseComponentMeta(value, id, file);
}

/** The manifest fields of a component's metadata, without the authoring-only ones. */
export function manifestFields(meta: ComponentMeta): ComponentMetadata {
  const { rationale: _rationale, compound: _compound, composeOnly: _composeOnly, ...fields } = meta;
  return fields;
}

/**
 * The manifest fields of every component of a package (cinder by default) and the components
 * whose metadata does not read, each in the manifest's id order.
 */
export async function extractAllComponentMetadata(packageRoot: string = cinderRoot): Promise<{
  metadata: ComponentMetadata[];
  errors: ExtractError[];
}> {
  const { metadata, errors } = readPackageMeta(packageRoot);
  return {
    metadata: metadata
      .map(manifestFields)
      .toSorted((left, right) => left.id.localeCompare(right.id)),
    errors: errors.toSorted((left, right) => left.componentId.localeCompare(right.componentId)),
  };
}

/** Read every component of a package; successes and failures separately, each sorted by id. */
export function readPackageMeta(packageRoot: string): {
  metadata: ComponentMeta[];
  errors: ExtractError[];
} {
  const metadata: ComponentMeta[] = [];
  const errors: ExtractError[] = [];
  for (const component of discoverMetaComponents(packageRoot)) {
    const result = readComponentMeta(component.directory, component.id);
    if (result.ok) metadata.push(result.metadata);
    else errors.push(result.error);
  }
  return { metadata, errors };
}

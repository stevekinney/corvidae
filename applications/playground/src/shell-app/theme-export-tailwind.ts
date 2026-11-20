import {
  AUTHORING_CATALOGUE,
  StylesheetError,
  type AuthoringRecord,
  type ContextProperties,
} from '@lostgradient/cinder/tokens/runtime';

const SIZE_NAMES = new Map([
  ['2xs', '2-extra-small'],
  ['xs', 'extra-small'],
  ['sm', 'small'],
  ['md', 'medium'],
  ['lg', 'large'],
  ['xl', 'extra-large'],
  ['2xl', '2-extra-large'],
  ['3xl', '3-extra-large'],
  ['4xl', '4-extra-large'],
  ['5xl', '5-extra-large'],
]);

function typographyAlias(record: AuthoringRecord, suffix: string): string | undefined {
  if (record.path.startsWith('font.size.')) {
    const size = record.path.slice('font.size.'.length);
    return `--text-${SIZE_NAMES.get(size) ?? size}`;
  }
  if (record.path.startsWith('font.')) {
    const types = new Set(record.variants.map(({ provenance }) => provenance.effectiveType.type));
    if (types.size === 1 && types.has('fontFamily')) return `--${suffix}`;
    if (types.size === 1 && types.has('fontWeight')) {
      return `--font-weight-${suffix.slice('font-'.length)}`;
    }
  }
  if (/^(leading|tracking|type-role)\./.test(record.path)) return `--${suffix}`;
  return undefined;
}

function aliasName(record: AuthoringRecord): string | undefined {
  if (record.component !== null) return undefined;
  const suffix = record.cssProperty.slice('--cinder-'.length);
  switch (record.category) {
    case 'color':
      return `--color-${suffix}`;
    case 'typography':
      return typographyAlias(record, suffix);
    case 'spacing':
      return `--spacing-${suffix.replace(/^(space|gap|pad)-/, '')}`;
    case 'radius':
    case 'shadow':
      return `--${record.category}-${record.path.replace(/^(radius|shadow)\./, '').replaceAll('.', '-')}`;
    default:
      return undefined;
  }
}

/** Tailwind v4 utilities read the Cinder properties in the scope where the utility is used. */
export function renderTailwindAliases(maps: ContextProperties): string {
  const aliases = new Map<string, string>();
  const contexts = Object.values(maps);
  for (const record of AUTHORING_CATALOGUE.records) {
    const name = aliasName(record);
    if (name === undefined) continue;
    if (aliases.has(name)) throw new StylesheetError(`Duplicate Tailwind alias ${name}.`);
    if (!contexts.every((properties) => Object.hasOwn(properties, record.cssProperty))) {
      throw new StylesheetError(
        `The Tailwind alias ${name} requires ${record.cssProperty} in every theme context.`,
      );
    }
    aliases.set(name, record.cssProperty);
  }
  const lines = [...aliases].map(([name, property]) => `  ${name}: var(${property});`).toSorted();
  return ['@theme inline {', ...lines, '}', ''].join('\n');
}

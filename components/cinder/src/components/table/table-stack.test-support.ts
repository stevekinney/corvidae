/**
 * Reads Table's stacked forms out of CSS for tests (COR-2771). The forms live in size container
 * queries whose selectors carry long eligibility predicates, so a test names a rule by its form,
 * the container width it applies below, and the part of its selector after the table.
 */
import { parse, type Rule } from 'postcss';

/** Collapses whitespace the way formatting may vary it, so two spellings of a selector compare. */
export function normalizeSelector(selector: string): string {
  return selector
    .replaceAll('"', "'")
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*,\s*/g, ', ')
    .trim();
}

/** The predicate each form's table selector starts with, in the default scope. */
const FORM_MARKERS = {
  card: ".cinder-table[data-cinder-fit]:not([data-cinder-stack-below]):not(:has(> .cinder-table__body > .cinder-table__row > .cinder-table__cell[data-cinder-controls='']))",
  control:
    ".cinder-table:not([data-cinder-stack-below]):is([data-cinder-fit]:has(> .cinder-table__body > .cinder-table__row > .cinder-table__cell[data-cinder-controls='']), :not([data-cinder-fit]):has(> .cinder-table__body > .cinder-table__row > .cinder-table__cell[data-cinder-controls]))",
} as const;

/** The query a form's rules sit under, by default. */
export const DEFAULT_QUERIES = {
  card: 'cinder-table not (min-width: 26rem)',
  control: 'cinder-table not (min-width: 640px)',
} as const;

/**
 * Declarations of the default-scope rule of `form` whose selector is the form's table followed by
 * `suffix` (`''` for the table itself, `' > .cinder-table__body'`, and so on), inside the form's
 * default container query, and inside `media` when given.
 */
export function stackDeclarations(
  css: string,
  form: keyof typeof FORM_MARKERS,
  suffix: string,
  media?: string,
): Map<string, string> {
  const wanted = normalizeSelector(`${FORM_MARKERS[form]}${suffix}`);
  const found = new Map<string, string>();
  parse(css).walkAtRules('container', (container) => {
    if (normalizeSelector(container.params) !== DEFAULT_QUERIES[form]) return;
    container.walkRules((rule: Rule) => {
      const inMedia =
        rule.parent !== container && rule.parent?.type === 'atrule'
          ? (rule.parent as { params: string }).params
          : undefined;
      if (media !== inMedia) return;
      if (!rule.selectors.map(normalizeSelector).includes(wanted)) return;
      rule.walkDecls((declaration) => void found.set(declaration.prop, declaration.value));
    });
  });
  return found;
}

/** Every rule inside a container query, as `[query, media, selector, declarations]`, in order. */
export function containerRules(css: string): [string, string, string, string][] {
  const rules: [string, string, string, string][] = [];
  parse(css).walkAtRules('container', (container) => {
    container.walkRules((rule: Rule) => {
      const media =
        rule.parent?.type === 'atrule' && rule.parent !== container
          ? (rule.parent as { params: string }).params
          : '';
      const declarations: string[] = [];
      rule.walkDecls(
        (declaration) => void declarations.push(`${declaration.prop}: ${declaration.value}`),
      );
      rules.push([
        normalizeSelector(container.params),
        media,
        normalizeSelector(rule.selector),
        normalizeSelector(declarations.join('; ')),
      ]);
    });
  });
  return rules;
}

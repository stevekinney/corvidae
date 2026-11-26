/**
 * The phone form of Breadcrumbs, as CSS for a `collapseBelow` other than the default. Both forms are
 * in the markup and a viewport query shows one, so the first paint is already the right one. The
 * default 640px lives in `breadcrumbs.css`; a stylesheet cannot read a per-instance length, so any
 * other length gets these same rules in a `<style>` the component renders beside the trail, keyed
 * by that length (`breadcrumbs-phone-form.test.ts` holds the two to the same declarations).
 */

/** The trail's attribute naming the viewport width below which it takes its phone form. */
export const PHONE_BELOW_ATTRIBUTE = 'data-cinder-phone-below';

/**
 * Each phone-form rule as the part of its selector after the trail's own, and its declarations.
 * The ancestors and the "…" item hide with `display: none`, and the back link shows, so the
 * accessibility tree holds one form at a time.
 */
export const PHONE_FORM_RULES: readonly (readonly [selector: string, declarations: string])[] = [
  ['', 'display: flex; align-items: center; min-inline-size: 0;'],
  [' .cinder-breadcrumbs__back', 'display: inline-flex;'],
  [' .cinder-breadcrumbs__item:not(:last-child)', 'display: none;'],
  [
    ' .cinder-breadcrumbs__list',
    'flex: 1 100000 auto; min-inline-size: 3rem; font-size: var(--cinder-text-base);',
  ],
  [' .cinder-breadcrumbs__current', 'font-weight: var(--cinder-font-semibold);'],
];

/** The selector of the trails whose phone form starts below `length`. */
export function phoneFormScope(length: string): string {
  return `.cinder-breadcrumbs[${PHONE_BELOW_ATTRIBUTE}="${length}"]`;
}

/**
 * The phone form's rules for trails that collapse below `length`, a length `readViewportBreakpoint`
 * has validated, in Cinder's component layer so they cascade as `breadcrumbs.css` does. The query
 * is written without `<`, which server rendering escapes in a `<style>` element's text.
 */
export function phoneFormStyle(length: string): string {
  const scope = phoneFormScope(length);
  const rules = PHONE_FORM_RULES.map(
    ([selector, declarations]) => `${scope}${selector} { ${declarations} }`,
  ).join(' ');
  return `@layer cinder.components { @media not all and (min-width: ${length}) { ${rules} } }`;
}

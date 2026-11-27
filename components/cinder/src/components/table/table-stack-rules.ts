/**
 * The stacked forms of Table, chosen in CSS by the width of the table's own container (COR-2771),
 * so the server's HTML paints the right form before any script runs.
 *
 * A table can stack in two forms:
 * - the control layout, for a table whose cells hold controls: each row a card, its controls on a
 *   line of their own beneath the name;
 * - the card form, for a `fit` table with no control that fills its cell: flat rows in the phone
 *   shape of a stacked list item.
 *
 * Which form a table may take is read from its server HTML (`data-cinder-fit`, and each cell's
 * `data-cinder-controls`), and when is a size container query on `.cinder-table-container`, named
 * `cinder-table`. A container query cannot read a length from a prop, so `table.css` holds the rules
 * for the default lengths (26rem for the card form, 640px for the control layout) and for an
 * explicit `stackBelow="640px"` (DataTable's default), generated from these lists by
 * `scripts/generate-table-stack-css.ts`. Any other `stackBelow` gets the same rules in a `<style>`
 * Table renders beside the table, keyed by that length (`stackStyle`). `table-stack-rules.test.ts`
 * holds `table.css` to this module.
 *
 * Each rule is a selector template and its declarations. In a template `&` is the table that takes
 * the form and `@scroll` the scroll box around such a table.
 */

/** A rule of a stacked form: selector templates, declarations, and an optional media condition. */
export type StackRule = {
  readonly selectors: readonly string[];
  readonly declarations: string;
  readonly media?: string;
};

/** A body cell that holds a control that fills its cell. */
const FILL_CONTROL = ".cinder-table__cell[data-cinder-controls='']";
/** A body cell that holds any control. */
const ANY_CONTROL = '.cinder-table__cell[data-cinder-controls]';

function bodyHas(cell: string): string {
  return `:has(> .cinder-table__body > .cinder-table__row > ${cell})`;
}

/**
 * The rules both forms share: the table leaves the table layout, the header leaves the layout but
 * stays in the accessibility tree, and each body row is a card. Declared in this order after the
 * density, selection, alignment and sticky-header rules, so they win at equal specificity.
 */
export const STACKED_RULES: readonly StackRule[] = [
  { selectors: ['&'], declarations: 'display: block; position: relative;' },
  { selectors: ['.cinder-table-scroll > &'], declarations: 'flex: 1 1 auto; min-inline-size: 0;' },
  { selectors: ['& > .cinder-table__body'], declarations: 'display: block;' },
  {
    selectors: ['& > .cinder-table__header'],
    declarations:
      'position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); clip-path: inset(50%); white-space: nowrap; border: 0;',
  },
  {
    selectors: ['& .cinder-table__body .cinder-table__row'],
    declarations:
      'display: flex; flex-wrap: wrap; align-items: center; column-gap: var(--cinder-space-3); row-gap: var(--cinder-space-2); padding-block: var(--cinder-space-3); padding-inline: var(--cinder-space-3); border-bottom: var(--cinder-border-width) solid var(--cinder-border-muted);',
  },
  {
    selectors: ['& .cinder-table__body .cinder-table__row:last-child'],
    declarations: 'border-bottom: 0;',
  },
  // The break between the first line and the controls: a full-width, zero-height flex item that
  // sits between the two groups of cells by `order`.
  {
    selectors: [
      '& .cinder-table__body .cinder-table__row:has(> .cinder-table__cell[data-cinder-controls])::before',
    ],
    declarations:
      "content: ''; order: 1; flex-basis: 100%; block-size: 0; margin-block-end: calc(var(--cinder-space-2) * -1);",
  },
  {
    selectors: ['& .cinder-table__body .cinder-table__cell'],
    declarations:
      'display: block; width: auto; min-inline-size: 0; padding: 0; border-bottom: 0; text-align: start; overflow-wrap: break-word;',
  },
  // A column's sizing (COR-2769) belongs to the table layout; a stacked cell wraps like any other.
  {
    selectors: ['& .cinder-table__body .cinder-table__cell[data-cinder-sizing]'],
    declarations: 'inline-size: auto; max-inline-size: none; white-space: normal;',
  },
  // A cell's detail (an identifier, a description) is not drawn on a card: line one is the name and
  // its facts (row 40a).
  { selectors: ['& .cinder-table__cell-detail'], declarations: 'display: none;' },
  // The first cell without a control is the name and takes the line; any other is a muted word (a
  // risk, a kind) at the end of it.
  {
    selectors: ['& .cinder-table__body .cinder-table__cell:not([data-cinder-controls])'],
    declarations: 'order: 0; flex: 1 1 0;',
  },
  {
    selectors: [
      '& .cinder-table__body .cinder-table__cell:not([data-cinder-controls]) ~ .cinder-table__cell:not([data-cinder-controls])',
    ],
    declarations: 'flex: 0 1 auto; text-align: end; color: var(--cinder-text-muted);',
  },
  {
    selectors: ['& .cinder-table__body .cinder-table__cell[data-cinder-controls]'],
    declarations:
      'order: 2; display: flex; align-items: center; flex: 1 1 0; min-block-size: 2.75rem; min-inline-size: 0;',
  },
  {
    selectors: ['& .cinder-table__body .cinder-table__cell[data-cinder-controls] > *'],
    declarations: 'min-block-size: 2.75rem;',
  },
  // A select, input or button in a card is a touch target too: the control itself is as tall as its
  // row, not just the wrapper around it (row 40a).
  {
    selectors: [
      '& .cinder-table__body .cinder-table__cell[data-cinder-controls] :is(.cinder-select, .cinder-input, .cinder-button)',
    ],
    declarations: 'min-block-size: 2.75rem;',
  },
  // A control that keeps its own size: a checkbox or switch, with its column's label after it.
  {
    selectors: ["& .cinder-table__body .cinder-table__cell[data-cinder-controls='fit']"],
    declarations: 'flex: 0 0 auto; gap: var(--cinder-space-2);',
  },
  {
    selectors: ["& .cinder-table__body .cinder-table__cell[data-cinder-controls='fit'] > *"],
    declarations: 'box-sizing: content-box; inline-size: auto; min-block-size: 0;',
  },
  {
    selectors: [
      "& .cinder-table__body .cinder-table__cell[data-cinder-controls='fit'][data-cinder-stack-label]::before",
    ],
    declarations:
      'content: attr(data-cinder-stack-label); order: 1; font-size: var(--cinder-text-sm); color: var(--cinder-text-default);',
  },
  { selectors: ['& .cinder-table__cell-text'], declarations: 'max-inline-size: 100%;' },
  // DataTable's rows that span the table are blocks of their own.
  {
    selectors: [
      '& .cinder-data-table__group-row',
      '& .cinder-data-table__row-message',
      '& .cinder-data-table__footer',
      '& .cinder-data-table__footer > tr',
      '& .cinder-data-table__group-cell',
      '& .cinder-data-table__row-message-cell',
      '& .cinder-data-table__footer-cell',
    ],
    declarations: 'display: block;',
  },
];

/**
 * The card form, declared after the shared rules at the same specificity, so it replaces what they
 * set for the same cells. The rows are not cards inside a box: the scroll box and the table draw no
 * frame, and one hairline divides the rows.
 */
export const CARD_RULES: readonly StackRule[] = [
  // The rows start on the content's leading edge (COR-2760): the scroll box reaches one gutter past
  // that edge and pads it back, so its content edge stays on the page's and the row tint, which
  // reaches into that gutter, stays inside the box's clip. `inline-size: auto` lets the negative
  // margin widen the box instead of leaving its trailing edge a gutter short.
  {
    selectors: ['@scroll'],
    declarations:
      'border: 0; border-radius: 0; background: transparent; --_cinder-scroll-fade-color: var(--cinder-surface-canvas); inline-size: auto; max-inline-size: none; padding-inline-start: var(--cinder-space-3); margin-inline-start: calc(var(--cinder-space-3) * -1);',
  },
  // DataTable's scroll box holds the sort control above the rows, so it stacks them.
  { selectors: ['.cinder-data-table@scroll'], declarations: 'display: block;' },
  // The table draws no frame here, so it does not clip: the row tint reaches past its start.
  {
    selectors: ['&'],
    declarations:
      'background: transparent; overflow: visible; --_cinder-table-fill: transparent; --_cinder-table-stack-label-size: 6.5rem;',
  },
  {
    selectors: ['& .cinder-table__body .cinder-table__row'],
    declarations:
      'position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto auto; column-gap: 0; row-gap: var(--cinder-space-1); align-items: baseline; padding-block: var(--cinder-space-3); padding-inline: 0 var(--cinder-space-2); border-radius: 0; box-shadow: none; isolation: isolate;',
  },
  // No break line: there is no control line to separate.
  {
    selectors: [
      '& .cinder-table__body .cinder-table__row:has(> .cinder-table__cell[data-cinder-controls])::before',
    ],
    declarations: 'content: none;',
  },
  // Every cell is a line across the row, in the order it is written; the parts below move to theirs.
  {
    selectors: ['& .cinder-table__body .cinder-table__cell'],
    declarations:
      'grid-column: 1 / -1; display: flex; column-gap: var(--cinder-space-3); overflow: visible; font-size: var(--cinder-text-sm); color: var(--cinder-text-default); text-align: start;',
  },
  // The control layout puts a cell with no control first by `order`; a field follows the prose.
  {
    selectors: ['& .cinder-table__body .cinder-table__cell:not([data-cinder-controls])'],
    declarations: 'order: 3;',
  },
  {
    selectors: [
      '& .cinder-table__body .cinder-table__cell:not([data-cinder-controls]) ~ .cinder-table__cell:not([data-cinder-controls])',
    ],
    declarations: 'flex: 0 1 auto; text-align: start;',
  },
  // A labelled field: the column's label, muted, in a column of its own, then the value.
  {
    selectors: ['& .cinder-table__body .cinder-table__cell[data-cinder-stack-label]::before'],
    declarations:
      'content: attr(data-cinder-stack-label); flex: 0 0 var(--_cinder-table-stack-label-size); color: var(--cinder-text-muted); font-weight: var(--cinder-font-normal);',
  },
  // A field's value shares the line with its label and wraps inside its own column.
  {
    selectors: ['& .cinder-table__body .cinder-table__cell > *'],
    declarations: 'min-inline-size: 0;',
  },
  // A cell with nothing in it, and its label, are not drawn.
  {
    selectors: ['& .cinder-table__body .cinder-table__cell[data-cinder-stack-empty]'],
    declarations: 'display: none;',
  },
  // The title: line one, at the leading edge.
  {
    selectors: ['& .cinder-table__body .cinder-table__cell[data-cinder-stack-title]'],
    declarations:
      'grid-column: 1; grid-row: 1; order: 0; display: block; min-inline-size: 0; font-size: var(--cinder-text-base); font-weight: var(--cinder-font-semibold); overflow-wrap: break-word;',
  },
  {
    selectors: ['& .cinder-table__body .cinder-table__cell[data-cinder-stack-title]::before'],
    declarations: 'content: none;',
  },
  // The title's detail (an identifier) is one muted line under it; any other cell's stays hidden.
  {
    selectors: ['& .cinder-table__cell[data-cinder-stack-title] .cinder-table__cell-detail'],
    declarations:
      'display: block; overflow: hidden; color: var(--cinder-text-muted); font-size: var(--cinder-text-sm); font-weight: var(--cinder-font-normal); text-overflow: ellipsis; white-space: nowrap;',
  },
  // The end value: line one, at the inline end, on the title's baseline.
  {
    selectors: ["& .cinder-table__body .cinder-table__cell[data-cinder-stack='end']"],
    declarations:
      'grid-column: 2; grid-row: 1; order: 0; display: block; margin-inline-start: var(--cinder-space-3); color: var(--cinder-text-subtle); font-size: var(--cinder-text-xs); font-variant-numeric: tabular-nums; white-space: nowrap;',
  },
  {
    selectors: [
      "& .cinder-table__body .cinder-table__cell[data-cinder-stack='end']::before",
      "& .cinder-table__body .cinder-table__cell[data-cinder-stack='status']::before",
      "& .cinder-table__body .cinder-table__cell[data-cinder-stack='plain']::before",
    ],
    declarations: 'content: none;',
  },
  // The status: starts line two, and its word is never cut.
  {
    selectors: ["& .cinder-table__body .cinder-table__cell[data-cinder-stack='status']"],
    declarations: 'grid-column: 1 / 3; grid-row: 2; order: 0; display: block; white-space: nowrap;',
  },
  // Prose is a muted line with no label.
  {
    selectors: ["& .cinder-table__body .cinder-table__cell[data-cinder-stack='plain']"],
    declarations: 'order: 1; display: block; color: var(--cinder-text-muted);',
  },
  // A control that keeps its size: the trailing edge, across lines one and two, with a 44px hit area.
  {
    selectors: ["& .cinder-table__body .cinder-table__cell[data-cinder-controls='fit']"],
    declarations:
      'grid-column: 3; grid-row: 1 / span 2; order: 0; align-self: center; justify-content: center; min-block-size: 2.75rem; min-inline-size: 2.75rem; margin-inline-start: var(--cinder-space-3); position: relative; z-index: 1;',
  },
  {
    selectors: [
      "& .cinder-table__body .cinder-table__cell[data-cinder-controls='fit'][data-cinder-stack-label]::before",
    ],
    declarations: 'content: none;',
  },
  // A linked title makes the whole row the link: its pseudo-element stretches over the row, above
  // the text and below the controls, and the row's tint wears the focus ring.
  {
    selectors: ['& .cinder-table__cell[data-cinder-stack-title] a::after'],
    declarations: "content: ''; position: absolute; inset: 0;",
  },
  {
    selectors: ['& .cinder-table__cell[data-cinder-stack-title] a:focus-visible'],
    declarations: 'outline: none; box-shadow: none;',
  },
  // The card tint (COR-2760): a card row sits on the content's edge, so its hover, open and current
  // tint and its focus ring are drawn on the row's `::after`, which reaches one gutter past the
  // row's start, behind the row's text (the row isolates). The row itself paints nothing.
  {
    selectors: [
      '& .cinder-table__body .cinder-table__row',
      '& .cinder-table__body .cinder-table__row:is(:hover, [data-cinder-open], [data-cinder-current])',
    ],
    declarations: 'background: transparent;',
  },
  {
    selectors: ['& .cinder-table__body .cinder-table__row::after'],
    declarations:
      "content: ''; position: absolute; inset-block: 0; inset-inline: calc(var(--cinder-space-3) * -1) 0; z-index: -1; border-radius: var(--cinder-radius-control); transition: background var(--cinder-duration-fast) var(--cinder-ease-standard);",
  },
  {
    selectors: ['& .cinder-table__body .cinder-table__row:hover::after'],
    declarations: 'background: var(--_cinder-table-row-hover);',
    media: '(hover: hover)',
  },
  {
    selectors: [
      '& .cinder-table__body .cinder-table__row:is([data-cinder-open], [data-cinder-current])::after',
    ],
    declarations: 'background: color-mix(in oklch, var(--cinder-accent-solid), transparent 92%);',
  },
  // Inset, inside the tint's shape: the scroll box clips at the tint's edges.
  {
    selectors: [
      '& .cinder-table__body .cinder-table__row:has(.cinder-table__cell[data-cinder-stack-title] a:focus-visible)::after',
    ],
    declarations:
      'outline: var(--cinder-ring-width) solid transparent; box-shadow: inset 0 0 0 var(--cinder-ring-width) var(--cinder-ring-color);',
  },
  {
    selectors: [
      '& .cinder-table__body .cinder-table__row:is([data-cinder-open], [data-cinder-current])',
    ],
    declarations: 'outline: none;',
    media: '(forced-colors: active)',
  },
  {
    selectors: [
      '& .cinder-table__body .cinder-table__row:is([data-cinder-open], [data-cinder-current])::after',
    ],
    declarations: 'outline: 1px solid Highlight; outline-offset: -1px;',
    media: '(forced-colors: active)',
  },
];

/** Which `stackBelow` a set of rules answers: the default (none set) or one length. */
type StackScope = { kind: 'default' } | { kind: 'length'; length: string };

function scopeAttribute(scope: StackScope): string {
  return scope.kind === 'default'
    ? ':not([data-cinder-stack-below])'
    : `[data-cinder-stack-below="${scope.length}"]`;
}

/** The tables that take the card form: `fit`, with no control that fills its cell. */
function cardTable(scope: StackScope): string {
  return `.cinder-table[data-cinder-fit]${scopeAttribute(scope)}:not(${bodyHas(FILL_CONTROL)})`;
}

/** The scroll box around a table that takes the card form (`:has` cannot nest, so two of them). */
function cardScroll(scope: StackScope): string {
  return `.cinder-table-scroll:has(> .cinder-table[data-cinder-fit]${scopeAttribute(scope)}):not(:has(> .cinder-table${bodyHas(FILL_CONTROL)}))`;
}

/** The tables that take the control layout: a filling control in a `fit` table, any control otherwise. */
function controlTable(scope: StackScope): string {
  return `.cinder-table${scopeAttribute(scope)}:is([data-cinder-fit]${bodyHas(FILL_CONTROL)}, :not([data-cinder-fit])${bodyHas(ANY_CONTROL)})`;
}

function expand(rules: readonly StackRule[], table: string, scroll: string): string[] {
  return rules.map((rule) => {
    const selector = rule.selectors
      .map((template) => template.replaceAll('@scroll', scroll).replaceAll('&', table))
      .join(', ');
    const block = `${selector} { ${rule.declarations} }`;
    return rule.media === undefined ? block : `@media ${rule.media} { ${block} }`;
  });
}

/**
 * The container query for widths below `length`, written without `<`, which server rendering
 * escapes in a `<style>` element's text.
 */
function belowQuery(length: string): string {
  return `@container cinder-table not (min-width: ${length})`;
}

function block(length: string, rules: readonly string[]): string {
  return `${belowQuery(length)} { ${rules.join(' ')} }`;
}

/** The default lengths, as `table.css` and Table's documentation give them. */
export const CARD_STACK_BELOW = '26rem';
export const CONTROL_STACK_BELOW = '640px';

/**
 * Every stacking rule for one scope. For the default scope the control layout stacks below 640px
 * and the card form below 26rem; for a length, both forms stack below it.
 */
function scopeRules(scope: StackScope): string[] {
  const cardLength = scope.kind === 'default' ? CARD_STACK_BELOW : scope.length;
  const controlLength = scope.kind === 'default' ? CONTROL_STACK_BELOW : scope.length;
  const card = cardTable(scope);
  const control = controlTable(scope);
  return [
    block(controlLength, expand(STACKED_RULES, control, '')),
    block(cardLength, [
      ...expand(STACKED_RULES, card, cardScroll(scope)),
      ...expand(CARD_RULES, card, cardScroll(scope)),
    ]),
  ];
}

/** The rules `table.css` holds: the default lengths, and an explicit 640px (DataTable's default). */
export function stylesheetStackRules(): string {
  return [
    ...scopeRules({ kind: 'default' }),
    ...scopeRules({ kind: 'length', length: CONTROL_STACK_BELOW }),
  ].join('\n');
}

/** Whether `table.css` already holds the rules for `stackBelow`, so no `<style>` is needed. */
export function stylesheetCoversLength(length: string): boolean {
  return length === CONTROL_STACK_BELOW;
}

/**
 * The stacking rules for tables whose `stackBelow` is `length`, a length `readViewportBreakpoint`
 * has validated, in Cinder's component layer so they cascade as `table.css` does.
 */
export function stackStyle(length: string): string {
  return `@layer cinder.components { ${scopeRules({ kind: 'length', length }).join(' ')} }`;
}

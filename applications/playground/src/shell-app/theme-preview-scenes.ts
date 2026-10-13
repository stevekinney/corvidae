/**
 * The theme builder's preview scene manifest.
 *
 * Eight categories, each backed by real Cinder examples from
 * `applications/playground/src/examples/<component>/<scenario>.example.svelte`
 * (`examples: ['button/variants']` names that file). Foundations is a built-in specimen
 * with no example references, and Application composes the Forms, Data, Feedback, and
 * Overlay examples. COR-259's accessibility checks consume `states`: it records, as data,
 * which component states a scene renders, which only an interaction reaches, and which do
 * not apply, so the state board never invents a state the component does not expose.
 *
 * Every id was verified against the example sources the playground discovers; the
 * accompanying test fails when one stops existing. Ids the issue text lists that map to
 * a different file are none: all fourteen exist as written.
 */

export const THEME_PREVIEW_CATEGORIES = [
  'Foundations',
  'Components',
  'Forms',
  'Data',
  'Feedback',
  'Overlay',
  'Charts',
  'Application',
] as const;

export type ThemePreviewCategory = (typeof THEME_PREVIEW_CATEGORIES)[number];

export const THEME_PREVIEW_STATES = [
  'default',
  'hover',
  'focus-visible',
  'active-selected',
  'disabled',
  'invalid',
  'open',
] as const;

export type ThemePreviewState = (typeof THEME_PREVIEW_STATES)[number];

/**
 * How a scene exposes one state. `rendered` means the state is visible without any
 * interaction; `interaction` means a pointer or keyboard action reaches it; and
 * `applicable: false` records why the component or scene has no such state.
 */
export type ThemePreviewStateSupport =
  | { applicable: true; reach: 'rendered' | 'interaction'; note?: string }
  | { applicable: false; reason: string };

export type ThemePreviewScene = {
  /** Stable id, `<category>/<slug>`, lower case. */
  id: string;
  category: ThemePreviewCategory;
  title: string;
  /** Example ids as `<component>/<scenario>`; empty for the built-in Foundations specimen. */
  examples: readonly string[];
  states: Readonly<Record<ThemePreviewState, ThemePreviewStateSupport>>;
};

const rendered = (note?: string): ThemePreviewStateSupport =>
  note === undefined
    ? { applicable: true, reach: 'rendered' }
    : { applicable: true, reach: 'rendered', note };
const interaction = (note?: string): ThemePreviewStateSupport =>
  note === undefined
    ? { applicable: true, reach: 'interaction' }
    : { applicable: true, reach: 'interaction', note };
const notApplicable = (reason: string): ThemePreviewStateSupport => ({ applicable: false, reason });

const NO_INVALID = notApplicable('The component has no invalid state.');
const NO_OVERLAY_OPEN = notApplicable('The scene is not an overlay.');
const NOT_SELECTABLE = notApplicable('The component exposes no selected or active state.');
const NOT_DISABLED_HERE = notApplicable('The example renders no disabled instance.');
const STATIC_SPECIMEN = notApplicable('A static specimen has no interaction state.');
const FEEDBACK_STATIC = notApplicable('Callout is static status content.');

export const THEME_PREVIEW_SCENES: readonly ThemePreviewScene[] = [
  {
    id: 'foundations/specimens',
    category: 'Foundations',
    title: 'Token scales and type specimens',
    examples: [],
    states: {
      default: rendered('Specimens follow the active light or dark and motion context.'),
      hover: STATIC_SPECIMEN,
      'focus-visible': STATIC_SPECIMEN,
      'active-selected': STATIC_SPECIMEN,
      disabled: STATIC_SPECIMEN,
      invalid: STATIC_SPECIMEN,
      open: NO_OVERLAY_OPEN,
    },
  },
  {
    id: 'components/button-variants',
    category: 'Components',
    title: 'Button variants',
    examples: ['button/variants'],
    states: {
      default: rendered(),
      hover: interaction(),
      'focus-visible': interaction(),
      'active-selected': interaction('Pressed state.'),
      disabled: NOT_DISABLED_HERE,
      invalid: NO_INVALID,
      open: NO_OVERLAY_OPEN,
    },
  },
  {
    id: 'components/link-basic',
    category: 'Components',
    title: 'Link',
    examples: ['link/basic'],
    states: {
      default: rendered(),
      hover: interaction(),
      'focus-visible': interaction(),
      'active-selected': NOT_SELECTABLE,
      disabled: NOT_DISABLED_HERE,
      invalid: NO_INVALID,
      open: NO_OVERLAY_OPEN,
    },
  },
  {
    id: 'components/tabs-basic',
    category: 'Components',
    title: 'Tabs',
    examples: ['tabs/basic'],
    states: {
      default: rendered(),
      hover: interaction(),
      'focus-visible': interaction(),
      'active-selected': rendered('The selected tab.'),
      disabled: NOT_DISABLED_HERE,
      invalid: NO_INVALID,
      open: NO_OVERLAY_OPEN,
    },
  },
  {
    id: 'forms/input-basic',
    category: 'Forms',
    title: 'Input',
    examples: ['input/basic'],
    states: {
      default: rendered(),
      hover: interaction(),
      'focus-visible': interaction(),
      'active-selected': NOT_SELECTABLE,
      disabled: NOT_DISABLED_HERE,
      invalid: notApplicable('Invalid appears only on the error scene.'),
      open: NO_OVERLAY_OPEN,
    },
  },
  {
    id: 'forms/input-with-error',
    category: 'Forms',
    title: 'Input with an error',
    examples: ['input/with-error'],
    states: {
      default: notApplicable('The scene renders the invalid state at rest.'),
      hover: interaction(),
      'focus-visible': interaction(),
      'active-selected': NOT_SELECTABLE,
      disabled: NOT_DISABLED_HERE,
      invalid: rendered(),
      open: NO_OVERLAY_OPEN,
    },
  },
  {
    id: 'forms/select-basic',
    category: 'Forms',
    title: 'Select',
    examples: ['select/basic'],
    states: {
      default: rendered(),
      hover: interaction(),
      'focus-visible': interaction(),
      'active-selected': NOT_SELECTABLE,
      disabled: NOT_DISABLED_HERE,
      invalid: notApplicable('Invalid appears only on the error scene.'),
      open: NO_OVERLAY_OPEN,
    },
  },
  {
    id: 'forms/select-with-error',
    category: 'Forms',
    title: 'Select with an error',
    examples: ['select/with-error'],
    states: {
      default: notApplicable('The scene renders the invalid state at rest.'),
      hover: interaction(),
      'focus-visible': interaction(),
      'active-selected': NOT_SELECTABLE,
      disabled: NOT_DISABLED_HERE,
      invalid: rendered(),
      open: NO_OVERLAY_OPEN,
    },
  },
  {
    id: 'forms/checkbox-basic',
    category: 'Forms',
    title: 'Checkbox',
    examples: ['checkbox/basic'],
    states: {
      default: rendered(),
      hover: interaction(),
      'focus-visible': interaction(),
      'active-selected': interaction('Checked state, reached by toggling.'),
      disabled: NOT_DISABLED_HERE,
      invalid: notApplicable('Invalid appears only on the error scene.'),
      open: NO_OVERLAY_OPEN,
    },
  },
  {
    id: 'forms/checkbox-with-error',
    category: 'Forms',
    title: 'Checkbox with an error',
    examples: ['checkbox/with-error'],
    states: {
      default: notApplicable('The scene renders the invalid state at rest.'),
      hover: interaction(),
      'focus-visible': interaction(),
      'active-selected': interaction('Checked state, reached by toggling.'),
      disabled: NOT_DISABLED_HERE,
      invalid: rendered(),
      open: NO_OVERLAY_OPEN,
    },
  },
  {
    id: 'data/table-basic',
    category: 'Data',
    title: 'Table',
    examples: ['table/basic'],
    states: {
      default: rendered(),
      hover: interaction('Row hover.'),
      'focus-visible': notApplicable('The basic table has no focusable cells.'),
      'active-selected': notApplicable('Selection is a separate example (table/selection).'),
      disabled: notApplicable('Table has no disabled state.'),
      invalid: NO_INVALID,
      open: NO_OVERLAY_OPEN,
    },
  },
  {
    id: 'feedback/callout-variants',
    category: 'Feedback',
    title: 'Callout variants',
    examples: ['callout/variants'],
    states: {
      default: rendered('Every status variant is visible.'),
      hover: FEEDBACK_STATIC,
      'focus-visible': FEEDBACK_STATIC,
      'active-selected': FEEDBACK_STATIC,
      disabled: FEEDBACK_STATIC,
      invalid: notApplicable('Danger is a variant, not an invalid state.'),
      open: NO_OVERLAY_OPEN,
    },
  },
  {
    id: 'overlay/modal-with-form',
    category: 'Overlay',
    title: 'Modal with a form',
    examples: ['modal/with-form'],
    states: {
      default: rendered('Closed: the opening button.'),
      hover: interaction(),
      'focus-visible': interaction(),
      'active-selected': notApplicable('Hover and selection do not apply to a dialog.'),
      disabled: NOT_DISABLED_HERE,
      invalid: NO_INVALID,
      open: interaction('Open by activating the trigger; Escape and the backdrop dismiss it.'),
    },
  },
  {
    id: 'overlay/popover-basic',
    category: 'Overlay',
    title: 'Popover',
    examples: ['popover/basic'],
    states: {
      default: rendered('Closed: the trigger.'),
      hover: interaction(),
      'focus-visible': interaction(),
      'active-selected': notApplicable('Hover and selection do not apply to a popover panel.'),
      disabled: NOT_DISABLED_HERE,
      invalid: NO_INVALID,
      open: interaction('Open by activating the trigger; Escape dismisses it.'),
    },
  },
  {
    id: 'charts/line-chart-multi-series',
    category: 'Charts',
    title: 'Line chart',
    examples: ['line-chart/multi-series'],
    states: {
      default: rendered(),
      hover: notApplicable('Chart interaction states are not part of the theme contract.'),
      'focus-visible': interaction('The chart exposes a keyboard focus target.'),
      'active-selected': notApplicable(
        'Chart interaction states are not part of the theme contract.',
      ),
      disabled: notApplicable('Chart has no disabled state.'),
      invalid: NO_INVALID,
      open: NO_OVERLAY_OPEN,
    },
  },
  {
    id: 'application/settings-dashboard',
    category: 'Application',
    title: 'Settings and dashboard',
    // The settings form comes first, then the summary; the overlay actions close the page.
    examples: [
      'input/basic',
      'select/basic',
      'checkbox/basic',
      'button/variants',
      'callout/variants',
      'table/basic',
      'line-chart/multi-series',
      'modal/with-form',
      'popover/basic',
    ],
    states: {
      default: rendered(),
      hover: interaction(),
      'focus-visible': interaction(),
      'active-selected': interaction('Checked checkboxes and the pressed button.'),
      disabled: NOT_DISABLED_HERE,
      invalid: notApplicable('The settings form renders no error example.'),
      open: interaction('The modal and popover actions.'),
    },
  },
];

export const DEFAULT_THEME_PREVIEW_SCENE_ID = 'components/button-variants';

export function themePreviewSceneById(id: string): ThemePreviewScene | undefined {
  return THEME_PREVIEW_SCENES.find((scene) => scene.id === id);
}

export function themePreviewScenesInCategory(
  category: ThemePreviewCategory,
): readonly ThemePreviewScene[] {
  return THEME_PREVIEW_SCENES.filter((scene) => scene.category === category);
}

/** Every distinct example id any scene references. */
export function themePreviewExampleIds(): readonly string[] {
  return [...new Set(THEME_PREVIEW_SCENES.flatMap((scene) => scene.examples))];
}

import * as cinder from '@lostgradient/cinder';
import type { FixtureHostOptions } from '@lostgradient/testing/browser/host';
import type { Component } from 'svelte';

/**
 * The Cinder exports the root suite's host (`scripts/browser-fixtures/src/main.ts`) mounts by slug.
 *
 * They are looked up by name on the whole Cinder namespace on purpose. The root host's page carries
 * the stylesheet of every Cinder component some root fixture reaches, which is nearly all of them,
 * and the specs here were written against that page. Many Cinder components import a sibling's
 * `.svelte` file rather than its entry, so the sibling's stylesheet arrives only when something
 * else loads that entry, and the order of two stylesheets that style one element decides between
 * them. Without the whole namespace, Modal's "Close (Esc)" Tooltip renders unstyled (no
 * `tooltip.css`), and `textarea.css` lands after `form-field.css`, so a Textarea's label takes
 * `line-height: 1` instead of the root page's `--cinder-leading-snug` and every dialog with one is
 * 4 pixels shorter (COR-2080). A namespace read by a computed key keeps every export, and with it
 * every component's stylesheet, with `textarea.css` before `form-field.css` as on the root page.
 */
const ROOT_HOST_COMPONENTS = {
  'access-gate': 'AccessGate',
  accordion: 'Accordion',
  button: 'Button',
  dropdown: 'Dropdown',
  input: 'Input',
  'menu-bar': 'MenuBar',
  'mega-menu': 'MegaMenu',
  'command-menu': 'CommandMenu',
  modal: 'Modal',
  'number-input': 'NumberInput',
  'phone-input': 'PhoneInput',
  'navigation-item': 'NavigationItem',
  'schema-form': 'SchemaForm',
  'segmented-control': 'SegmentedControl',
  'side-navigation': 'SideNavigation',
  table: 'Table',
  tabs: 'Tabs',
  'date-picker': 'DatePicker',
  'date-range-field': 'DateRangeField',
  'data-grid': 'DataGrid',
  'data-table': 'DataTable',
  tree: 'Tree',
  'virtual-list': 'VirtualList',
} as const satisfies Record<string, keyof typeof cinder>;

const library: Record<string, unknown> = cinder;
const components: Record<string, Component<any>> = Object.fromEntries(
  Object.entries(ROOT_HOST_COMPONENTS).map(([slug, name]) => [
    slug,
    library[name] as Component<any>,
  ]),
);

/**
 * How this package's fixture page mounts a fixture: the root host's Cinder components and
 * stylesheets, the theme guard an application installs, and the root host's full-registry code
 * highlighter.
 */
export default {
  components,
  installThemeGuard: cinder.guardThemeTransitions,
  provideContext: () => cinder.setCodeHighlighterContext(cinder.fullShikiHighlighter()),
} satisfies Omit<FixtureHostOptions, 'modules'>;

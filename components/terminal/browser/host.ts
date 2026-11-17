import type { Component } from 'svelte';

import {
  AccessGate,
  Accordion,
  Button,
  CommandMenu,
  DataGrid,
  DataTable,
  DatePicker,
  DateRangeField,
  Dropdown,
  fullShikiHighlighter,
  guardThemeTransitions,
  Input,
  MegaMenu,
  MenuBar,
  Modal,
  NavigationItem,
  NumberInput,
  PhoneInput,
  SchemaForm,
  SegmentedControl,
  setCodeHighlighterContext,
  SideNavigation,
  Table,
  Tabs,
  Tree,
  VirtualList,
} from '@lostgradient/cinder';
import type { FixtureHostOptions } from '@lostgradient/testing/browser/host';

/**
 * The Cinder components the root suite's host (`scripts/browser-fixtures/src/main.ts`) mounts by
 * slug. The terminal's baselines were rendered by that host, so this one imports the same set: the
 * stylesheets those imports load are part of the page the baselines record. Without them, Modal's
 * "Close (Esc)" Tooltip renders unstyled (Modal imports `tooltip.svelte`, not the Tooltip entry
 * that loads `tooltip.css`), and every terminal fixture that opens a dialog differs (COR-2080).
 */
const components: Record<string, Component<any>> = {
  'access-gate': AccessGate,
  accordion: Accordion,
  button: Button,
  dropdown: Dropdown,
  input: Input,
  'menu-bar': MenuBar,
  'mega-menu': MegaMenu,
  'command-menu': CommandMenu,
  modal: Modal,
  'number-input': NumberInput,
  'phone-input': PhoneInput,
  'navigation-item': NavigationItem,
  'schema-form': SchemaForm,
  'segmented-control': SegmentedControl,
  'side-navigation': SideNavigation,
  table: Table,
  tabs: Tabs,
  'date-picker': DatePicker,
  'date-range-field': DateRangeField,
  'data-grid': DataGrid,
  'data-table': DataTable,
  tree: Tree,
  'virtual-list': VirtualList,
};

/**
 * How the terminal's fixture page mounts a fixture: the root host's Cinder components, the theme
 * guard an application installs, and the full-registry code highlighter the root suite rendered
 * the terminal's baselines with.
 */
export default {
  components,
  installThemeGuard: guardThemeTransitions,
  provideContext: () => setCodeHighlighterContext(fullShikiHighlighter()),
} satisfies Omit<FixtureHostOptions, 'modules'>;

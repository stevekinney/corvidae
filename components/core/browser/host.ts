/**
 * The host every browser suite mounts its fixtures with (COR-2092): the Cinder components mounted by
 * slug, the theme guard an application installs, and the full-registry code highlighter. It is the
 * root suite's former `src/main.ts`, unchanged in what it imports and in what order, so each
 * package's fixture page loads the same stylesheets in the same order as the root page did.
 */
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

export default {
  components,
  installThemeGuard: guardThemeTransitions,
  // CodeBlock imports no highlighter of its own since COR-1456, so a component that highlights
  // through `setCodeHighlighterContext` (ApprovalCard's command, RunStepTimeline) renders the plain
  // fallback unless an ancestor publishes one. The playground's fixture roots publish their curated
  // adapter; this host publishes the full-registry adapter, the highlighter CodeBlock fell back to
  // when the committed Linux baselines were rendered.
  provideContext: () => setCodeHighlighterContext(fullShikiHighlighter()),
} satisfies Omit<FixtureHostOptions, 'modules'>;

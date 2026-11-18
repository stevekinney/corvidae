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
import type { FixtureModuleMaps } from '@lostgradient/testing/browser/fixture-loader';
import { startFixtureHost } from '@lostgradient/testing/browser/host';

import * as generatedModules from '../.playwright/fixture-modules.ts';

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

startFixtureHost({
  modules: generatedModules as unknown as FixtureModuleMaps,
  components,
  installThemeGuard: guardThemeTransitions,
  // CodeBlock imports no highlighter of its own since COR-1456, so a component that highlights
  // through `setCodeHighlighterContext` (ApprovalCard's command, RunStepTimeline) renders the plain
  // fallback unless an ancestor publishes one. The playground's fixture roots publish their curated
  // adapter; this host publishes the full-registry adapter, the highlighter CodeBlock fell back to
  // when the committed Linux baselines were rendered.
  provideContext: () => setCodeHighlighterContext(fullShikiHighlighter()),
});

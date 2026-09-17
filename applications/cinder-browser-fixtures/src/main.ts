import { flushSync, mount, type Component } from 'svelte';

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
  Input,
  MegaMenu,
  MenuBar,
  Modal,
  NavigationItem,
  NumberInput,
  PhoneInput,
  SchemaForm,
  SegmentedControl,
  SideNavigation,
  Table,
  Tabs,
  Tree,
  VirtualList,
} from '@repo/cinder';
import type { VisualFixture } from '@repo/testing';

import { loadFixture } from './fixture-loader.ts';
import { applySnapshotMode, isSnapshotMode } from './snapshot-mode.ts';

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

const fixtureModules = import.meta.glob<{ default: VisualFixture[] }>([
  '../../../packages/cinder/src/components/*/*-fixtures.ts',
  '../../../packages/chat/src/lib/components/*/*-fixtures.ts',
]);
const hostModules = import.meta.glob<{ default: Component<any> }>([
  '../../../packages/cinder/src/components/**/*.fixture.svelte',
  '../../../packages/chat/src/lib/components/**/*.fixture.svelte',
]);
const appHostModules = import.meta.glob<{ default: Component<any> }>('./fixtures/*.svelte');

function fixtureProps(fixture: VisualFixture): Record<string, any> {
  const props = 'props' in fixture ? fixture.props : undefined;
  return props !== null && typeof props === 'object' && !Array.isArray(props) ? props : {};
}

function themeFromStorage(): void {
  const theme = localStorage.getItem('browser-fixture-theme') ?? 'light';
  document.documentElement.dataset['theme'] = theme;
  document.documentElement.dataset['cinderTheme'] = theme;
  document.documentElement.style.colorScheme = theme;
}

const target = document.getElementById('app');
if (target === null) throw new Error('[corvidae fixtures] #app target not found');
const mountTarget: Element = target;

async function start(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const componentName = decodeURIComponent(window.location.pathname.split('/').at(-1) ?? '');
  themeFromStorage();
  applySnapshotMode(isSnapshotMode(params));
  const { fixture, component: fixtureComponent } = await loadFixture(
    componentName,
    params.get('fixture'),
    {
      fixtureModules,
      hostModules,
      appHostModules,
    },
  );
  const Component = fixtureComponent ?? components[componentName];
  if (Component === undefined) throw new Error(`Component '${componentName}' was not found.`);
  mount(Component, { target: mountTarget, props: fixtureProps(fixture) });
  flushSync();
}

void start().catch((error: unknown) => {
  target.replaceChildren();
  throw error;
});

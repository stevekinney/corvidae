/**
 * Regression tests for compound-component CSS dependency contracts.
 *
 * A compound component is self-sufficient when importing its CSS style subpath
 * (`@lostgradient/cinder/<name>/styles`) styles all public leaf components it renders.
 * Previously some parent namespaces were missing @import statements for their
 * leaf component styles, so consumers had to import both parent and leaf
 * separately — breaking the contract.
 *
 * Each test reads the parent CSS file as text and asserts the required @import
 * is present, confirming the import chain is wired without needing to run the
 * full build. This is the mechanical guard requested by task e4f2e104.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { cinderComponentFile } from './discover-component-directories.ts';

function readCss(componentPath: string): string {
  // Wherever the component lives: core, or the package the split moved it into (P-COR-101).
  return readFileSync(cinderComponentFile(componentPath), 'utf-8');
}

/**
 * An `@import` of `<directory>/<name>.css`: by relative path while one package holds both, or by
 * the holding package's specifier once the split moved it into another (P-COR-101).
 */
function importOf(directory: string, name: string): RegExp {
  return new RegExp(
    `@import\\s+['"](?:\\.\\./${directory}/|@lostgradient/[\\w-]+/(?:components/${directory}/)?)${name}\\.css['"]`,
  );
}

describe('Compound component CSS dependency contracts', () => {
  describe('CommandMenu — imports CommandItem styles', () => {
    const commandMenuCss = readCss('command-menu/command-menu.css');

    test('command-menu.css @imports command-item.css', () => {
      expect(commandMenuCss).toMatch(importOf('command-item', 'command-item'));
    });
  });

  describe('CommandPalette — imports CommandItem styles', () => {
    const commandPaletteCss = readCss('command-palette/command-palette.css');

    test('command-palette.css @imports command-item.css', () => {
      expect(commandPaletteCss).toMatch(importOf('command-item', 'command-item'));
    });

    test('CommandItem rules are NOT duplicated inline in command-palette.css', () => {
      // The rules were extracted to command-item.css. If someone later moves them
      // back AND forgets to remove the @import, both tests catch the duplication.
      // This assertion confirms the extraction is in effect.
      expect(commandPaletteCss).not.toMatch(/\.cinder-command-item\s*\{[^@]/);
    });
  });

  describe('CommandItem — has its own CSS sidecar', () => {
    const commandItemCss = readCss('command-item/command-item.css');

    test('command-item.css exists and contains .cinder-command-item rules', () => {
      expect(commandItemCss).toMatch(/\.cinder-command-item\s*\{/);
    });

    test('command-item.css carries the correct layer prelude', () => {
      expect(commandItemCss).toMatch(
        /@layer cinder\.tokens, cinder\.foundation, cinder\.components, cinder\.utilities;/,
      );
    });
  });

  describe('ContextMenu — imports Dropdown styles', () => {
    const contextMenuCss = readCss('context-menu/context-menu.css');

    test('context-menu.css @imports dropdown.css', () => {
      // ContextMenu renders DropdownItem, DropdownMenu, DropdownGroup, DropdownLabel,
      // and DropdownSeparator. Their styles live in dropdown/dropdown.css.
      expect(contextMenuCss).toMatch(importOf('dropdown', 'dropdown'));
    });
  });

  describe('MenuBar — imports Dropdown styles', () => {
    const menuBarCss = readCss('menu-bar/menu-bar.css');

    test('menu-bar.css @imports dropdown.css', () => {
      // MenuBar renders DropdownItem as its overflow-menu items.
      expect(menuBarCss).toMatch(importOf('dropdown', 'dropdown'));
    });
  });

  describe('SideNavigation — imports NavigationItem styles', () => {
    const sideNavigationCss = readCss('side-navigation/side-navigation.css');

    test('side-navigation.css @imports navigation-item.css', () => {
      // SideNavigationItem delegates rendering to NavigationItem.
      expect(sideNavigationCss).toMatch(
        importOf('navigation-item', 'navigation-item'),
      );
    });

    test('side-navigation.css still @imports side-navigation-group.css', () => {
      // Pre-existing import that must not be removed.
      expect(sideNavigationCss).toMatch(
        importOf('side-navigation-group', 'side-navigation-group'),
      );
    });
  });

  describe('Already self-sufficient: Tabs', () => {
    const tabsCss = readCss('tabs/tabs.css');

    test('tabs.css @imports tab.css', () => {
      expect(tabsCss).toMatch(importOf('tab', 'tab'));
    });

    test('tabs.css @imports tab-list.css', () => {
      expect(tabsCss).toMatch(importOf('tab-list', 'tab-list'));
    });

    test('tabs.css @imports tab-panel.css', () => {
      expect(tabsCss).toMatch(importOf('tab-panel', 'tab-panel'));
    });
  });

  describe('Already self-sufficient: Table', () => {
    const tableCss = readCss('table/table.css');

    test('table.css @imports table-row.css', () => {
      expect(tableCss).toMatch(importOf('table-row', 'table-row'));
    });

    test('table.css @imports table-header.css', () => {
      expect(tableCss).toMatch(importOf('table-header', 'table-header'));
    });
  });
});

import { describe, expect, test } from 'bun:test';
import { findSidebarHeadings } from './check-sidebar-no-headings';

const hidden = `<SideNavigationGroup label={copy.work} collapsible={false} labelVisibility="hidden" class={group === 'system' ? 'a' : ''}>`;

describe('sidebar section headings', () => {
  test.each([
    ['a group with a visible label', '<SideNavigationGroup label="Work" collapsible={false}>'],
    [
      'a collapsible group, which draws a trigger',
      '<SideNavigationGroup label="Work" labelVisibility="hidden">',
    ],
    [
      'a group that sets only visibility',
      '<SideNavigationGroup label="Work" labelVisibility="visible" collapsible={false}>',
    ],
    [
      'a group over several lines',
      '<SideNavigationGroup\n  label={x}\n  collapsible={false}\n  onclick={() => { go(); }}\n>',
    ],
  ])('reports %s', (_name, source) => {
    expect(
      findSidebarHeadings(`first line\n${source}`).map((site) => Number.parseInt(site)),
    ).toEqual([2]);
  });

  test('accepts a static group with a hidden label, even with an expression in its class', () => {
    expect(findSidebarHeadings(hidden)).toEqual([]);
    expect(
      findSidebarHeadings(
        `<SideNavigationGroup\n  label="Work"\n  collapsible={false}\n  labelVisibility='hidden'\n>`,
      ),
    ).toEqual([]);
  });

  test('ignores a different component and the closing tag', () => {
    expect(
      findSidebarHeadings('<SideNavigation label="x"></SideNavigation></SideNavigationGroup>'),
    ).toEqual([]);
  });
});

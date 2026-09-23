/**
 * COR-239: a real npm install of `@lostgradient/cinder` must type-check under
 * `skipLibCheck: false` without TS2590 ("Expression produces a union type
 * that is too complex to represent") on any published component.
 *
 * ## What actually broke
 *
 * `@lostgradient/cinder@0.26.2` shipped fifteen components whose exported
 * Props type is a discriminated union where two or more arms (a) carry the
 * `` [key: `data-${string}`]: unknown `` index signature that `svelte/elements`'
 * `HTMLAttributes<T>` mixes in, and (b) otherwise differ — different key
 * sets, or different "big" attribute types such as `HTMLButtonAttributes`
 * versus `HTMLAnchorAttributes`. Svelte's own `Component<Props, Exports,
 * Bindings extends keyof Props | ''>` computes `keyof Props` to check its
 * `Bindings` constraint. For a union, `keyof` distributes over every arm and
 * intersects the results; doing that once per differing arm, each carrying a
 * template-literal index signature, exceeds TypeScript's type complexity
 * budget. A consumer with `skipLibCheck: false` — the setting a real install
 * runs under, since `skipLibCheck: true` only skips *other* packages' `.d.ts`
 * files, not the consumer's own use of this one — hits TS2590 on the
 * component's own declaration.
 *
 * This was measured with controlled fixtures: stripping only the `data-*`
 * index signature removes TS2590; stripping a `symbol` index signature does
 * not; the generic inheritance chain those interfaces sit in (e.g.
 * `HTMLAttributes<T> extends AriaAttributes, DOMAttributes<T>`) is NOT the
 * cause on its own.
 *
 * ### The fix
 *
 * A prior attempt flattened these interfaces and dropped the `data-*` index
 * signature entirely. That was rejected: it silently removed arbitrary
 * `data-*` prop support from public Props types that real consumers depend
 * on (e.g. `data-message-id` on Button, `data-active` on DropdownItem,
 * `data-toolbar-instance-id` on Button).
 *
 * Instead, each affected Props type is restructured as:
 *
 *   Props = SharedAttributes & DataAttributes & PadUnion<SmallDiscriminatedUnion>
 *
 * `SharedAttributes` is the ONE non-union HTML-attribute type common to every
 * arm, with its `data-*` index signature removed (see
 * `src/_internal/union-props.ts`'s `WithoutDataAttributes`).
 * `DataAttributes` restores a single, non-distributed `` { [key:
 * `data-${string}`]: unknown } `` outside the union, so arbitrary `data-*`
 * props are still accepted on every arm — `keyof` only has to walk it once,
 * because it is not part of the union. `SmallDiscriminatedUnion` keeps only
 * the parts that actually vary between arms (the element-specific attributes,
 * naming/discriminant props). `PadUnion` (also in `union-props.ts`) pads
 * every arm of that small union with the keys it lacks as optional `never`,
 * so all arms present the same key set to `keyof` — the other measured lever
 * for TS2590. This keeps every previously-accepted `data-*` prop, including
 * the three real consumer usages above, while keeping `keyof Props` cheap.
 *
 * ## Why this checks source, not a built tarball
 *
 * `components/cinder` ships TypeScript source directly — no build step; see
 * AGENTS.md ("Shared source libraries export TypeScript source directly").
 * The actual `dist/**\/*.svelte.d.ts` this defect was reported against is
 * produced by `svelte-package` in the separate, publish-only `cinder`
 * repository the mirror clones (`scripts/mirror/publish-rehearsal.ts`), which
 * this workspace cannot run. What `svelte-package` mechanically emits for
 * every component is `declare const X: import('svelte').Component<Props, {},
 * Bindings>;`, built from that component's own exported Props type and its
 * own `$bindable()` usage — verified against a real
 * `npm pack @lostgradient/cinder@0.26.2` tarball while diagnosing this issue.
 * This module reconstructs that exact declaration shape from this
 * workspace's own `*.types.ts` source (the literal `Bindings` argument for
 * each component below is read off that component's own `.svelte` file, not
 * guessed) and type-checks it exactly the way a consumer's `tsc` would under
 * `skipLibCheck: false`. Fixing the source fixes what the build emits from
 * it, because the transform does not alter type structure — verified type by
 * type against the published tarball while diagnosing this issue.
 */

import { join } from 'node:path';
import ts from 'typescript';

export class ConsumerStrictTypesError extends Error {}

export interface Fixture {
  /** Used only for diagnostics; must be unique within one `checkFixtures` call. */
  readonly name: string;
  /** A complete TypeScript module body, checked as its own virtual file. */
  readonly body: string;
}

const PACKAGE_ROOT = join(import.meta.dir, '..');
const FIXTURE_DIRECTORY = join(PACKAGE_ROOT, 'scripts', '__consumer_strict_types_fixture__');

/**
 * The fifteen components named in COR-239. Each fixture imports that
 * component's real, exported Props type from this workspace's source and
 * declares it exactly the way a packaged `*.svelte.d.ts` does: `declare
 * const X: Component<Props, {}, Bindings>`. `Bindings` is the literal
 * bindable-prop union each component's own `$bindable()` calls produce —
 * `''` for none. The four compound components (ContextMenu, Dropdown,
 * SideNavigation, Tree) additionally carry their sub-component properties,
 * matching `Object.assign(Root, { ... })` in each component's `index.ts`,
 * because that is what a consumer imports and what the published tarball's
 * `index.d.ts` actually declares.
 */
export const BASELINE_FIXTURES: readonly Fixture[] = [
  {
    name: 'button',
    body: `
      import type { ButtonProps } from '../../src/components/button/button.types.ts';
      declare const Button: import('svelte').Component<ButtonProps, {}, ''>;
      export default Button;
    `,
  },
  {
    name: 'card',
    body: `
      import type { CardProps } from '../../src/components/card/card.types.ts';
      declare const Card: import('svelte').Component<CardProps, {}, ''>;
      export default Card;
    `,
  },
  {
    name: 'chip',
    body: `
      import type { ChipProps } from '../../src/components/chip/chip.types.ts';
      declare const Chip: import('svelte').Component<ChipProps, {}, ''>;
      export default Chip;
    `,
  },
  {
    name: 'context-menu',
    body: `
      import type { ContextMenuProps } from '../../src/components/context-menu/context-menu.types.ts';
      import type { ContextMenuTriggerProps } from '../../src/components/context-menu-trigger/context-menu-trigger.types.ts';
      import type { DropdownMenuProps } from '../../src/components/dropdown-menu/dropdown-menu.types.ts';
      import type { DropdownItemProps } from '../../src/components/dropdown-item/dropdown-item.types.ts';
      import type { DropdownLabelProps } from '../../src/components/dropdown-label/dropdown-label.types.ts';
      import type { DropdownSeparatorProps } from '../../src/components/dropdown-separator/dropdown-separator.types.ts';
      import type { DropdownGroupProps } from '../../src/components/dropdown-group/dropdown-group.types.ts';

      declare const ContextMenu: import('svelte').Component<ContextMenuProps, {}, 'open'> & {
        Trigger: import('svelte').Component<ContextMenuTriggerProps, {}, ''>;
        Menu: import('svelte').Component<DropdownMenuProps, {}, ''>;
        Item: import('svelte').Component<DropdownItemProps, {}, ''>;
        Label: import('svelte').Component<DropdownLabelProps, {}, ''>;
        Separator: import('svelte').Component<DropdownSeparatorProps, {}, ''>;
        Group: import('svelte').Component<DropdownGroupProps, {}, ''>;
      };
      export default ContextMenu;
    `,
  },
  {
    name: 'dropdown-item',
    body: `
      import type { DropdownItemProps } from '../../src/components/dropdown-item/dropdown-item.types.ts';
      declare const DropdownItem: import('svelte').Component<DropdownItemProps, {}, ''>;
      export default DropdownItem;
    `,
  },
  {
    name: 'dropdown',
    body: `
      import type { DropdownProps } from '../../src/components/dropdown/dropdown.types.ts';
      import type { DropdownTriggerProps } from '../../src/components/dropdown-trigger/dropdown-trigger.types.ts';
      import type { DropdownMenuProps } from '../../src/components/dropdown-menu/dropdown-menu.types.ts';
      import type { DropdownItemProps } from '../../src/components/dropdown-item/dropdown-item.types.ts';
      import type { DropdownLabelProps } from '../../src/components/dropdown-label/dropdown-label.types.ts';
      import type { DropdownSeparatorProps } from '../../src/components/dropdown-separator/dropdown-separator.types.ts';
      import type { DropdownGroupProps } from '../../src/components/dropdown-group/dropdown-group.types.ts';

      declare const Dropdown: import('svelte').Component<DropdownProps, {}, 'open'> & {
        Trigger: import('svelte').Component<DropdownTriggerProps, {}, ''>;
        Menu: import('svelte').Component<DropdownMenuProps, {}, ''>;
        Item: import('svelte').Component<DropdownItemProps, {}, ''>;
        Label: import('svelte').Component<DropdownLabelProps, {}, ''>;
        Separator: import('svelte').Component<DropdownSeparatorProps, {}, ''>;
        Group: import('svelte').Component<DropdownGroupProps, {}, ''>;
      };
      export default Dropdown;
    `,
  },
  {
    name: 'floating-action',
    body: `
      import type { FloatingActionProps } from '../../src/components/floating-action/floating-action.types.ts';
      declare const FloatingAction: import('svelte').Component<FloatingActionProps, {}, ''>;
      export default FloatingAction;
    `,
  },
  {
    name: 'invocation-rule-builder',
    body: `
      import type { InvocationRuleBuilderProps } from '../../src/components/invocation-rule-builder/invocation-rule-builder.types.ts';
      declare const InvocationRuleBuilder: import('svelte').Component<InvocationRuleBuilderProps, {}, ''>;
      export default InvocationRuleBuilder;
    `,
  },
  {
    name: 'navigation-item',
    body: `
      import type { NavigationItemProps } from '../../src/components/navigation-item/navigation-item.types.ts';
      declare const NavigationItem: import('svelte').Component<NavigationItemProps, {}, ''>;
      export default NavigationItem;
    `,
  },
  {
    name: 'pricing-card',
    body: `
      import type { PricingCardProps } from '../../src/components/pricing-card/pricing-card.types.ts';
      declare const PricingCard: import('svelte').Component<PricingCardProps, {}, ''>;
      export default PricingCard;
    `,
  },
  {
    name: 'segment',
    body: `
      import type { SegmentProps } from '../../src/components/segment/segment.types.ts';
      declare const Segment: import('svelte').Component<SegmentProps, {}, ''>;
      export default Segment;
    `,
  },
  {
    name: 'selectable-row',
    body: `
      import type { SelectableRowProps } from '../../src/components/selectable-row/selectable-row.types.ts';
      declare const SelectableRow: import('svelte').Component<SelectableRowProps, {}, ''>;
      export default SelectableRow;
    `,
  },
  {
    name: 'side-navigation-item',
    body: `
      import type { SideNavigationItemProps } from '../../src/components/side-navigation-item/side-navigation-item.types.ts';
      declare const SideNavigationItem: import('svelte').Component<SideNavigationItemProps, {}, ''>;
      export default SideNavigationItem;
    `,
  },
  {
    name: 'side-navigation',
    body: `
      import type { SideNavigationProps } from '../../src/components/side-navigation/side-navigation.types.ts';
      import type { SideNavigationGroupProps } from '../../src/components/side-navigation-group/side-navigation-group.types.ts';
      import type { SideNavigationItemProps } from '../../src/components/side-navigation-item/side-navigation-item.types.ts';

      declare const SideNavigation: import('svelte').Component<SideNavigationProps, {}, ''> & {
        Group: import('svelte').Component<SideNavigationGroupProps, {}, 'expanded'>;
        Item: import('svelte').Component<SideNavigationItemProps, {}, ''>;
      };
      export default SideNavigation;
    `,
  },
  {
    name: 'tree',
    body: `
      import type { TreeProps } from '../../src/components/tree/tree.types.ts';
      import type { TreeItemProps } from '../../src/components/tree-item/tree-item.types.ts';
      import type { TreeExpandAllProps } from '../../src/components/_tree-expand-all/tree-expand-all.types.ts';
      import type { TreeSelectAllProps } from '../../src/components/_tree-select-all/tree-select-all.types.ts';

      declare const Tree: import('svelte').Component<TreeProps, {}, 'expandedIds' | 'selectedIds' | 'ref'> & {
        ExpandAll: import('svelte').Component<TreeExpandAllProps, {}, ''>;
        Item: import('svelte').Component<TreeItemProps, {}, ''>;
        SelectAll: import('svelte').Component<TreeSelectAllProps, {}, ''>;
      };
      export default Tree;
    `,
  },
];

if (BASELINE_FIXTURES.length !== 15) {
  throw new ConsumerStrictTypesError(
    `Expected exactly fifteen baseline fixtures per COR-239; found ${BASELINE_FIXTURES.length}.`,
  );
}

/**
 * Additional to the fifteen baseline fixtures above (COR-239's reviewer notes flagged this
 * count as ambiguous — this file resolves it by keeping the two counts separate). These prove
 * the fix did not weaken any of the constraints COR-239 named: accessible naming, href/button
 * discriminants, and component-specific unions. Each constraint gets one fixture that must
 * type-check clean and one that must fail exactly where `// @ts-expect-error` says it will.
 */
export const CONSTRAINT_FIXTURES: readonly Fixture[] = [
  {
    name: 'button-icon-only-accessible-name-positive',
    body: `
      import type { ButtonProps } from '../../src/components/button/button.types.ts';
      declare const aSnippet: import('svelte').Snippet;
      const withAriaLabel: ButtonProps = { iconOnly: true, 'aria-label': 'Close', leadingIcon: aSnippet };
      export { withAriaLabel };
    `,
  },
  {
    name: 'button-icon-only-accessible-name-negative',
    body: `
      import type { ButtonProps } from '../../src/components/button/button.types.ts';
      declare const aSnippet: import('svelte').Snippet;
      // @ts-expect-error — icon-only requires an accessible name (label, aria-label, or aria-labelledby).
      const missingAccessibleName: ButtonProps = { iconOnly: true, leadingIcon: aSnippet };
      export { missingAccessibleName };
    `,
  },
  {
    name: 'button-href-discriminant-positive',
    body: `
      import type { ButtonProps } from '../../src/components/button/button.types.ts';
      const asLink: ButtonProps = { href: 'https://example.com', label: 'Docs' };
      const asButton: ButtonProps = { label: 'Save', formaction: '/save-draft' };
      export { asLink, asButton };
    `,
  },
  {
    name: 'button-href-discriminant-negative',
    body: `
      import type { ButtonProps } from '../../src/components/button/button.types.ts';
      // @ts-expect-error — href selects the anchor arm, which has no button-only "formaction".
      const linkWithButtonOnlyAttribute: ButtonProps = { href: 'https://example.com', label: 'Docs', formaction: '/save-draft' };
      export { linkWithButtonOnlyAttribute };
    `,
  },
  {
    name: 'navigation-item-discriminant-positive',
    body: `
      import type { NavigationItemProps } from '../../src/components/navigation-item/navigation-item.types.ts';
      declare const aSnippet: import('svelte').Snippet;
      const asLink: NavigationItemProps = { children: aSnippet, href: '/home' };
      const asButton: NavigationItemProps = { children: aSnippet, onclick: () => {} };
      export { asLink, asButton };
    `,
  },
  {
    name: 'navigation-item-discriminant-negative',
    body: `
      import type { NavigationItemProps } from '../../src/components/navigation-item/navigation-item.types.ts';
      declare const aSnippet: import('svelte').Snippet;
      // @ts-expect-error — neither href (link) nor onclick (button) was provided.
      const neitherArm: NavigationItemProps = { children: aSnippet };
      export { neitherArm };
    `,
  },
  {
    name: 'card-union-positive',
    body: `
      import type { CardProps } from '../../src/components/card/card.types.ts';
      declare const aSnippet: import('svelte').Snippet;
      const plain: CardProps = { children: aSnippet };
      const withHeader: CardProps = { children: aSnippet, header: aSnippet };
      const withTitle: CardProps = { children: aSnippet, title: 'Plan' };
      export { plain, withHeader, withTitle };
    `,
  },
  {
    name: 'card-union-negative',
    body: `
      import type { CardProps } from '../../src/components/card/card.types.ts';
      declare const aSnippet: import('svelte').Snippet;
      // @ts-expect-error — header and title are mutually exclusive card layouts.
      const bothHeaderAndTitle: CardProps = { children: aSnippet, header: aSnippet, title: 'Plan' };
      export { bothHeaderAndTitle };
    `,
  },
  {
    name: 'chip-mode-discriminant-positive',
    body: `
      import type { ChipProps } from '../../src/components/chip/chip.types.ts';
      const display: ChipProps = { label: 'Beta' };
      const toggle: ChipProps = { mode: 'toggle', label: 'Beta', pressed: false };
      const removable: ChipProps = { mode: 'removable', label: 'Beta' };
      export { display, toggle, removable };
    `,
  },
  {
    name: 'chip-mode-discriminant-negative',
    body: `
      import type { ChipProps } from '../../src/components/chip/chip.types.ts';
      // @ts-expect-error — toggle mode requires \`pressed\`.
      const toggleMissingPressed: ChipProps = { mode: 'toggle', label: 'Beta' };
      export { toggleMissingPressed };
    `,
  },
];

/**
 * Regression fixtures for a rejected earlier fix (branch
 * `worktree-agent-a33df83ff528221b2`, commit 1d0cd816): it silenced TS2590 by
 * flattening the affected attribute interfaces and dropping their `data-*`
 * index signature, which broke real consumers passing arbitrary `data-*`
 * props — `data-message-id` on Button
 * (`components/chat/.../chat-private-harness.fixture.svelte:1078`),
 * `data-toolbar-instance-id` on Button
 * (`components/editor/.../editor-toolbar.svelte:380`), and `data-active` on
 * DropdownItem (`components/editor/.../toolbar-dropdown.svelte:70`). Every
 * fixture below must type-check clean under the *current* fix so a future
 * change can't quietly reintroduce that regression.
 *
 * Fourteen of the fifteen COR-239 components get a fixture here.
 * `ContextMenuProps` is the one exception: it has no HTML-attribute
 * forwarding surface at all (`context-menu.svelte` destructures every prop by
 * name and never spreads `...rest` onto an element), so it never accepted
 * arbitrary `data-*` props before COR-239 and still doesn't — there is
 * nothing for a fix to preserve. Its own baseline fixture above already
 * exercises `DropdownItemProps` (via the compound `Item` part), which has its
 * own fixture here.
 */
export const DATA_ATTRIBUTE_FIXTURES: readonly Fixture[] = [
  {
    name: 'button-data-attribute',
    body: `
      import type { ButtonProps } from '../../src/components/button/button.types.ts';
      const withDataAttributes: ButtonProps = {
        label: 'Save',
        'data-message-id': 'msg-1',
        'data-toolbar-instance-id': 'toolbar-1',
        'data-anything': 'x',
      };
      export { withDataAttributes };
    `,
  },
  {
    name: 'card-data-attribute',
    body: `
      import type { CardProps } from '../../src/components/card/card.types.ts';
      declare const aSnippet: import('svelte').Snippet;
      const withDataAttribute: CardProps = { children: aSnippet, 'data-anything': 'x' };
      export { withDataAttribute };
    `,
  },
  {
    name: 'chip-data-attribute',
    body: `
      import type { ChipProps } from '../../src/components/chip/chip.types.ts';
      const withDataAttribute: ChipProps = { label: 'Beta', 'data-anything': 'x' };
      export { withDataAttribute };
    `,
  },
  {
    name: 'dropdown-item-data-attribute',
    body: `
      import type { DropdownItemProps } from '../../src/components/dropdown-item/dropdown-item.types.ts';
      const withDataActive: DropdownItemProps = { 'data-active': 'true' };
      export { withDataActive };
    `,
  },
  {
    name: 'dropdown-data-attribute',
    body: `
      import type { DropdownProps } from '../../src/components/dropdown/dropdown.types.ts';
      const withDataAttribute: DropdownProps = { id: 'menu', 'data-anything': 'x' };
      export { withDataAttribute };
    `,
  },
  {
    name: 'floating-action-data-attribute',
    body: `
      import type { FloatingActionProps } from '../../src/components/floating-action/floating-action.types.ts';
      const withDataAttribute: FloatingActionProps = { 'data-anything': 'x' };
      export { withDataAttribute };
    `,
  },
  {
    name: 'invocation-rule-builder-data-attribute',
    body: `
      import type { InvocationRuleBuilderProps } from '../../src/components/invocation-rule-builder/invocation-rule-builder.types.ts';
      const withDataAttribute: InvocationRuleBuilderProps = {
        fieldOptions: [],
        mode: 'flat-conditions',
        conditions: [],
        readonly: true,
        'data-anything': 'x',
      };
      export { withDataAttribute };
    `,
  },
  {
    name: 'navigation-item-data-attribute',
    body: `
      import type { NavigationItemProps } from '../../src/components/navigation-item/navigation-item.types.ts';
      declare const aSnippet: import('svelte').Snippet;
      const withDataAttribute: NavigationItemProps = {
        children: aSnippet,
        href: '/home',
        'data-anything': 'x',
      };
      export { withDataAttribute };
    `,
  },
  {
    name: 'pricing-card-data-attribute',
    body: `
      import type { PricingCardProps } from '../../src/components/pricing-card/pricing-card.types.ts';
      const withDataAttribute: PricingCardProps = {
        name: 'Pro',
        price: '$9/mo',
        features: [],
        callToActionLabel: 'Buy',
        onPlanSelect: () => {},
        'data-anything': 'x',
      };
      export { withDataAttribute };
    `,
  },
  {
    name: 'segment-data-attribute',
    body: `
      import type { SegmentProps } from '../../src/components/segment/segment.types.ts';
      declare const aSnippet: import('svelte').Snippet;
      const withDataAttribute: SegmentProps = { value: 'a', children: aSnippet, 'data-anything': 'x' };
      export { withDataAttribute };
    `,
  },
  {
    name: 'selectable-row-data-attribute',
    body: `
      import type { SelectableRowProps } from '../../src/components/selectable-row/selectable-row.types.ts';
      declare const aSnippet: import('svelte').Snippet;
      const withDataAttribute: SelectableRowProps = { title: aSnippet, 'data-anything': 'x' };
      export { withDataAttribute };
    `,
  },
  {
    name: 'side-navigation-item-data-attribute',
    body: `
      import type { SideNavigationItemProps } from '../../src/components/side-navigation-item/side-navigation-item.types.ts';
      declare const aSnippet: import('svelte').Snippet;
      const withDataAttribute: SideNavigationItemProps = {
        children: aSnippet,
        href: '/home',
        'data-anything': 'x',
      };
      export { withDataAttribute };
    `,
  },
  {
    name: 'side-navigation-data-attribute',
    body: `
      import type { SideNavigationProps } from '../../src/components/side-navigation/side-navigation.types.ts';
      declare const aSnippet: import('svelte').Snippet;
      const withDataAttribute: SideNavigationProps = {
        ariaLabel: 'Main',
        children: aSnippet,
        'data-anything': 'x',
      };
      export { withDataAttribute };
    `,
  },
  {
    name: 'tree-data-attribute',
    body: `
      import type { TreeProps } from '../../src/components/tree/tree.types.ts';
      declare const aSnippet: import('svelte').Snippet;
      const withDataAttribute: TreeProps = { children: aSnippet, 'data-anything': 'x' };
      export { withDataAttribute };
    `,
  },
];

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  strict: true,
  noEmit: true,
  // The one setting this whole defect is about: a real consumer's install
  // never sets this to true for its own dependencies. Widening it back to
  // `true` would hide the regression this file exists to catch.
  skipLibCheck: false,
  customConditions: ['browser', 'svelte'],
  allowImportingTsExtensions: true,
  isolatedModules: true,
  verbatimModuleSyntax: true,
};

export interface FixtureDiagnostics {
  readonly fixture: Fixture;
  readonly diagnostics: readonly ts.Diagnostic[];
}

/**
 * Type-check every fixture in one TypeScript program (one `tsc`-equivalent run, not one per
 * fixture) and return each fixture's own diagnostics. Fixture bodies are never written to
 * disk — the compiler host resolves each fixture's virtual path directly from `fixtures`, and
 * every relative import inside a fixture body resolves against that virtual path exactly as it
 * would for a real file at `scripts/__consumer_strict_types_fixture__/<name>.ts`.
 */
export function checkFixtures(fixtures: readonly Fixture[]): FixtureDiagnostics[] {
  const { program } = createFixtureProgram(fixtures);
  const allDiagnostics = ts.getPreEmitDiagnostics(program);

  return fixtures.map((fixture) => ({
    fixture,
    diagnostics: allDiagnostics.filter(
      (diagnostic) => diagnostic.file?.fileName === fileNameFor(fixture),
    ),
  }));
}

/**
 * Diagnostics from real, on-disk source files pulled in transitively by any of `fixtures`'
 * imports — e.g. a typo in a `*.types.ts` file's own type references. `checkFixtures` above
 * only returns diagnostics located in a fixture's own virtual file: an error inside a real
 * `*.types.ts` file (a broken import, an unresolved type name) does not generally cascade to
 * the fixture file that imports it, because an unresolved type is treated as `any` rather than
 * propagating a further diagnostic at each reference site. This function is the harness's other
 * half: it type-checks the exact same program and returns whatever diagnostics remain once every
 * fixture's own (virtual) file is excluded, so a real mistake in the source under test cannot
 * hide behind fixtures that all still "pass" on their own file's diagnostics.
 */
export function checkLibraryDiagnostics(fixtures: readonly Fixture[]): readonly ts.Diagnostic[] {
  const { program } = createFixtureProgram(fixtures);
  const virtualFileNames = new Set(fixtures.map((fixture) => fileNameFor(fixture)));
  return ts
    .getPreEmitDiagnostics(program)
    .filter(
      (diagnostic) =>
        diagnostic.file !== undefined && !virtualFileNames.has(diagnostic.file.fileName),
    );
}

function createFixtureProgram(fixtures: readonly Fixture[]): { program: ts.Program } {
  const virtualFiles = new Map(fixtures.map((fixture) => [fileNameFor(fixture), fixture.body]));
  const host = ts.createCompilerHost(COMPILER_OPTIONS);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, ...rest) => {
    const body = virtualFiles.get(fileName);
    if (body !== undefined) {
      return ts.createSourceFile(fileName, body, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    }
    return originalGetSourceFile(fileName, languageVersionOrOptions, ...rest);
  };
  host.fileExists = (fileName) => virtualFiles.has(fileName) || ts.sys.fileExists(fileName);
  host.readFile = (fileName) => virtualFiles.get(fileName) ?? ts.sys.readFile(fileName);

  const program = ts.createProgram({
    rootNames: [...virtualFiles.keys()],
    options: COMPILER_OPTIONS,
    host,
  });
  return { program };
}

function fileNameFor(fixture: Fixture): string {
  return join(FIXTURE_DIRECTORY, `${fixture.name}.ts`);
}

export function formatFixtureDiagnostics({ fixture, diagnostics }: FixtureDiagnostics): string {
  if (diagnostics.length === 0) return `${fixture.name}: clean`;
  const lines = diagnostics.map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    const position =
      diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : undefined;
    return `  ${position ? `${position.line + 1}:${position.character + 1}` : '?'} TS${diagnostic.code}: ${message}`;
  });
  return `${fixture.name}:\n${lines.join('\n')}`;
}

const ALL_FIXTURES: readonly Fixture[] = [
  ...BASELINE_FIXTURES,
  ...CONSTRAINT_FIXTURES,
  ...DATA_ATTRIBUTE_FIXTURES,
];

async function main(): Promise<number> {
  const results = [
    ...checkFixtures(BASELINE_FIXTURES),
    ...checkFixtures(CONSTRAINT_FIXTURES),
    ...checkFixtures(DATA_ATTRIBUTE_FIXTURES),
  ];
  const failing = results.filter((result) => result.diagnostics.length > 0);
  for (const result of failing) process.stderr.write(`${formatFixtureDiagnostics(result)}\n`);

  const libraryDiagnostics = checkLibraryDiagnostics(ALL_FIXTURES);
  for (const diagnostic of libraryDiagnostics) {
    process.stderr.write(`${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}\n`);
  }

  if (failing.length > 0 || libraryDiagnostics.length > 0) {
    process.stderr.write(
      `\ntest:consumer:strict-types — ${failing.length}/${results.length} fixture(s) failed and ${libraryDiagnostics.length} library diagnostic(s) under skipLibCheck: false.\n`,
    );
    return 1;
  }
  process.stdout.write(
    `test:consumer:strict-types — ${results.length}/${results.length} fixture(s) clean.\n`,
  );
  return 0;
}

if (import.meta.main) process.exit(await main());

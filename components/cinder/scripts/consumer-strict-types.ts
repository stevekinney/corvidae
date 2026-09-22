/**
 * COR-239: a real npm install of `@lostgradient/cinder` must type-check under
 * `skipLibCheck: false` without TS2590 ("Expression produces a union type
 * that is too complex to represent") on any published component.
 *
 * ## What actually broke
 *
 * `@lostgradient/cinder@0.26.2` shipped fifteen components whose exported
 * Props type is a discriminated union where two or more arms each reference
 * one of `svelte/elements`' `HTMLAttributes<T>`, `HTMLButtonAttributes`, or
 * `HTMLAnchorAttributes` — interfaces built from a multi-level generic
 * inheritance chain (`HTMLAttributes<T> extends AriaAttributes,
 * DOMAttributes<T>`). Svelte's own `Component<Props, Exports, Bindings
 * extends keyof Props | ''>` computes `keyof Props` to check its `Bindings`
 * constraint, and doing that for a union re-walks that generic chain once per
 * arm. One arm is cheap; two or more exceeds TypeScript's type complexity
 * budget, and a consumer with `skipLibCheck: false` — the setting a real
 * install runs under, since `skipLibCheck: true` only skips *other*
 * packages' `.d.ts` files, not the consumer's own use of this one — hits
 * TS2590 on the component's own declaration.
 *
 * The fix (see each affected `*.types.ts`) references a flattened,
 * non-generic copy of the relevant interface —
 * `src/_internal/forwarded-html-attributes.generated.ts`, produced by
 * `scripts/generate-forwarded-html-attributes.ts` — instead of the generic
 * original, in exactly the position that used to feed more than one union
 * arm. `keyof` a plain object type with no inheritance chain is cheap
 * regardless of how many arms reference it, so the flattened copy carries
 * every property `HTMLButtonAttributes` (etc.) has, with no prop dropped and
 * no `any`.
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
  const allDiagnostics = ts.getPreEmitDiagnostics(program);

  return fixtures.map((fixture) => ({
    fixture,
    diagnostics: allDiagnostics.filter(
      (diagnostic) => diagnostic.file?.fileName === fileNameFor(fixture),
    ),
  }));
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

async function main(): Promise<number> {
  const results = [...checkFixtures(BASELINE_FIXTURES), ...checkFixtures(CONSTRAINT_FIXTURES)];
  const failing = results.filter((result) => result.diagnostics.length > 0);
  for (const result of failing) process.stderr.write(`${formatFixtureDiagnostics(result)}\n`);
  if (failing.length > 0) {
    process.stderr.write(
      `\ntest:consumer:strict-types — ${failing.length}/${results.length} fixture(s) failed under skipLibCheck: false.\n`,
    );
    return 1;
  }
  process.stdout.write(
    `test:consumer:strict-types — ${results.length}/${results.length} fixture(s) clean.\n`,
  );
  return 0;
}

if (import.meta.main) process.exit(await main());

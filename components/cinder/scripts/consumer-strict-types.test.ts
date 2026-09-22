/**
 * COR-239 regression test. See the module doc on `consumer-strict-types.ts`
 * for the defect, the root cause, and why this checks source rather than a
 * built tarball.
 *
 * Fifteen baseline fixtures, one per component COR-239 named (Button, Card,
 * Chip, ContextMenu, DropdownItem, Dropdown, FloatingAction,
 * InvocationRuleBuilder, NavigationItem, PricingCard, Segment, SelectableRow,
 * SideNavigationItem, SideNavigation, Tree), each importing that component's
 * real Props type and declaring `Component<Props, {}, Bindings>` exactly as
 * a published `*.svelte.d.ts` does. `tsc` exited nonzero — nine TS2590s
 * across these fifteen files plus more on the packages downstream of them —
 * against the pre-fix source; every one is asserted clean here.
 *
 * The ten constraint fixtures are additional to those fifteen (not counted
 * among them — see the module doc's "Fixture count" section for why): five
 * of COR-239's named prop constraints, each with one fixture that must
 * type-check clean and one that must fail only where it says it will.
 */

import { describe, expect, test } from 'bun:test';
import {
  BASELINE_FIXTURES,
  checkFixtures,
  CONSTRAINT_FIXTURES,
  formatFixtureDiagnostics,
} from './consumer-strict-types.ts';

const TS2590_TOO_COMPLEX = 2590;
const TS2578_UNUSED_EXPECT_ERROR = 2578;

describe('COR-239: published Cinder declarations type-check under skipLibCheck: false', () => {
  test('exactly fifteen baseline fixtures are declared, one per named component', () => {
    expect(BASELINE_FIXTURES).toHaveLength(15);
    expect(new Set(BASELINE_FIXTURES.map((fixture) => fixture.name)).size).toBe(15);
  });

  const baselineResults = checkFixtures(BASELINE_FIXTURES);

  for (const result of baselineResults) {
    test(`${result.fixture.name}: Component<Props, {}, Bindings> type-checks clean`, () => {
      expect(result.diagnostics, formatFixtureDiagnostics(result)).toHaveLength(0);
    });
  }

  test('no baseline fixture produces TS2590 anywhere in its program', () => {
    const offenders = baselineResults.filter((result) =>
      result.diagnostics.some((diagnostic) => diagnostic.code === TS2590_TOO_COMPLEX),
    );
    expect(offenders.map((result) => result.fixture.name)).toEqual([]);
  });
});

describe('COR-239: existing prop constraints are preserved (additional to the fifteen above)', () => {
  const constraintResults = checkFixtures(CONSTRAINT_FIXTURES);
  const byName = new Map(constraintResults.map((result) => [result.fixture.name, result]));

  test('every constraint fixture name is unique and every fixture was checked', () => {
    expect(constraintResults).toHaveLength(CONSTRAINT_FIXTURES.length);
    expect(byName.size).toBe(CONSTRAINT_FIXTURES.length);
  });

  const positiveNames = CONSTRAINT_FIXTURES.map((fixture) => fixture.name).filter((name) =>
    name.endsWith('-positive'),
  );
  const negativeNames = CONSTRAINT_FIXTURES.map((fixture) => fixture.name).filter((name) =>
    name.endsWith('-negative'),
  );

  test('every constraint has both a positive and a negative fixture', () => {
    expect(positiveNames).toHaveLength(negativeNames.length);
    expect(positiveNames.length).toBeGreaterThan(0);
  });

  for (const name of positiveNames) {
    test(`${name}: valid usage type-checks clean`, () => {
      const result = byName.get(name);
      if (!result) throw new Error(`No result for fixture ${name}`);
      expect(result.diagnostics, formatFixtureDiagnostics(result)).toHaveLength(0);
    });
  }

  for (const name of negativeNames) {
    test(`${name}: the expected type error actually occurs`, () => {
      const result = byName.get(name);
      if (!result) throw new Error(`No result for fixture ${name}`);
      // A negative fixture's `// @ts-expect-error` suppresses the one error it names. If that
      // error does not occur, TS reports 2578 ("Unused '@ts-expect-error' directive") instead —
      // which is exactly the failure mode that would let a constraint quietly stop being
      // enforced. A clean fixture (no diagnostics at all) is the only passing outcome.
      expect(result.diagnostics, formatFixtureDiagnostics(result)).toHaveLength(0);
    });
  }

  test('no constraint fixture silently lost its expected error (TS2578) or hit TS2590', () => {
    const offenders = constraintResults.filter((result) =>
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === TS2578_UNUSED_EXPECT_ERROR || diagnostic.code === TS2590_TOO_COMPLEX,
      ),
    );
    expect(offenders.map((result) => result.fixture.name)).toEqual([]);
  });
});

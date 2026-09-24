/**
 * COR-239 regression test. See the module doc on `consumer-strict-types.ts`
 * for the defect, the measured root cause, and why this checks source rather
 * than a built tarball.
 *
 * Fifteen baseline fixtures, one per component COR-239 named (Button, Card,
 * Chip, ContextMenu, DropdownItem, Dropdown, FloatingAction,
 * InvocationRuleBuilder, NavigationItem, PricingCard, Segment, SelectableRow,
 * SideNavigationItem, SideNavigation, Tree), each importing that component's
 * real Props type and declaring `Component<Props, {}, Bindings>` exactly as
 * a published `*.svelte.d.ts` does. Against the pre-fix source `tsc` exited
 * nonzero with TS2590 on all fifteen; every one is asserted clean here.
 *
 * The ten constraint fixtures are additional to those fifteen (not counted
 * among them — see the module doc's "Fixture count" section for why): five
 * of COR-239's named prop constraints, each with one fixture that must
 * type-check clean and one that must fail only where it says it will.
 *
 * The data-attribute fixtures are also additional: regression coverage for a
 * rejected earlier fix that silenced TS2590 by dropping `data-*` forwarding
 * from these same Props types. See `DATA_ATTRIBUTE_FIXTURES`'s module doc for
 * why one of the fifteen components (ContextMenu) has no fixture here.
 */

import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import {
  BASELINE_FIXTURES,
  checkFixtures,
  checkLibraryDiagnostics,
  CONSTRAINT_FIXTURES,
  DATA_ATTRIBUTE_FIXTURES,
  formatFixtureDiagnostics,
} from './consumer-strict-types.ts';

const ALL_FIXTURES = [...BASELINE_FIXTURES, ...CONSTRAINT_FIXTURES, ...DATA_ATTRIBUTE_FIXTURES];

/** See `DATA_ATTRIBUTE_FIXTURES`'s module doc: fourteen of the fifteen components. */
const EXPECTED_DATA_ATTRIBUTE_FIXTURE_COUNT = 14;

const TS2590_TOO_COMPLEX = 2590;
const TS2578_UNUSED_EXPECT_ERROR = 2578;

describe('COR-239: data-* forwarding survives the fix (regression for the rejected earlier fix)', () => {
  const dataAttributeResults = checkFixtures(DATA_ATTRIBUTE_FIXTURES);

  test('fourteen of the fifteen components have a data-attribute fixture', () => {
    expect(DATA_ATTRIBUTE_FIXTURES).toHaveLength(EXPECTED_DATA_ATTRIBUTE_FIXTURE_COUNT);
    expect(new Set(DATA_ATTRIBUTE_FIXTURES.map((fixture) => fixture.name)).size).toBe(
      EXPECTED_DATA_ATTRIBUTE_FIXTURE_COUNT,
    );
  });

  for (const result of dataAttributeResults) {
    test(`${result.fixture.name}: an arbitrary data-* prop still type-checks clean`, () => {
      expect(result.diagnostics, formatFixtureDiagnostics(result)).toHaveLength(0);
    });
  }
});

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

describe('COR-239: the real *.types.ts source pulled in by every fixture has no diagnostics of its own', () => {
  // `checkFixtures` only reports diagnostics located in a fixture's own virtual file. A mistake
  // inside a real `*.types.ts` file (e.g. a missing import introduced while restructuring a
  // Props union) does not generally cascade into an error at that file's import sites, so every
  // per-fixture assertion above could stay green while the actual source is broken. This is the
  // harness's other half: it checks the same program for diagnostics anywhere else.
  const libraryDiagnostics = checkLibraryDiagnostics(ALL_FIXTURES);

  test('no diagnostics outside the fixtures themselves', () => {
    const messages = libraryDiagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
    expect(messages).toEqual([]);
  });
});

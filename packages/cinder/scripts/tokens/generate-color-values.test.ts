import { describe, expect, test } from 'bun:test';
import { type CorpusEntry } from './corpus.ts';
import { colorEntry } from './generator-test-support.ts';
import { serializeEntryValue } from './value-entry.ts';
function recipeEntry(cssRecipe: string): CorpusEntry {
  return colorEntry({ path: 'polarity.ink', cssProperty: '--cinder-polarity-ink', cssRecipe });
}

describe('CIN-602: a parsed value tree, not a function-name allowlist', () => {
  test('an unrecognised function fails closed, at every color position a real recipe can reach', () => {
    // The bug this ticket exists to retire: the string-matching version
    // treated ANY function it did not recognise as a complete color, so a
    // typo'd function name -- or a real future CSS color function this repo
    // has not added to `COLOR_FUNCTIONS` yet -- silently passed. `unknown-fn`
    // is not `light-dark`, `color-mix`, `var`, or any function in
    // `COLOR_FUNCTIONS`, so every one of these must reject.
    const templates = [
      '%C%',
      'light-dark(%C%, oklch(0% 0 0))',
      'light-dark(oklch(0% 0 0), %C%)',
      'color-mix(in oklch, %C%, transparent)',
      'color-mix(in oklch, %C% 40%, transparent)',
      'color-mix(in oklch, calc(var(--w) * 1%) %C%, transparent)',
      'color-mix(in oklch, var(--w) %C%, transparent)',
      'var(--x, %C%)',
      'var(--a, var(--b, %C%))',
      'color-mix(in oklch, light-dark(%C%, transparent) +40%, transparent)',
    ];
    for (const template of templates) {
      const recipe = template.replace('%C%', 'unknown-fn(0% 0 0)');
      expect(() => serializeEntryValue(recipeEntry(recipe), new Map()), recipe).toThrow(
        /bare component list/,
      );
    }
  });

  test('every position in that same template set still accepts a real color and rejects a real bare triplet', () => {
    const templates = [
      '%C%',
      'light-dark(%C%, oklch(0% 0 0))',
      'light-dark(oklch(0% 0 0), %C%)',
      'color-mix(in oklch, %C%, transparent)',
      'color-mix(in oklch, %C% 40%, transparent)',
      'color-mix(in oklch, calc(var(--w) * 1%) %C%, transparent)',
      'color-mix(in oklch, var(--w) %C%, transparent)',
      'var(--x, %C%)',
      'var(--a, var(--b, %C%))',
      'color-mix(in oklch, light-dark(%C%, transparent) +40%, transparent)',
    ];
    for (const template of templates) {
      const complete = template.replace('%C%', 'oklch(50% 0.1 30)');
      expect(serializeEntryValue(recipeEntry(complete), new Map()), complete).toBe(complete);

      const bare = template.replace('%C%', '0% 0 0');
      expect(() => serializeEntryValue(recipeEntry(bare), new Map()), bare).toThrow(
        /bare component list/,
      );
    }
  });

  test('a corpus alias reference is presumed complete without recursing into what it names', () => {
    // `var()` with no fallback is a bare reference: ambiguous between "this
    // resolves to a color" and "this resolves to a weight" in a color-mix
    // argument, and the safe direction is to accept it (see
    // `mixColorCandidates`'s doc comment). This is not a gap the parser
    // rewrite closes -- it is documented, existing behavior -- but it is the
    // one place a bare `var()` still passes, and the fail-closed test above
    // must not be read as claiming this case is covered too.
    expect(serializeEntryValue(recipeEntry('var(--cinder-polarity-ink)'), new Map())).toBe(
      'var(--cinder-polarity-ink)',
    );
  });

  test('a lone number in a color position is bare, not a keyword', () => {
    // `5` is a `word` node, but it is neither a hex literal nor a keyword
    // (the keyword grammar requires a leading letter) -- it falls through
    // to the same bare-component-list result a triplet does.
    expect(() =>
      serializeEntryValue(recipeEntry('color-mix(in oklch, 5, transparent)'), new Map()),
    ).toThrow(/bare component list/);
  });

  test('a value that is not a function, hex literal, or keyword is bare', () => {
    // A quoted string can never be a color position, regardless of what kind
    // of node the parser produces for it.
    expect(() =>
      serializeEntryValue(recipeEntry('color-mix(in oklch, "oops", transparent)'), new Map()),
    ).toThrow(/bare component list/);
  });

  test('a non-function, non-word node (e.g. a quoted string) never counts as an unambiguous percentage', () => {
    // Exercises the same fact from inside `color-mix()`'s weight-stripping
    // step: a stray string sitting beside a real `var()` color is not
    // mistaken for the weight, so it is left in as a (bare) candidate.
    expect(() =>
      serializeEntryValue(
        recipeEntry('color-mix(in oklch, "oops" var(--cinder-border-ink), transparent)'),
        new Map(),
      ),
    ).toThrow(/bare component list/);
  });

  test('every entry in COLOR_FUNCTIONS is accepted as a complete color, standalone and inside light-dark()/color-mix()', () => {
    // rgb, rgba, hsl, hsla, hwb, lab, lch, oklab, and color are all allowlisted
    // in COLOR_FUNCTIONS, but every existing accept-side table only ever
    // exercises oklch/light-dark/color-mix/var/hex/keyword. All seven of the
    // untested entries currently behave correctly, but a typo in that set
    // (or a name silently dropped during a future edit) would make a color
    // function permanently rejected with zero test failures until this.
    const colorLiterals = [
      'rgb(255 0 0)',
      'rgba(255 0 0 / 0.5)',
      'hsl(120deg 100% 50%)',
      'hsla(120deg 100% 50% / 0.5)',
      'hwb(120deg 50% 50%)',
      'lab(50% 40 59.5)',
      'lch(50% 40 130)',
      'oklab(50% 0.1 0.1)',
      'color(display-p3 1 0 0)',
    ];
    for (const literal of colorLiterals) {
      expect(serializeEntryValue(recipeEntry(literal), new Map()), literal).toBe(literal);

      const lightDark = `light-dark(${literal}, oklch(0% 0 0))`;
      expect(serializeEntryValue(recipeEntry(lightDark), new Map()), lightDark).toBe(lightDark);

      const mix = `color-mix(in oklch, ${literal}, transparent 20%)`;
      expect(serializeEntryValue(recipeEntry(mix), new Map()), mix).toBe(mix);
    }
  });

  test('hypot() is recognised as a color-mix weight, so it no longer shadows the real color as the bare offender', () => {
    // Confirmed defect: PERCENTAGE_FUNCTIONS previously omitted `hypot`, a
    // browser-supported, type-preserving CSS math function (a <percentage>
    // argument yields a <percentage> result per the CSS Values L4 spec), so
    // `hypot(1%, 2%)` sitting beside a genuinely complete color was left in
    // as an unrecognised "color candidate" and reported as the bare offender
    // instead of being recognised as the weight.
    const recipe = 'color-mix(in oklch, hypot(1%, 2%) oklch(50% 0.1 30), transparent)';
    expect(serializeEntryValue(recipeEntry(recipe), new Map())).toBe(recipe);

    const weightSecond = 'color-mix(in oklch, oklch(50% 0.1 30) hypot(1%, 2%), transparent)';
    expect(serializeEntryValue(recipeEntry(weightSecond), new Map())).toBe(weightSecond);
  });

  test('pow(), sqrt(), log(), and exp() are still rejected as a color-mix weight -- they cannot legitimately produce a percentage', () => {
    // Unlike hypot(), these exponential functions are defined by the spec to
    // take and return a plain <number>, never a <percentage>, so they must
    // NOT be added to PERCENTAGE_FUNCTIONS -- a "the more math functions the
    // better" fix would be wrong here, not just incomplete.
    for (const weight of ['pow(2, 3)', 'sqrt(4)', 'log(8, 2)', 'exp(1)']) {
      const recipe = `color-mix(in oklch, ${weight} oklch(50% 0.1 30), transparent)`;
      expect(() => serializeEntryValue(recipeEntry(recipe), new Map()), recipe).toThrow(
        /bare component list/,
      );
    }
  });

  describe('CIN-602 round 4: a PERCENTAGE_FUNCTIONS member is only a percentage weight when its OWN arguments are', () => {
    // `hypot()` was added to PERCENTAGE_FUNCTIONS to accept a browser-valid
    // percentage-typed weight, but `isUnambiguousPercentageNode` checked only
    // the function NAME -- so `hypot(1px, 2px)`, which the CSS spec types as
    // a <length> (hypot()'s arguments must share a type, and the result
    // matches it), passed the gate as if it were a percentage. The browser
    // rejects that length-valued weight and drops the whole declaration --
    // the gate was fail-OPEN for it. The same name-only check applied to
    // every OTHER member of PERCENTAGE_FUNCTIONS too: `calc(1px + 2px)`,
    // `clamp(1px, 2px, 3px)`, `min(1px, 2px)`, `max(1px, 2px)`,
    // `round(1px, 1px)`, `mod(1px, 1px)`, `rem(1px, 1px)`, and `abs(-1px)`
    // were all equally fail-open before this fix -- this table proves each
    // one, in both directions, against the SAME oklch color used throughout
    // this file's color-mix tests.
    const color = 'oklch(50% 0.1 30)';

    const cases: Array<{ name: string; percentageCall: string; lengthCall: string }> = [
      { name: 'calc()', percentageCall: 'calc(1% + 2%)', lengthCall: 'calc(1px + 2px)' },
      {
        name: 'clamp()',
        percentageCall: 'clamp(0%, 50%, 100%)',
        lengthCall: 'clamp(0px, 50px, 100px)',
      },
      { name: 'min()', percentageCall: 'min(10%, 20%)', lengthCall: 'min(10px, 20px)' },
      { name: 'max()', percentageCall: 'max(10%, 20%)', lengthCall: 'max(10px, 20px)' },
      { name: 'round()', percentageCall: 'round(1.5%, 1%)', lengthCall: 'round(1.5px, 1px)' },
      { name: 'mod()', percentageCall: 'mod(10%, 3%)', lengthCall: 'mod(10px, 3px)' },
      { name: 'rem()', percentageCall: 'rem(10%, 3%)', lengthCall: 'rem(10px, 3px)' },
      { name: 'abs()', percentageCall: 'abs(-10%)', lengthCall: 'abs(-10px)' },
      { name: 'hypot()', percentageCall: 'hypot(1%, 2%)', lengthCall: 'hypot(1px, 2px)' },
    ];

    for (const { name, percentageCall, lengthCall } of cases) {
      test(`${name}: a percentage-typed call IS accepted as the weight`, () => {
        const recipe = `color-mix(in oklch, ${percentageCall} ${color}, transparent)`;
        expect(serializeEntryValue(recipeEntry(recipe), new Map()), recipe).toBe(recipe);
      });

      test(`${name}: a length-typed call is REJECTED, not silently accepted as a weight`, () => {
        const recipe = `color-mix(in oklch, ${lengthCall} ${color}, transparent)`;
        expect(() => serializeEntryValue(recipeEntry(recipe), new Map()), recipe).toThrow(
          /bare component list/,
        );
      });
    }

    test('a percentage call NESTED inside another percentage function is still recognised (calc(clamp(...)))', () => {
      const recipe = `color-mix(in oklch, calc(clamp(0%, 50%, 100%) * 2) ${color}, transparent)`;
      expect(serializeEntryValue(recipeEntry(recipe), new Map()), recipe).toBe(recipe);
    });

    test('a length call nested inside another percentage function is still rejected (calc(clamp(px...)))', () => {
      const recipe = `color-mix(in oklch, calc(clamp(0px, 50px, 100px) * 2) ${color}, transparent)`;
      expect(() => serializeEntryValue(recipeEntry(recipe), new Map()), recipe).toThrow(
        /bare component list/,
      );
    });

    test('a var() with a percentage fallback used AS a math-function argument is recognised (calc(var(--w, 1%) + 2%))', () => {
      const recipe = `color-mix(in oklch, calc(var(--w, 1%) + 2%) ${color}, transparent)`;
      expect(serializeEntryValue(recipeEntry(recipe), new Map()), recipe).toBe(recipe);
    });

    test('a var() with NO fallback used as a math-function argument cannot be proven a percentage, so it is rejected (fail closed)', () => {
      const recipe = `color-mix(in oklch, calc(var(--w) + 2%) ${color}, transparent)`;
      expect(() => serializeEntryValue(recipeEntry(recipe), new Map()), recipe).toThrow(
        /bare component list/,
      );
    });

    test('a bare number with no percentage anywhere in the expression is rejected -- calc(1 + 2) is a <number>, never a <percentage>', () => {
      const recipe = `color-mix(in oklch, calc(1 + 2) ${color}, transparent)`;
      expect(() => serializeEntryValue(recipeEntry(recipe), new Map()), recipe).toThrow(
        /bare component list/,
      );
    });

    test('percentage arithmetic respects dimensional types, grouping, and left associativity', () => {
      for (const weight of [
        'calc(1% + 2% * 3)',
        'calc((1% + 2%) * 2)',
        'calc(10% / 2 * 3)',
        'calc(1% * 2% / 3%)',
        'calc(1% / 2% * 3%)',
        'calc(var(--weight, 2) * 1%)',
        'calc(2 * var(--weight, 1%))',
        'round(up, 11%, 5%)',
        'min(1% + 2%, 4%)',
        'clamp(none, 50%, 100%)',
        'clamp(0%, 50%, none)',
        'clamp(none, 50%, none)',
        'calc(round(2.5) * 1%)',
      ]) {
        const recipe = `color-mix(in oklch, ${weight} ${color}, transparent)`;
        expect(serializeEntryValue(recipeEntry(recipe), new Map()), weight).toBe(recipe);
      }
    });

    test('invalid expressions cannot borrow a percentage type from another operand', () => {
      for (const weight of [
        'calc(1 + 2%)',
        'calc(1% / 2%)',
        'calc(1px + 2%)',
        'calc(1% * 2%)',
        'calc(1% * (1 + 2%))',
        'calc(bogus * 1%)',
        'calc(1% * bogus())',
        'calc(1% * )',
        'calc(* 1%)',
        'calc(1% + 2% 3%)',
        'calc(1%, 2%)',
        'clamp(1%, 2%)',
        'clamp(none, 50%, 2px)',
        'clamp(none, none, 100%)',
        'round(11%)',
        'abs(1%, 2%)',
        'mod(1%)',
        'round(sideways, 1%, 2%)',
        'min(1%, 2)',
        'calc(var(--weight) + 1%)',
        'calc(var(--weight, nope) * 1%)',
        'calc(var(not-a-custom-property) * 1%)',
        'calc(1% +/**/2%)',
      ]) {
        const recipe = `color-mix(in oklch, ${weight} ${color}, transparent)`;
        expect(() => serializeEntryValue(recipeEntry(recipe), new Map()), weight).toThrow(
          /bare component list/,
        );
      }
    });

    test('sign() is rejected outright, even with a percentage argument -- unlike abs(), the spec types its result as always a plain <number>', () => {
      const recipe = `color-mix(in oklch, sign(-10%) ${color}, transparent)`;
      expect(() => serializeEntryValue(recipeEntry(recipe), new Map()), recipe).toThrow(
        /bare component list/,
      );
    });
  });

  describe('an unclosed function node is never a complete color (fail-open regression)', () => {
    // `postcss-value-parser` still produces a `function` node for a call
    // missing its closing `)`, marked `unclosed: true`, with everything up to
    // the end of the declaration swept in as that node's own arguments. A
    // whole-string regex rejects a missing `)` outright; the parsed-tree
    // walk has no equivalent unless it checks the flag explicitly at every
    // acceptance path (the allowlist return, the `var()` return, and before
    // recursing into a `light-dark()`/`color-mix()` argument) -- otherwise
    // `oklch(50% 0.1 30` (or a `var()`/`color-mix()` with the same defect)
    // reads as a syntactically fine function call and PASSES, even though the
    // browser drops the declaration as invalid. This is a fail-open
    // regression from the string-matching version this file replaces.

    test('an unclosed color function is rejected, not accepted as a complete color', () => {
      const recipe = 'oklch(50% 0.1 30';
      expect(() => serializeEntryValue(recipeEntry(recipe), new Map()), recipe).toThrow(
        /bare component list/,
      );
    });

    test('an unclosed var() is rejected, not accepted as a bare (ambiguous) reference', () => {
      const recipe = 'var(--cinder-polarity-ink';
      expect(() => serializeEntryValue(recipeEntry(recipe), new Map()), recipe).toThrow(
        /bare component list/,
      );
    });

    test('an unclosed color-mix() is rejected even though its color argument is a complete, properly-closed function', () => {
      // color-mix's own `)` is missing, but `oklch(50% 0.1 30)` inside it is
      // syntactically whole -- the defect is only visible on the wrapping
      // node, which is exactly what a name-and-argument-shape check (rather
      // than an `unclosed` check) would miss.
      const recipe = 'color-mix(in oklch, oklch(50% 0.1 30), transparent';
      expect(() => serializeEntryValue(recipeEntry(recipe), new Map()), recipe).toThrow(
        /bare component list/,
      );
    });

    test('a nested case: color-mix() is unclosed while wrapping a light-dark() of two complete colors, both of which close fine', () => {
      // Confirmed via the parser directly: only the outer `color-mix()` node
      // comes back `unclosed: true` here -- `light-dark()` and both `oklch()`
      // calls it contains are each properly closed. Reaching this failure
      // means the fix's guard fires on the outer node BEFORE
      // `findBareInFunction` ever descends into checking the nested
      // `light-dark()`/`oklch()` structure, rather than recursing in,
      // finding two complete colors, and reporting the whole value as fine.
      const recipe =
        'color-mix(in oklch, light-dark(oklch(50% 0.1 30), oklch(0% 0 0)), transparent';
      expect(() => serializeEntryValue(recipeEntry(recipe), new Map()), recipe).toThrow(
        /bare component list/,
      );
    });
  });
});

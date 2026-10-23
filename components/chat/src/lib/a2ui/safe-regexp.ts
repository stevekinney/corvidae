/**
 * Agent-supplied regular expressions (the `regex` function and a TextField's
 * `validationRegexp`), run by RE2 rather than the browser's backtracking
 * engine. RE2 matches in time linear in the input, so a pattern such as
 * `^(a+)+$` cannot freeze the page. It has no backreferences or lookaround,
 * which only backtracking can run, so a pattern that uses them does not
 * compile.
 */
import { RE2JS } from 're2js';

/** A compiled pattern. */
export type SafePattern = { readonly test: (value: string) => boolean };

/**
 * Compiles a JavaScript regular expression source for RE2, or returns
 * `undefined` when it is malformed or needs backtracking.
 */
export function compileSafePattern(pattern: string): SafePattern | undefined {
  try {
    const compiled = RE2JS.compile(RE2JS.translateRegExp(pattern));
    return { test: (value) => compiled.test(value) };
  } catch {
    return undefined;
  }
}

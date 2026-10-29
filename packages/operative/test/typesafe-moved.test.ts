/**
 * The TypeSafe decision model lives in `@lostgradient/operative-typesafe`. Operative's root, its
 * provider-authoring, provider-testing, and decision-testing entry points, and the decisions barrel
 * name none of what moved, so a host that wants TypeSafe has to name the package (and Operative
 * carries no `@tanstack` peer). The moved types are checked at compile time, in
 * `typesafe-moved.test-d.ts`.
 */
import * as root from '@lostgradient/operative';
import * as decisionTesting from '@lostgradient/operative/decision-testing';
import * as providerKit from '@lostgradient/operative/provider-kit';
import * as providerTesting from '@lostgradient/operative/provider-testing';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

/** Every runtime export of `@lostgradient/operative-typesafe` and of its `typesafe-jev` module. */
const MOVED_TYPESAFE_EXPORTS = ['createTypesafeJev', 'importTypesafePeers', 'typesafeJev'] as const;

const entryPoints = { root, providerKit, providerTesting, decisionTesting };

/** The barrel that re-exported the TypeSafe module before it moved. */
const BARRELS = ['src/decisions/index.ts'] as const;

describe('the TypeSafe decision model has left Operative', () => {
  for (const [entryPoint, exports] of Object.entries(entryPoints)) {
    it(`${entryPoint} exports none of the symbols that moved to @lostgradient/operative-typesafe`, () => {
      const stillExported = MOVED_TYPESAFE_EXPORTS.filter((name) => Object.hasOwn(exports, name));
      expect(stillExported).toEqual([]);
    });
  }

  for (const barrel of BARRELS) {
    it(`${barrel} names none of the symbols that moved`, () => {
      const source = readFileSync(new URL(`../${barrel}`, import.meta.url), 'utf8');
      const stillNamed = MOVED_TYPESAFE_EXPORTS.filter((name) =>
        new RegExp(`\\b${name}\\b`).test(source),
      );
      expect(stillNamed).toEqual([]);
    });
  }

  it('declares no @tanstack dependency of any kind', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    const names = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .flatMap((field) => Object.keys((manifest[field] ?? {}) as Record<string, unknown>))
      .filter((name) => name.startsWith('@tanstack/'));
    expect(names).toEqual([]);
  });
});

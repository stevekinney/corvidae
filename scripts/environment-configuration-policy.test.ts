import { expect, test } from 'bun:test';

import {
  boundaryKind,
  findEnvironmentViolations,
  scanEnvironmentConfigurationPolicy,
} from './environment-configuration-policy';

function violations(source: string, file = 'packages/example/src/consumer.ts'): number {
  return findEnvironmentViolations(source, file).length;
}

test('rejects direct, aliased, and reflective environment reads', () => {
  const cases = [
    ["process.env.API_KEY; Bun.env['PORT']; Bun.env.HOST;", 3],
    ["const env = process.env; env.API_KEY; Reflect.get(env, 'PORT');", 2],
    ["consume(process.env); consume({ ...process.env }.PORT); process['env'].HOST;", 3],
    ["Reflect.get(Reflect.get(globalThis, 'process'), 'env');", 1],
    ['const { PORT } = process.env; PORT;', 1],
    ['const p = process; p.env.PORT;', 1],
    ['const bag = { env: process.env }; bag.env.PORT;', 1],
    ['globalThis.Bun.env.PORT; globalThis["Bun"].env.PORT;', 2],
    ["const p = Reflect.get(globalThis, 'process'); const e = Reflect.get(p, 'env'); e.PORT;", 1],
    ["const b = Reflect.get(globalThis, 'Bun'); const e = Reflect.get(b, 'env'); e.PORT;", 1],
    ["import { env as privateEnv } from '$env/dynamic/private'; privateEnv.API_KEY;", 1],
    [
      "import { env as privateEnv } from '$env/dynamic/private'; const leaked = privateEnv; leaked.API_KEY;",
      1,
    ],
  ] as const;
  for (const [source, expected] of cases) expect(violations(source)).toBe(expected);
});

test('permits writes, deletes, forwarding, and literal bundler define keys', () => {
  expect(
    violations(
      "process.env.PORT = '1'; delete Bun.env.PORT; spawn({ env: process.env }); spawn({ env: { ...process.env } });",
    ),
  ).toBe(0);
  expect(violations("const define = { 'process.env.NODE_ENV': '\"production\"' };")).toBe(0);
});

test('permits test setup values only when they are restored', () => {
  expect(
    violations(
      "const saved = process.env.PORT; process.env.PORT = '1'; process.env.PORT = saved;",
      'packages/example/test/consumer.test.ts',
    ),
  ).toBe(0);
  expect(
    violations(
      "const saved = process.env.PORT; process.env.PORT = '1';",
      'packages/example/test/consumer.test.ts',
    ),
  ).toBe(1);
  expect(
    violations(
      "const saved = process.env.PORT; process.env.PORT = '1'; process.env.PORT; process.env.PORT = saved;",
      'packages/example/test/consumer.test.ts',
    ),
  ).toBe(1);
});

test('the executable repository has no unregistered environment reads', async () => {
  const root = new URL('..', import.meta.url).pathname;
  expect(await scanEnvironmentConfigurationPolicy(root)).toEqual([]);
});

test('registers runtime and script boundaries separately', () => {
  expect(boundaryKind('packages/operative/src/environment-configuration.ts')).toBe('runtime');
  expect(boundaryKind('applications/playground/src/environment-configuration.ts')).toBe('runtime');
  expect(boundaryKind('packages/weft/scripts/ui-browser/environment-configuration.ts')).toBe(
    'script',
  );
  // Weft's byte-identical copy of `@lostgradient/testing`'s module, for the Svelte compile plugin
  // the UI's test preload and browser host import (scripts/check-svelte-plugin-copies.ts).
  expect(boundaryKind('packages/weft/scripts/lib/environment-configuration.ts')).toBe('script');
  expect(boundaryKind('scripts/environment-configuration.ts')).toBe('script');
  expect(
    boundaryKind('packages/bureau/src/test/signal-shutdown/environment-configuration.ts'),
  ).toBe('script');
  expect(boundaryKind('packages/example/src/environment-configuration.ts')).toBeUndefined();
});

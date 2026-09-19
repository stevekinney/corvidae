import { expect, test } from 'bun:test';

test.each([
  ['development', 'production', 'true'],
  ['production', 'development', 'false'],
])('command warnings follow the %s export condition', (condition, nodeEnvironment, expected) => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      '--conditions',
      condition,
      '--eval',
      `import { shouldLogDevelopmentWarnings } from ${JSON.stringify(new URL('./commands.ts', import.meta.url).href)}; console.log(shouldLogDevelopmentWarnings());`,
    ],
    { env: { ...process.env, NODE_ENV: nodeEnvironment } },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString().trim()).toBe(expected);
});

import { expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { compile, compileModule } from 'svelte/compiler';

it('builds both hosts against the same client, actions and control', async () => {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL('./hosts.ts', import.meta.url))],
    target: 'bun',
    plugins: [
      {
        name: 'fixtures',
        setup(builder) {
          builder.onResolve({ filter: /^@lostgradient\/cinder$/u }, () => ({
            path: 'cinder',
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/u, namespace: 'fixture' }, () => ({
            contents: 'export const Button = () => {};',
            loader: 'js',
          }));
          builder.onLoad({ filter: /\.svelte(?:\.ts)?$/u }, async ({ path }) => {
            const source = await Bun.file(path).text();
            return {
              loader: 'js',
              contents: path.endsWith('.svelte.ts')
                ? compileModule(new Bun.Transpiler({ loader: 'ts' }).transformSync(source), {
                    filename: path,
                    generate: 'server',
                  }).js.code
                : compile(source, { filename: path, generate: 'server' }).js.code,
            };
          });
        },
      },
    ],
  });
  expect(build.success).toBe(true);
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(await build.outputs[0].text()).toString('base64')}`
  );
  expect(module.shared).toBe(true);
});

it('keeps server modules out of the browser UI bundle', async () => {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL('./hosts.ts', import.meta.url))],
    target: 'browser',
    conditions: ['browser', 'svelte'],
    metafile: true,
    plugins: [
      {
        name: 'svelte-fixture',
        setup(builder) {
          builder.onLoad({ filter: /\.svelte(?:\.ts)?$/u }, async ({ path }) => {
            const source = await Bun.file(path).text();
            return {
              loader: 'js',
              contents: path.endsWith('.svelte.ts')
                ? compileModule(new Bun.Transpiler({ loader: 'ts' }).transformSync(source), {
                    filename: path,
                    generate: 'client',
                  }).js.code
                : compile(source, { filename: path, generate: 'client' }).js.code,
            };
          });
        },
      },
    ],
  });
  expect(build.logs).toEqual([]);
  expect(build.success).toBe(true);
  const inputs = Object.keys(build.metafile?.inputs ?? {});
  expect(
    inputs.filter((path) =>
      /(?:^|\/)(?:bureau\/src|server|armorer|credentials)(?:\/|$)/u.test(path),
    ),
  ).toEqual([]);
});

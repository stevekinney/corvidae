import { expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { compile, compileModule } from 'svelte/compiler';
import { SSR_SNAPSHOT } from '../tests/fixture/ssr-snapshot.ts';

function sveltePlugin(target: 'client' | 'server', imports: string[] = []): Bun.BunPlugin {
  return {
    name: 'svelte-fixture',
    setup(builder) {
      builder.onResolve({ filter: /.*/u }, ({ path }) => {
        imports.push(path);
      });
      builder.onLoad({ filter: /\.svelte(?:\.ts)?$/u }, async ({ path }) => {
        const source = await Bun.file(path).text();
        if (path.endsWith('.svelte.ts')) {
          const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
          return {
            contents: compileModule(javascript, { filename: path, generate: target }).js.code,
            loader: 'js',
          };
        }
        return {
          contents: compile(source, { filename: path, generate: target }).js.code,
          loader: 'js',
        };
      });
    },
  };
}

it('builds the generated browser fixture without server and private dependencies', async () => {
  const imports: string[] = [];
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL('../tests/fixture/entry.ts', import.meta.url))],
    target: 'browser',
    plugins: [sveltePlugin('client', imports)],
  });
  expect(build.logs).toEqual([]);
  expect(build.success).toBe(true);
  expect(
    imports.filter((path) =>
      /(?:^|\/)(?:server|armorer|velveteen|credentials|mcp)(?:\/|$)/iu.test(path),
    ),
  ).toEqual([]);
  const source = await build.outputs[0].text();
  expect(source).not.toMatch(/@lostgradient\/(?:armorer|velveteen|credentials|mcp)/u);
  expect(source).not.toMatch(/node:|bun:/u);
});

it('renders a synchronously validated seed on the server', async () => {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL('../tests/fixture/ssr.ts', import.meta.url))],
    target: 'bun',
    plugins: [sveltePlugin('server')],
  });
  expect(build.logs).toEqual([]);
  expect(build.success).toBe(true);
  const source = await build.outputs[0].text();
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  );
  expect(module.renderFixture()).toBe(SSR_SNAPSHOT);
});

it('builds and runs the portable client without resolving Svelte', async () => {
  const imports: string[] = [];
  const build = await Bun.build({
    entrypoints: [
      fileURLToPath(
        new URL(
          '../tests/fixture/generated/portable-operation-client.generated.ts',
          import.meta.url,
        ),
      ),
    ],
    target: 'bun',
    plugins: [
      {
        name: 'record-imports',
        setup(builder) {
          builder.onResolve({ filter: /.*/u }, ({ path }) => {
            imports.push(path);
          });
        },
      },
    ],
  });
  expect(build.success).toBe(true);
  expect(imports.filter((path) => path === 'svelte' || path.startsWith('svelte/'))).toEqual([]);
  const source = await build.outputs[0].text();
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  );
  const client = module.createProbeClientWithTransport(async (name: string, input: unknown) => ({
    name,
    input,
  }));
  expect(await client['probe.jobs.list']({ filter: 'a' })).toEqual({
    name: 'probe.jobs.list',
    input: { filter: 'a' },
  });
});

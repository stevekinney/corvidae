import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  compileComponent,
  compileRuneModule,
  createSveltePlugin,
  diagnoseComponent,
} from "./index";

const component = `<script lang="ts">import { createCounter } from './counter.svelte.ts'; const counter = createCounter(); let { label = 'Original' }: { label?: string } = $props();</script><button onclick={() => counter.increment()}>{label}: {counter.value}</button><style>button { color: rgb(1, 2, 3); }</style>`;

test("compiles a typed component for client and DOM-free server targets", () => {
  const client = compileComponent(component, {
    filename: "App.svelte",
    target: "client",
  });
  const server = compileComponent(component, {
    filename: "App.svelte",
    target: "server",
  });
  expect(client.code).toContain("svelte/internal/client");
  expect(server.code).toContain("svelte/internal/server");
  expect(client.css?.code).toContain("rgb(1, 2, 3)");
  expect(client.map).toContain("App.svelte");
});

test("compiles a typed rune module without executing a DOM", () => {
  const result = compileRuneModule(
    "export function createCounter() { let value: number = $state(0); return { get value() { return value }, increment() { value += 1 } }; }",
    { filename: "counter.svelte.ts" },
  );
  expect(result.code).toContain("createCounter");
  expect(result.code).toContain("state(0)");
});

test("preserves nontrivial TypeScript runtime syntax and source identity", () => {
  const source = `type Kind = "a" | "b";\nexport function describe(value?: Kind, handler?: (value: Kind) => string) {\n  const record: { kind: Kind } = { kind: value ?? "a" };\n  const text = handler?.(record.kind) as string | undefined;\n  return { record, text };\n}`;
  const result = compileRuneModule(source, {
    filename: "typed-rune.svelte.ts",
  });
  expect(result.code).toContain("record");
  expect(result.code).toContain("handler?.");
  expect(result.map).toContain("typed-rune.svelte.ts");
});

test("reports malformed source at the compiler boundary", () => {
  const result = diagnoseComponent("<script>let = ;</script>", {
    filename: "Broken.svelte",
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(String(result.error)).toContain("Broken.svelte");
});

test("plugin loaders emit valid inline maps for components and rune modules", async () => {
  const directory = await mkdtemp(join(import.meta.dir, "fixture-"));
  try {
    const loaders: Array<{
      filter: RegExp;
      callback: (args: { path: string }) => Promise<{ contents: string }>;
    }> = [];
    const plugin = createSveltePlugin({ css: "injected" });
    plugin.setup({
      onResolve() {},
      onLoad(
        options: { filter: RegExp },
        callback: (args: { path: string }) => Promise<{ contents: string }>,
      ) {
        loaders.push({ filter: options.filter, callback });
      },
    } as unknown as Parameters<typeof plugin.setup>[0]);
    for (const [name, source] of [
      ["Fixture.svelte", "<h1>Fixture</h1>"],
      ["fixture.svelte.ts", "export const value = $state(1);"],
    ]) {
      const path = join(directory, name!);
      await Bun.write(path, source!);
      const loader = loaders.find(({ filter }) => filter.test(path));
      expect(loader).toBeDefined();
      const output = await loader!.callback({ path });
      const match = output.contents.match(
        /sourceMappingURL=data:application\/json;base64,([^\s]+)/,
      );
      expect(match).not.toBeNull();
      const map = JSON.parse(Buffer.from(match![1]!, "base64").toString());
      expect(map.version).toBe(3);
      expect(map.sources.some((source: string) => source.endsWith(name!))).toBe(
        true,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bun browser build emits JavaScript and external CSS through the plugin", async () => {
  const directory = await mkdtemp(join(import.meta.dir, "fixture-"));
  try {
    await mkdir(join(directory, "src"));
    await Bun.write(join(directory, "src/App.svelte"), component);
    await Bun.write(
      join(directory, "src/counter.svelte.ts"),
      "export function createCounter() { let value = $state(0); return { get value() { return value }, increment() { value += 1 } }; }",
    );
    await Bun.write(
      join(directory, "src/main.ts"),
      "import App from './App.svelte'; export default App;",
    );
    const result = await Bun.build({
      entrypoints: [join(directory, "src/main.ts")],
      outdir: join(directory, "out"),
      target: "browser",
      plugins: [createSveltePlugin()],
    });
    expect(result.success).toBe(true);
    expect(result.outputs.some((output) => output.path.endsWith(".css"))).toBe(
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bun browser build supports injected CSS without emitting a stylesheet", async () => {
  const directory = await mkdtemp(join(import.meta.dir, "fixture-"));
  try {
    await mkdir(join(directory, "src"));
    await Bun.write(
      join(directory, "src/App.svelte"),
      `<h1 class="title">Injected</h1><style>.title { color: rgb(7, 8, 9); }</style>`,
    );
    await Bun.write(
      join(directory, "src/main.ts"),
      "import App from './App.svelte'; export default App;",
    );
    const result = await Bun.build({
      entrypoints: [join(directory, "src/main.ts")],
      outdir: join(directory, "out"),
      target: "browser",
      plugins: [createSveltePlugin({ css: "injected", hmr: false })],
    });
    expect(result.success).toBe(true);
    expect(result.outputs.some((output) => output.path.endsWith(".css"))).toBe(
      false,
    );
    const files = await Promise.all(
      result.outputs.map(async (output) => Bun.file(output.path).text()),
    );
    expect(files.some((file) => file.includes("color"))).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bun server build imports typed Svelte and rune output through compiler hooks", async () => {
  const directory = await mkdtemp(join(import.meta.dir, "fixture-"));
  try {
    let seenPath = "";
    let seenDevelopment = true;
    const mappedFilenames: string[] = [];
    await mkdir(join(directory, "src"));
    await Bun.write(
      join(directory, "src/App.svelte"),
      `<h1>Server</h1><style>h1 { color: red; }</style>`,
    );
    await Bun.write(
      join(directory, "src/counter.svelte.ts"),
      "export function createCounter() { let value = $state(3); return { get value() { return value; } }; }",
    );
    await Bun.write(
      join(directory, "src/main.ts"),
      "import App from './App.svelte'; import { createCounter } from './counter.svelte.ts'; export const probe = { component: App, value: createCounter().value };",
    );
    const result = await Bun.build({
      entrypoints: [join(directory, "src/main.ts")],
      outdir: join(directory, "out"),
      target: "bun",
      plugins: [
        createSveltePlugin({
          target: "server",
          css: "external",
          hmr: false,
          filename: (filename) => {
            const mapped = filename.replace(directory, "/consumer");
            mappedFilenames.push(mapped);
            return mapped;
          },
          allowStyleBlock: () => true,
          transformServerOutput: ({ code, path, dev }) => {
            seenPath = path;
            seenDevelopment = dev;
            return `${code}\nglobalThis.__velveteen_transformed = true;`;
          },
        }),
      ],
    });
    expect(result.success).toBe(true);
    const entry = result.outputs.find(
      (output) => output.kind === "entry-point",
    );
    expect(entry).toBeDefined();
    expect(seenPath).toBe(join(directory, "src/App.svelte"));
    expect(seenDevelopment).toBe(false);
    expect(mappedFilenames).toContain("/consumer/src/App.svelte");
    expect(mappedFilenames).toContain("/consumer/src/counter.svelte.ts");
    const imported = await import(`${entry!.path}?probe=${Date.now()}`);
    expect(imported.probe.value).toBe(3);
    expect(
      (globalThis as { __velveteen_transformed?: boolean })
        .__velveteen_transformed,
    ).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bun.plugin runtime registration imports authored CSS and typed runes", async () => {
  const directory = await mkdtemp(join(import.meta.dir, "fixture-"));
  try {
    await mkdir(join(directory, "src"));
    await Bun.write(
      join(directory, "src/App.svelte"),
      `<h1>Runtime</h1><style>h1 { color: red; }</style>`,
    );
    await Bun.write(
      join(directory, "src/counter.svelte.ts"),
      "export function counter() { let value = $state(5); return { get value() { return value; } }; }",
    );
    await Bun.write(
      join(directory, "src/main.ts"),
      "import App from './App.svelte'; import { counter } from './counter.svelte.ts'; export const probe = { App, value: counter().value };",
    );
    Bun.plugin(createSveltePlugin({ css: "injected", hmr: false }));
    const imported = await import(
      `${join(directory, "src/main.ts")}?runtime=${Date.now()}`
    );
    expect(typeof imported.probe.App).toBe("function");
    expect(imported.probe.value).toBe(5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("style policy rejects authored blocks but permits style directives", async () => {
  const directory = await mkdtemp(join(import.meta.dir, "fixture-"));
  try {
    await mkdir(join(directory, "src"));
    await Bun.write(
      join(directory, "src/main.ts"),
      "import App from './App.svelte'; export default App;",
    );
    await Bun.write(
      join(directory, "src/App.svelte"),
      "<h1 style:color={'red'}>Directive</h1>",
    );
    const directive = await Bun.build({
      entrypoints: [join(directory, "src/main.ts")],
      outdir: join(directory, "directive"),
      target: "browser",
      plugins: [
        createSveltePlugin({ allowStyleBlock: () => false, hmr: false }),
      ],
    });
    expect(directive.success).toBe(true);
    await Bun.write(
      join(directory, "src/App.svelte"),
      "<h1>Blocked</h1><style>h1 { color: red; }</style>",
    );
    let blockedError: unknown;
    try {
      await Bun.build({
        entrypoints: [join(directory, "src/main.ts")],
        outdir: join(directory, "blocked"),
        target: "browser",
        plugins: [
          createSveltePlugin({ allowStyleBlock: () => false, hmr: false }),
        ],
      });
    } catch (error) {
      blockedError = error;
    }
    const blockedMessage =
      blockedError instanceof AggregateError
        ? blockedError.errors.map(String).join("\n")
        : String(blockedError);
    expect(blockedMessage).toContain(join(directory, "src/App.svelte"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

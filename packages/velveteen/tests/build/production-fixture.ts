import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/** A fixture owns rendering/bootstrapping; the production graph only compiles and connects its modules. */
export async function writeProductionFixture(project: string) {
  const files: Record<string, string> = {
    "routes/+layout.svelte": `<script lang="ts">import type { Snippet } from 'svelte'; let { children }: { children: Snippet } = $props();</script><section class="frame">{@render children()}</section><style>.frame { border-top: 7px solid rgb(9, 8, 7); }</style>`,
    "routes/counter.svelte.ts": `export function counter() { let value: number = $state(0); return { get value() { return value; }, increment() { value += 1; } }; }`,
    "routes/fixture-label.ts": `export const incrementedLabel = 'First';`,
    "routes/+page.svelte": `<script lang="ts">import Layout from './+layout.svelte'; import { counter } from './counter.svelte.ts'; import { incrementedLabel } from './fixture-label.ts'; import logo from '../assets/logo.svg' with { type: 'file' }; const count = counter(); const firstLabel = typeof window === 'undefined' ? incrementedLabel : 'First'; if (process.env.NODE_ENV !== 'production') console.log('PRODUCTION_DEV_SENTINEL');</script><Layout><button onclick={() => count.increment()}>{count.value === 0 ? firstLabel : incrementedLabel}: {count.value}</button><img src={logo} alt="Logo" /><div class="background">First route</div></Layout><style>button { color: rgb(1, 2, 3); }.background { background-image: url('../assets/background.svg'); width: 20px; height: 20px; }</style>`,
    "routes/+page.server.ts": `export const privateToken = 'PRODUCTION_PRIVATE_SENTINEL'; export const load = () => ({ server: privateToken });`,
    "routes/+server.ts": `export const GET = () => Response.json({ compiledEndpoint: true });`,
    "routes/second/+page.svelte": `<script lang="ts">import Layout from '../+layout.svelte'; import { counter } from '../counter.svelte.ts'; const count = counter();</script><Layout><button onclick={() => count.increment()}>Second: {count.value}</button></Layout><style>button { color: rgb(4, 5, 6); }</style>`,
    "assets/logo.svg":
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
    "assets/background.svg":
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>',
    "static/plain.txt": "static production bytes\n",
    "static/hello world.txt": "encoded static filename\n",
  };
  for (const [file, content] of Object.entries(files)) {
    const path = join(project, file);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, content);
  }
  return {
    routesDirectory: join(project, "routes"),
    staticDirectory: join(project, "static"),
  };
}

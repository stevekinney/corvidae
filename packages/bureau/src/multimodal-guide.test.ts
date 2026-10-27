/**
 * COR-1249 — the executable copy of the multimodal example in this package's README ("Multimodal
 * content and managed assets").
 *
 * The example runs as written. `./index` stands in for `@lostgradient/bureau`, the handler is
 * called in process in place of a network, and `console` is a recorder, so each `console.log` is
 * a value the test asserts. A guard test compares the function's body with the README's code
 * block, so the two cannot drift: change the example and the documentation together.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createAgent,
  createModelCatalog,
  withBackendDescriptors,
  type GenerateFunction,
} from '@lostgradient/operative';
import { principalFromApiKey } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createBureau, createBureauHandler, createMemoryAssetStorage } from './index';

/** What the example's `console` records, in order. */
type Recorder = { log(...values: unknown[]): void };

// The README's example, from its first comment down.
async function example(console: Recorder): Promise<void> {
  // A backend's descriptor says which media it takes in and gives out. Bureau admits only what a
  // descriptor advertises, so a function with no descriptor is a text-only agent.
  const visionBackends = createModelCatalog().descriptors.filter(
    (descriptor) => descriptor.provider === 'anthropic',
  );
  const drawingBackends = visionBackends.map((descriptor) => ({
    ...descriptor,
    modalities: {
      ...descriptor.modalities,
      image: { ...descriptor.modalities.image, output: true },
    },
  }));

  // The viewer reads an image. The painter answers with one: a 1x1 PNG standing in for the bytes
  // a model returns.
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const pixel = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
  const view: GenerateFunction = async ({ conversation }) => {
    const kinds = conversation
      .getMessages()
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .map((part) => part.type);
    return { content: `I received: ${kinds.join(', ')}`, toolCalls: [] };
  };
  const paint: GenerateFunction = async () => ({
    content: 'Here it is.',
    parts: [
      { type: 'text', text: 'Here it is.' },
      {
        type: 'image',
        mimeType: 'image/png',
        source: { kind: 'inline', encoding: 'base64', data: png },
      },
    ],
    toolCalls: [],
  });
  const bureau = await createBureau({
    agents: {
      viewer: createAgent({
        name: 'viewer',
        generate: withBackendDescriptors(view, visionBackends),
      }),
      painter: createAgent({
        name: 'painter',
        generate: withBackendDescriptors(paint, drawingBackends),
      }),
    },
    // The asset service is what makes media possible: without `assets`, Bureau refuses media input
    // and has nowhere to put generated media.
    assets: { storage: createMemoryAssetStorage() },
  });

  // Admit: bytes become an asset the principal owns. `admit` answers at once with the asset's
  // identity, and `work.result()` waits for inspection and the safety gates to settle it, as a
  // value (`completed`, `failed` with the rejection, or `aborted`) and never a throw. The id is the
  // one the handler derives from an API key whose subject is `alice`.
  const alice = { id: 'api-key:alice' };
  const admission = await bureau.assets!.admit(
    { source: { kind: 'inline', bytes: pixel }, declaredMediaType: 'image/png' },
    alice,
  );
  const settled = await admission.work.result();
  if (settled.outcome !== 'completed') throw new Error('the asset was not admitted');
  console.log(settled.value.state, settled.value.mediaType); // 'available' 'image/png'

  // Input: a run takes an ordered list of parts. The asset travels as a reference, never as bytes.
  const viewing = await bureau.tasks.start(
    'viewer',
    [
      { type: 'text', text: 'What is in this picture?' },
      { type: 'image', mimeType: 'image/png', source: admission.source },
    ],
    { principal: alice.id },
  );
  const seen = await viewing.result();
  console.log(seen.content); // 'I received: text, image'

  // Output: media a model generates is admitted as the run's owner before anything sees it, so the
  // result holds a reference to an asset, and the bytes are read back through the asset service.
  const painting = await bureau.tasks.start('painter', 'Draw a pixel.', { principal: alice.id });
  const painted = await painting.result();
  const image = painted.parts.find((part) => part.type === 'image');
  if (image?.source.kind !== 'managed-asset') throw new Error('generated media is an asset');
  console.log(image.source.kind); // 'managed-asset'
  const owned = await bureau.assets!.resolve(image.source, alice);
  console.log(owned.content.kind === 'bytes' && owned.content.bytes.byteLength > 0); // true

  // Authority: the owner reads the asset, and anybody else is told it does not exist.
  const bob = { id: 'api-key:bob' };
  const refusal = await bureau.assets!.resolve(image.source, bob).catch((error: unknown) => error);
  console.log(refusal instanceof Error); // true

  // Wire: over HTTP the bytes come from the authenticated asset route, as the credential's owner.
  const keys: Record<string, string> = { 'alice-key': 'alice', 'bob-key': 'bob' };
  const handler = createBureauHandler(bureau, {
    authentication: {
      auditSink: () => undefined,
      resolveApiKeyPrincipal: async (key) =>
        keys[key] === undefined
          ? null
          : principalFromApiKey({ subject: keys[key], scopes: ['bureau.assets:read'] }),
    },
  });
  const route = `http://localhost/assets/${admission.assetId}/content`;
  const fetched = await handler(new Request(route, { headers: { 'X-API-Key': 'alice-key' } }));
  console.log(fetched.status, fetched.headers.get('Content-Type')); // 200 'image/png'
  const other = await handler(new Request(route, { headers: { 'X-API-Key': 'bob-key' } }));
  console.log(other.status); // 404: another owner's asset reads as missing

  await bureau.dispose();
}
// End of the README's example.

/** The README's example block, as written between its code fence. */
async function readmeExample(): Promise<string> {
  const readme = await readFile(join(import.meta.dir, '..', 'README.md'), 'utf8');
  const heading = readme.indexOf('\n### Multimodal content and managed assets\n');
  expect(heading).toBeGreaterThan(-1);
  const open = readme.indexOf('```typescript\n', heading);
  const close = readme.indexOf('\n```\n', open);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return readme.slice(open + '```typescript\n'.length, close);
}

/**
 * Code reduced to what a formatter cannot change: whitespace outside string literals is removed,
 * as are the commas before a closer that a formatter adds when it wraps a line, and whitespace
 * runs in a comment become one space. A string literal is compared exactly.
 */
function normalized(code: string): string {
  const tokens =
    /('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*)|([^'"`/]+|\/)/g;
  let result = '';
  for (const [, quoted, comment, other] of code.matchAll(tokens)) {
    if (quoted !== undefined) result += quoted;
    else if (comment !== undefined) result += `${comment.replace(/\s+/g, ' ')}\n`;
    else result += (other ?? '').replace(/\s+/g, '').replace(/,(?=[)\]}])/g, '');
  }
  return result;
}

describe('the multimodal example', () => {
  it('admits an asset, runs on it, receives generated media as an asset, and reads it back under its owner', async () => {
    const logged: unknown[][] = [];
    await example({ log: (...values) => void logged.push(values) });

    expect(logged).toEqual([
      ['available', 'image/png'],
      ['I received: text, image'],
      ['managed-asset'],
      [true],
      [true],
      [200, 'image/png'],
      [404],
    ]);
  });

  it('is the code block the README shows', async () => {
    const block = await readmeExample();
    const lines = block.split('\n');
    const start = lines.findIndex((line) => line.startsWith("// A backend's descriptor"));
    expect(start).toBeGreaterThan(-1);
    const source = await readFile(import.meta.path, 'utf8');
    const first = source.indexOf('async function example(');
    const last = source.indexOf('\n}\n// End of the README');
    expect(first).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(first);
    const body = source.slice(source.indexOf('{\n', first) + 2, last);

    expect(normalized(body)).toBe(normalized(lines.slice(start).join('\n')));
    // The README imports what the test imports, from the packages and not from `./index`.
    expect(lines.slice(0, start).join('\n')).toContain("from '@lostgradient/bureau'");
  });
});

/**
 * Hermetic fixtures for the managed-asset suites (COR-794): byte builders
 * for each format the admission pipeline inspects, scripted DNS and HTTP
 * ports, blocking ports for started-work tests, and a Bureau harness that
 * composes an asset service through `BureauOptions.assets`.
 *
 * Nothing here touches the network, real DNS, or a real timer.
 */
import type { ManualRuntimeServices } from '@lostgradient/lifecycle';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import type { GenerateFunction } from '@lostgradient/operative';

import type {
  AssetFetcher,
  AssetFetchRequest,
  AssetFetchResponse,
  AssetHostResolver,
  BureauAssetOptions,
} from '../assets';
import type { AssetService } from '../assets/types';
import { type BureauTestHarness, createBureauTestHarness } from '../test/harness';
import { createMemoryStorageFixture } from '../test/storage-fixtures';

const encoder = new TextEncoder();

export function textBytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/** A PNG signature and IHDR chunk declaring `width`×`height`, followed by `padding` filler bytes. */
export function pngBytes(width: number, height: number, padding = 16): Uint8Array {
  const header = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(25);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 13);
  ihdr.set(textBytes('IHDR'), 4);
  view.setUint32(8, width);
  view.setUint32(12, height);
  ihdr[16] = 8;
  ihdr[17] = 6;
  const filler = new Uint8Array(padding).fill(0x2a);
  return concatenate([header, ihdr, filler]);
}

/** A minimal PDF whose page tree names `pages` page objects. */
export function pdfBytes(pages: number): Uint8Array {
  const objects = Array.from(
    { length: pages },
    (_, index) => `${index + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj\n`,
  ).join('');
  return textBytes(
    `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
      `2 0 obj << /Type /Pages /Count ${pages} >> endobj\n${objects}%%EOF\n`,
  );
}

/** A RIFF/WAVE header — detected as `audio/wav`; duration comes only from the injected extractor. */
export function wavBytes(): Uint8Array {
  return concatenate([textBytes('RIFF'), new Uint8Array([36, 0, 0, 0]), textBytes('WAVEfmt ')]);
}

export function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  return Promise.withResolvers<T>();
}

/** Rejects with an `AbortError` the moment `signal` aborts — how a cooperative port honors a targeted abort. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * A DNS resolver scripted per host name: each lookup consumes the next
 * answer, and the last answer repeats. Records every lookup.
 */
export function scriptedResolver(
  answers: Readonly<Record<string, readonly (readonly string[])[]>>,
): {
  readonly resolveHost: AssetHostResolver;
  readonly lookups: string[];
} {
  const lookups: string[] = [];
  const positions = new Map<string, number>();
  return {
    lookups,
    resolveHost: async (hostname) => {
      lookups.push(hostname);
      const script = answers[hostname];
      if (!script || script.length === 0) throw new Error(`no scripted answer for ${hostname}`);
      const position = positions.get(hostname) ?? 0;
      positions.set(hostname, position + 1);
      return script[Math.min(position, script.length - 1)]!;
    },
  };
}

/** An HTTP port answering from a fixed route table keyed by full URL. Records every request. */
export function scriptedFetcher(routes: Readonly<Record<string, AssetFetchResponse>>): {
  readonly fetch: AssetFetcher;
  readonly requests: AssetFetchRequest[];
} {
  const requests: AssetFetchRequest[] = [];
  return {
    requests,
    fetch: async (request) => {
      requests.push(request);
      const route = routes[request.url];
      if (!route) return { status: 404, body: new Uint8Array() };
      return route;
    },
  };
}

export const generate: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });

export interface AssetHarness {
  readonly harness: BureauTestHarness;
  readonly assets: AssetService;
  readonly runtime: ManualRuntimeServices;
}

/**
 * A real Bureau composed over a manual runtime with `assets` configured, so
 * every asset operation runs under Bureau's own shutdown and
 * `assertBureauQuiescent` (via `harness.close()`) inspects it.
 */
export async function createAssetHarness(
  assets: BureauAssetOptions,
  runtime: ManualRuntimeServices = createManualRuntimeServices(),
): Promise<AssetHarness> {
  const harness = await createBureauTestHarness({
    agents: {},
    generate,
    runtime,
    storage: createMemoryStorageFixture(),
    assets,
  });
  const service = harness.bureau.assets;
  if (!service) throw new Error('Bureau did not compose the configured asset service');
  return { harness, assets: service, runtime };
}

export const alice = { id: 'alice' } as const;
export const bob = { id: 'bob' } as const;
export const mallory = { id: 'mallory' } as const;
export const auditor = { id: 'auditor', privileged: true } as const;
export const aliceAdministrator = { id: 'alice', privileged: true } as const;

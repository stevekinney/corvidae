/**
 * Type-level regression test: a real Gemini SDK client must satisfy the structural batch-client
 * interface this package advertises as an `options.client`, with no cast at the call site — and the
 * factory must be able to construct one internally without a cast either.
 *
 * Why this file exists: the SDKs' own parameter types are `interface`s, so they have no implicit
 * index signature and are *not* assignable to `Record<string, unknown>`. Declaring a structural
 * request parameter that way fails both directions of the bivariant method check, which makes
 * `createGeminiBatchClient({ client })` — the documented escape hatch for a non-default base URL —
 * impossible to call without `as unknown as`. The same trap already cost a migration once; see
 * `GeminiGenerateContentRequest` in `gemini-types.ts` and `gemini-client-assignability.test-d.ts`.
 *
 * This assertion also pins down a fact worth failing loudly on: `@google/genai` exposes batches on
 * the client's own `batches` namespace rather than under `models`.
 *
 * Why the `.test-d.ts` suffix: `tsconfig.json` includes `src`, so `bun run check-types` checks this
 * file, while `tsconfig.build.json` excludes the suffix, so it never reaches `dist/` and cannot leak
 * an SDK type into the published declarations. It declares only types, so it is erased entirely and
 * contributes no coverage.
 */
import type { GoogleGenAI } from '@google/genai';

import type { GeminiBatchClient } from './gemini-types.ts';

/** Fails to compile unless `T` resolves to exactly `true`. */
type Assert<T extends true> = T;

/** `createGeminiBatchClient({ client })` accepts a real `GoogleGenAI`. */
export type GoogleGenAiSatisfiesBatchClient = Assert<
  GoogleGenAI extends GeminiBatchClient ? true : false
>;

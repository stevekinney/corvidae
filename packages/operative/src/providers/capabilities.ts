import { type BackendDescriptor, createModelCatalog } from './model-catalog.ts';
import type { ProviderName } from './types.ts';

/**
 * What a provider can be asked to do beyond a plain generate call.
 *
 * Each flag names a *native* provider mechanism, not an operative feature.
 * Operative's rule for all four is progressive enhancement: expose the
 * provider's own mechanism where one exists, and export nothing at all where
 * one does not. "Unsupported" is a compile-time fact — there is no module to
 * import — never a factory that throws or silently no-ops at runtime. This
 * object is how a caller reads that fact at runtime, for a provider chosen
 * dynamically.
 */
export interface ProviderCapabilities {
  /**
   * The provider has a native asynchronous batch endpoint. See
   * `providers/batches/` — one factory per provider that has one, and no
   * factory for the ones that do not.
   */
  readonly batchInference: boolean;
  /**
   * A request can ask for extended thinking explicitly, as its own request
   * field. A reasoning-*effort tier* (`Effort`, mapped in
   * a provider package's effort table) is a different, weaker thing and does not
   * count: it selects how hard the model tries, not whether thinking is
   * requested and returned.
   */
  readonly explicitThinkingRequest: boolean;
  /**
   * The request itself controls prompt caching — the caller marks what to
   * cache, per request. Implicit or automatic caching the provider applies on
   * its own does not count, because the request cannot steer it.
   */
  readonly requestControlledContextCaching: boolean;
  /**
   * The provider can count the tokens in a request server-side, before it is
   * sent for generation. A client-side estimator does not count.
   */
  readonly serverSideTokenCounting: boolean;
}

const NO_CAPABILITIES: ProviderCapabilities = {
  batchInference: false,
  explicitThinkingRequest: false,
  requestControlledContextCaching: false,
  serverSideTokenCounting: false,
};

/**
 * Reports which of the four capabilities a provider supports.
 *
 * Synchronous and side-effect-free by design: it makes no network call and
 * performs no provider discovery, so it is safe to call while assembling a
 * request, in a routing decision, or in a UI that renders which options to
 * offer. It answers from the catalog rows the caller passes for the provider,
 * which a provider's package ships against its SDK (`@anthropic-ai/sdk`,
 * `openai`, `@google/genai`).
 *
 * ## What each provider reports
 *
 * | Provider | Batch | Thinking | Caching | Token counting |
 * | --- | --- | --- | --- | --- |
 * | `anthropic` | yes | yes | yes | yes |
 * | `openai` (default endpoint) | yes | no | no | no |
 * | `openai` (custom `baseURL` **or** `OPENAI_BASE_URL` set when its rows are built) | no | no | no | no |
 * | `gemini` | yes | no | yes | yes |
 * | a provider whose rows are not passed | no | no | no | no |
 *
 * The table is what each vendor package's rows (`anthropicRows()`, `openAIRows()`,
 * `geminiRows()`) state when they are passed as `options.descriptors`. Operative holds no row of
 * its own (COR-2151), so with no descriptors every provider reports `false`.
 *
 * `voyage` and `ollama` are embedding-only providers: their embedders are the
 * `voyage` and `ollama` Interborough plugins, and operative ships no generate
 * function for either, so none of these four generation-time capabilities
 * applies. All `false` is the honest report, not a placeholder.
 *
 * ## Conservative by construction
 *
 * Reporting `true` for a capability nothing backs is worse than reporting `false` for one that
 * happens to exist: a `false` costs a caller a fallback path, while a wrong `true` costs them a
 * failed request they were told to expect to work. So the answer folds each flag with `every` over
 * the rows of `provider`, and a provider with no rows reports every flag `false`. The function
 * itself reads no environment and no base URL: what an endpoint serves is stated by the rows its
 * provider's package contributes. `openAIRows({ baseURL })` reads the endpoint (the option, then
 * `OPENAI_BASE_URL`) and, when either is set, marks its rows ambiguous: they report no batch
 * inference and an `unknown` availability, because the request may reach a server that is not
 * OpenAI's. So the answer can differ between two processes only through the rows they pass.
 *
 * ## Descriptor projection (AB-64)
 *
 * This surface is a projection over `BackendDescriptor` rows: it groups the rows passed for
 * `provider` and folds each of the four flags across them (`caching` stands in for
 * `requestControlledContextCaching`).
 *
 * @param provider - The provider to report on.
 * @param options.descriptors - Rows a loaded provider contributes, folded into the answer for a
 *   provider they name. Each must name its provider in the
 *   provider-name grammar.
 */
export function getProviderCapabilities(
  provider: ProviderName,
  options?: { readonly descriptors?: readonly BackendDescriptor[] | undefined },
): ProviderCapabilities {
  const rows = createModelCatalog({ descriptors: options?.descriptors }).descriptors.filter(
    (descriptor) => descriptor.provider === provider,
  );
  // A provider with no rows is unavailable, and an empty `every` would otherwise answer `true`.
  if (rows.length === 0) return NO_CAPABILITIES;
  return {
    batchInference: rows.every((row) => row.batchInference),
    explicitThinkingRequest: rows.every((row) => row.explicitThinkingRequest),
    requestControlledContextCaching: rows.every((row) => row.caching),
    serverSideTokenCounting: rows.every((row) => row.serverSideTokenCounting),
  };
}

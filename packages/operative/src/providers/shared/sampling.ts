/**
 * Anthropic `temperature`/`top_p` support by resolved model ID — the single
 * source of truth behind both the model catalog's advertised
 * `parameterCompatibility` and the Anthropic provider's pre-request guard.
 * Every decision below was confirmed 2026-10-14 against Anthropic's
 * documentation:
 *
 * - `rejected`: the model returns a 400 for any non-default `temperature` or
 *   `top_p` (and `top_k`). The migration guides say to omit all three.
 *   - Opus 5.5, Opus 5, Opus 4.8, Opus 4.7:
 *     https://platform.claude.com/docs/en/models/opus-5-5/migration-guide —
 *     "Setting `temperature`, `top_p`, or `top_k` to any non-default value on
 *     Claude Opus 4.7 and later models, including Claude Opus 5.5, returns a
 *     400 error", and the request requirements list: "Omit `temperature`,
 *     `top_p`, and `top_k`, or leave them at their defaults: any other value
 *     is rejected."
 *   - Fable 5.1, Mythos 5.1, Fable 5, Mythos 5:
 *     https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1 —
 *     "Non-default `temperature`, `top_p`, or `top_k` values return a 400
 *     error", listed as unchanged from Claude Fable 5. Claude Mythos 5.1 "offers
 *     the same capabilities" as Fable 5.1 and Claude Mythos 5 "has the same
 *     specifications" as Fable 5
 *     (https://platform.claude.com/docs/en/models/mythos-5-1/overview and
 *     https://platform.claude.com/docs/en/models/mythos-5/overview).
 *   - Sonnet 5.5: https://platform.claude.com/docs/en/models/sonnet-5-5/overview
 *     ("Setting `temperature`, `top_p`, or `top_k` to a non-default value
 *     returns a 400 error") and its migration guide.
 *   - Sonnet 5: https://platform.claude.com/docs/en/models/sonnet-5/overview
 *     (same sentence).
 * - `defaults-only`: Haiku 5.5. "Omit all three", but `temperature` 1 or `top_p`
 *   0.99 is accepted on its own; see {@link HAIKU_5_5_SAMPLING_DEFAULTS}. The
 *   model is not a place to tune sampling, so the catalog does not advertise it.
 * - `accepted`: the model takes sampling parameters.
 *   - Sonnet 4.6, Haiku 4.5 (alias and pinned snapshot) and every earlier
 *     Sonnet: https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide —
 *     "Claude Sonnet 4.6 and earlier models and Claude Haiku 4.5 accept
 *     `temperature`, `top_p`, and `top_k`"; also
 *     https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide
 *     ("Claude Haiku 4.5 accepts `temperature`, `top_p`, and `top_k`").
 *   - Opus 4.6, Opus 4.5 and the dated Opus 4 snapshot: the removal began at
 *     "Claude Opus 4.7 and later models"
 *     (https://platform.claude.com/docs/en/models/opus-5-5/migration-guide), so
 *     earlier Opus models still accept them.
 * - Unsettled (no entry): the pages above do not name `claude-haiku-4-20250506`
 *   or `claude-3-5-haiku-20241022`, nor any ID absent from this table. The
 *   catalog does not advertise sampling for an unsettled model, and the
 *   provider does not guard it — the request is sent and a 400 is classified
 *   after the fact (COR-989).
 *
 * `toolChoice` is deliberately not decided here: `auto` and `none` stay valid
 * on models that reject forced tool choice, so the catalog keeps advertising it.
 */
export type SamplingSupport = 'accepted' | 'rejected' | 'defaults-only' | 'unsettled';

/**
 * Haiku 5.5 is the one model whose documentation gives accepted values
 * (https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide,
 * confirmed 2026-10-14): "If a request includes temperature, it must be 1. If
 * it includes top_p, it must be 0.99, its default. Any other temperature or
 * top_p value returns a 400 error, including a top_p of 1. So does any top_k
 * value, and so does a request that includes both temperature and top_p." So
 * each is accepted alone at its default, and sending both is rejected even at
 * the defaults.
 */
export const HAIKU_5_5_SAMPLING_DEFAULTS = Object.freeze({ temperature: 1, topP: 0.99 });

export const ANTHROPIC_SAMPLING_SUPPORT: Readonly<
  Record<string, 'accepted' | 'rejected' | 'defaults-only'>
> = Object.freeze({
  'claude-fable-5-1': 'rejected',
  'claude-mythos-5-1': 'rejected',
  'claude-fable-5': 'rejected',
  'claude-mythos-5': 'rejected',
  'claude-opus-5-5': 'rejected',
  'claude-opus-5': 'rejected',
  'claude-opus-4-8': 'rejected',
  'claude-opus-4-7': 'rejected',
  'claude-sonnet-5-5': 'rejected',
  'claude-sonnet-5': 'rejected',
  'claude-haiku-5-5': 'defaults-only',
  'claude-opus-4-6': 'accepted',
  'claude-opus-4-5': 'accepted',
  'claude-sonnet-4-6': 'accepted',
  'claude-haiku-4-5': 'accepted',
  'claude-opus-4-20250514': 'accepted',
  'claude-sonnet-4-20250514': 'accepted',
  'claude-3-5-sonnet-20241022': 'accepted',
});

export function anthropicSamplingSupport(resolvedModel: string): SamplingSupport {
  return ANTHROPIC_SAMPLING_SUPPORT[resolvedModel] ?? 'unsettled';
}

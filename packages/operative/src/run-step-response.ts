import type { MultiModalContent } from 'conversationalist';

import {
  GeneratedMediaNotAdmittedError,
  ResponsePartsMismatchError,
  type ResponsePartsMismatchSource,
} from './errors';
import { admitInlineMedia, type StepGeneratedMediaAdmitter } from './generated-media';
import { concatenateTextParts, deriveParts } from './response-parts';
import type { GenerateResponse } from './types';

/**
 * The one place the loop applies the post-hook rule for a response's parts. The response a
 * phase leaves behind is authoritative:
 *
 * - A response with no `parts` (a hook that returned `content` alone) has them derived as
 *   text only (see {@link partsOf}), so every non-text part the provider returned is dropped. An output guardrail
 *   that redacts therefore leaves nothing unredacted in the parts, the row or the next request.
 * - A response with `parts` whose text parts do not concatenate to `content` is a hook that
 *   changed the text and kept stale parts. The step fails with a {@link ResponsePartsMismatchError};
 *   it never proceeds with them.
 * - A response that passes every hook unchanged keeps its parts.
 *
 * Every media part still carrying inline bytes is then admitted as a managed asset through
 * `admitter`. Admission is idempotent: a part that is already a managed asset is left alone, so
 * settling the same response again at the next phase admits nothing twice. Because the generation
 * phase settles right after `generate` returns, no hook, event, row or persisted result ever sees
 * inline bytes; `GenerateMiddleware`, which wraps `generate`, is the only code that can.
 *
 * It runs once per phase that can hand the loop a replacement response (after `generate` or
 * `prepareStep`, after the `afterGenerate` handlers, after the `validateResponse` hooks), never per
 * handler: a waterfall may hand a later handler exactly what an earlier one returned, and what must
 * hold is that the response leaving each phase satisfies the rule.
 *
 * Throws the billed usage of `response` on the error, so the loop can account for a response it is
 * about to discard.
 */
export async function settleResponse(
  response: GenerateResponse,
  source: ResponsePartsMismatchSource,
  input: { readonly step: number; readonly admitter: StepGeneratedMediaAdmitter },
): Promise<GenerateResponse> {
  // A response with no parts is text only by construction (its parts derive from `content` at
  // commit), so there is nothing stale to check and nothing to admit. It stays that way, which is
  // what lets a hook that spreads `{ ...response, content }` keep working on a `generate` that
  // never knew about parts.
  if (response.parts === undefined) return response;

  const text = concatenateTextParts(response.parts);
  if (text !== response.content) {
    throw new ResponsePartsMismatchError({
      step: input.step,
      source,
      contentLength: response.content.length,
      textPartsLength: text.length,
      usage: response.usage,
    });
  }
  const parts = response.parts;

  let admitted: readonly MultiModalContent[];
  try {
    admitted = await admitInlineMedia(input.admitter, parts, { step: input.step });
  } catch (error) {
    if (error instanceof GeneratedMediaNotAdmittedError && error.usage === undefined) {
      error.usage = response.usage;
    }
    throw error;
  }

  return admitted === parts ? response : { ...response, parts: admitted };
}

/**
 * The parts a settled response commits: its own, or the single text part (none when empty) that
 * its `content` derives. A hook that returned `content` alone therefore gets text-only parts.
 */
export function partsOf(response: GenerateResponse): readonly MultiModalContent[] {
  return response.parts ?? deriveParts(response.content);
}

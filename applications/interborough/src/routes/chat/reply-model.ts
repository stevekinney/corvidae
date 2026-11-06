/**
 * The model a reply was written by (COR-2014), as the Bureau recorded it on the reply's row, and
 * its name for a person. A reply names its own model, never the one the chat runs on now: a chat
 * switched from Haiku to Sonnet keeps its earlier replies under Haiku. A reply the Bureau recorded
 * no model for (a scripted agent's, or one written before the Bureau kept it) names none.
 */
import type { AgentModelChoice } from '../../lib/bureau-client.ts';
import { modelDisplayName } from './agent-model.ts';

/**
 * Where the Bureau keeps a reply's model on its row: `REPLY_MODEL_METADATA_KEY` in Bureau's
 * `file-agent-generate.ts`, which every snapshot of the thread carries in the row's metadata.
 */
export const REPLY_MODEL_METADATA_KEY = 'bureau:replyModel';

/** The catalog row a reply was written by. */
export type ReplyModel = { readonly provider: string; readonly model: string };

/** The model `metadata` records for its reply, or `undefined` when it records none. */
export function replyModelOf(
  metadata: Readonly<Record<string, unknown>> | undefined,
): ReplyModel | undefined {
  const value = metadata?.[REPLY_MODEL_METADATA_KEY];
  if (typeof value !== 'object' || value === null) return undefined;
  const provider: unknown = Reflect.get(value, 'provider');
  const model: unknown = Reflect.get(value, 'model');
  return typeof provider === 'string' && typeof model === 'string' && model !== ''
    ? { provider, model }
    : undefined;
}

/**
 * The name a person reads for `replyModel`: the display name the agent's models give it when it is
 * a label of its own, else the one `modelDisplayName` writes ("Claude Sonnet 5.5"), which is the
 * model's own name for any model it knows no form of. The Bureau's catalog holds no label, so its
 * `displayName` is the provider's model name, as `modelInUse` reads it too.
 */
export function replyModelLabel(
  replyModel: ReplyModel,
  choices: readonly Pick<AgentModelChoice, 'provider' | 'model' | 'displayName'>[],
): string {
  const choice = choices.find(
    (candidate) =>
      candidate.provider === replyModel.provider && candidate.model === replyModel.model,
  );
  return choice !== undefined && choice.displayName !== choice.model
    ? choice.displayName
    : modelDisplayName(replyModel.model);
}

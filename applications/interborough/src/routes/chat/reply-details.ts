/**
 * What a reply's details say (COR-1983), from the two sources that carry anything: the step
 * `bureau.tasks.inspect` records (why it ran on its model, what the model saw) and the run's terminal
 * event (the tokens the run used). A value neither source carries is left out, never worked out:
 * the model's name, the effort, the cost and the time are not here, because no source gives them.
 */
import { CHAT_COPY } from '../../app/copy.ts';
import type { TaskStep } from '../../lib/bureau-tasks.ts';
import { formatTokens } from './context-window.ts';
import type { RunUsage } from './run-wiring.ts';

const COPY = CHAT_COPY.replyDetails;

/** The Bureau names the assistant row of a run's step `<runId>:step:<n>`. */
const STEP_ROW = /^(.+):step:(\d+)$/;

/** The run and step a transcript row is the reply of. */
export type ReplyStep = { readonly runId: string; readonly step: number };

/** The run and step a row is the reply of, or `undefined` for a row the Bureau did not name as one. */
export function replyStepOf(rowId: string): ReplyStep | undefined {
  const match = STEP_ROW.exec(rowId);
  if (match === null) return undefined;
  return { runId: match[1]!, step: Number(match[2]) };
}

/** The reply details of one step, in the words the popover prints. Every section may be absent. */
export type ReplyDetails = {
  readonly why:
    | {
        readonly reason: string;
        readonly detail: string;
        readonly passedOver: readonly string[];
      }
    | undefined;
  readonly saw:
    | {
        readonly messages: string;
        readonly truncated: boolean;
        readonly sources: readonly string[];
      }
    | undefined;
  readonly usage: readonly { readonly kind: string; readonly tokens: string }[];
};

/** The tokens a run reported, one entry for each count it carried, in the order input, output, total. */
export function usageEntries(
  usage: RunUsage | undefined,
): readonly { readonly kind: string; readonly tokens: string }[] {
  if (usage === undefined) return [];
  const kinds = COPY.usageKinds;
  return [
    ...(usage.inputTokens === undefined
      ? []
      : [{ kind: kinds.input, tokens: formatTokens(usage.inputTokens) }]),
    ...(usage.outputTokens === undefined
      ? []
      : [{ kind: kinds.output, tokens: formatTokens(usage.outputTokens) }]),
    ...(usage.totalTokens === undefined
      ? []
      : [{ kind: kinds.total, tokens: formatTokens(usage.totalTokens) }]),
  ];
}

/**
 * The details to print for a step and its run's usage. `step` is `undefined` while the Bureau has
 * not answered and `null` when it answered that the run recorded none; the plan and the context are each left out when the step has none.
 */
export function replyDetailsOf(
  step: TaskStep | null | undefined,
  usage: RunUsage | undefined,
): ReplyDetails {
  const plan = step?.planReason ?? null;
  const context = step?.effectiveContext ?? null;
  return {
    why:
      plan === null
        ? undefined
        : {
            reason: COPY.planReasons[plan.code],
            detail: plan.detail,
            passedOver: plan.rejected.map((rejected) =>
              COPY.rejection(
                rejected.provider,
                rejected.model,
                COPY.passedOverReasons[rejected.code],
              ),
            ),
          },
    saw:
      context === null
        ? undefined
        : {
            messages: COPY.messages(context.messageCount),
            truncated: context.truncated,
            // A source absent by composition was never a candidate for this prompt, so it says nothing.
            sources: context.sources.flatMap((source) =>
              source.disposition === 'absent-by-composition'
                ? []
                : [
                    COPY.source(
                      source.sourceId,
                      COPY.dispositions[source.disposition],
                      source.reason,
                    ),
                  ],
            ),
          },
    usage: usageEntries(usage),
  };
}

/** Whether there is nothing to print: no plan, no context and no usage. */
export function isEmptyDetails(details: ReplyDetails): boolean {
  return details.why === undefined && details.saw === undefined && details.usage.length === 0;
}

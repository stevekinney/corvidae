<script lang="ts" module>
  import type { ToolCallMessagePart } from '../../utilities/types.ts';
  import type { ChatTurnLabels } from '../turn-labels.ts';

  export type ToolCallPartProps = {
    /** The tool-call render part (call + optional resolved result). */
    part: ToolCallMessagePart;
    /** Owning message occurrence ID, used to avoid duplicated nested timeline IDs. */
    messageId?: string | undefined;
    /** Whether the tool-call card is expanded. Owned by the message. */
    expanded?: boolean;
    /** Called when the card's disclosure toggle is activated. */
    onToggle?: (() => void) | undefined;
    activityActive?: boolean;
    /** Called with the call's id when the person chooses Retry this step after it failed. The button shows only when this is set. */
    onRetryStep?: ((toolCallId: string) => void) | undefined;
    /** How long the call took, in milliseconds, once it has a result. */
    durationMilliseconds?: number | undefined;
    /** When the call started, in milliseconds since the Unix epoch; a call under way counts from it. */
    startedAt?: number | undefined;
    /** The words of the step's position, its failed count and a failed step's controls. */
    labels?: Partial<ChatTurnLabels> | undefined;
    /** The calls a card in the same turn (an approval or a question) already speaks for. */
    cardOwnedCallIds?: ReadonlySet<string> | undefined;
  };
</script>

<script lang="ts">
  import ToolCallTimeline from '../tool-call-timeline.svelte';

  let {
    part,
    messageId,
    expanded = false,
    onToggle,
    activityActive = true,
    onRetryStep,
    durationMilliseconds,
    startedAt,
    labels,
    cardOwnedCallIds,
  }: ToolCallPartProps = $props();

  const pairs = $derived([part.pair]);
  const timelineMessageId = $derived(
    messageId === undefined ? part.pair.call.id : `${messageId}-tool-call-${part.pair.call.id}`,
  );
  const approvalStates = $derived(
    part.approvalState === undefined
      ? undefined
      : new Map([[part.pair.call.id, part.approvalState]]),
  );
  const durations = $derived(
    durationMilliseconds === undefined
      ? undefined
      : new Map([[part.pair.call.id, durationMilliseconds]]),
  );
  const startTimes = $derived(
    startedAt === undefined ? undefined : new Map([[part.pair.call.id, startedAt]]),
  );
  const describeToolCall = $derived(
    part.presentation === undefined ? undefined : () => part.presentation,
  );
</script>

<!--
  A tool invocation paired with its result, if one has arrived. The timeline
  owns its compact detail disclosure state so all tool activity shares one
  hierarchy.
-->
<ToolCallTimeline
  {pairs}
  messageId={timelineMessageId}
  {...describeToolCall === undefined ? {} : { describeToolCall }}
  {expanded}
  {onToggle}
  {activityActive}
  {approvalStates}
  {durations}
  {startTimes}
  {onRetryStep}
  {labels}
  {cardOwnedCallIds}
/>

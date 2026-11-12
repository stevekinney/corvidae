<script lang="ts">
  /**
   * What the last breadcrumb of an open chat opens (board ChatPage frame b): the session (its whole
   * identifier, with a button that copies it), the agent (a link, its identifier small and in
   * monospace), when the chat started and was last active, and an "As run" group of what the chat
   * ran with, in display names with the model's identifier small beside it.
   *
   * It is plain data in and markup out: the page reads the session, the agent's models and the
   * clock, and hands this what to say. A fact the page has not read yet is left out of the list
   * rather than guessed, so the popover of a chat that could not be read still names the session and
   * its agent.
   */
  import { CopyButton, DescriptionList, type DescriptionListItem } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import type { Effort, PermissionMode } from '../../lib/bureau-client.ts';
  import { dayAndTime, clockTime, calendarDay } from '../../lib/format/clock.ts';

  interface ChatDetailsProps {
    /** The session's identifier, shown whole. */
    sessionId: string;
    /** The agent's identifier, as the address and the Bureau name it. */
    agent: string;
    /** The agent as a person reads it ("Tool runner"). */
    agentLabel: string;
    /** Where the agent's page is. */
    agentHref: string;
    /** Opens the agent's page without leaving the application. */
    onOpenAgent: (event: MouseEvent) => void;
    /** When the chat started, in epoch milliseconds, or `null` when the Bureau's time is unreadable. */
    startedAt: number | null;
    /** When the chat last changed, in epoch milliseconds, or `null` when it is unreadable. */
    lastActiveAt: number | null;
    /** The time the page is reading, in epoch milliseconds, which decides what "Today" means. */
    now: number;
    /**
     * What the chat ran with. `undefined` until the session has been read, which leaves the "As run"
     * group out; `model` is `null` when neither the chat nor its agent names one.
     */
    asRun?:
      | {
          readonly model: { readonly displayName: string; readonly model: string } | null;
          readonly effort: Effort | null;
          readonly permissionMode: PermissionMode;
        }
      | undefined;
  }

  let {
    sessionId,
    agent,
    agentLabel,
    agentHref,
    onOpenAgent,
    startedAt,
    lastActiveAt,
    now,
    asRun,
  }: ChatDetailsProps = $props();

  const COPY = CHAT_COPY.details;
  const SETTINGS = CHAT_COPY.settings;

  /** "Today, 10:30 AM, last active 10:45 AM", with the day named again when the chat moved on a later day. */
  const started = $derived.by((): string | undefined => {
    if (startedAt === null) return undefined;
    const begun = dayAndTime(startedAt, now);
    if (lastActiveAt === null) return begun;
    const sameDay = calendarDay(lastActiveAt) === calendarDay(startedAt);
    const active = sameDay ? clockTime(lastActiveAt) : dayAndTime(lastActiveAt, now);
    return `${begun}, ${COPY.lastActive(active)}`;
  });

  const sessionItems = $derived<DescriptionListItem[]>([
    { id: 'session', term: COPY.sessionId, definition: sessionValue },
    { id: 'agent', term: COPY.agent, definition: agentValue },
    ...(started === undefined ? [] : [{ id: 'started', term: COPY.started, definition: started }]),
  ]);

  const asRunItems = $derived<DescriptionListItem[]>(
    asRun === undefined
      ? []
      : [
          { id: 'model', term: COPY.model, definition: modelValue },
          {
            id: 'effort',
            term: COPY.effort,
            definition:
              SETTINGS.effortOptions.find((option) => option.value === asRun.effort)?.label ??
              SETTINGS.agentDefault,
          },
          {
            id: 'permissions',
            term: COPY.permissions,
            definition:
              SETTINGS.permissionOptions.find((option) => option.value === asRun.permissionMode)
                ?.label ?? asRun.permissionMode,
          },
        ],
  );
</script>

{#snippet sessionValue()}
  <span class="weft-chat-details__identifier">
    <code class="ib-identifier" data-testid="chat-details-session">{sessionId}</code>
    <CopyButton
      value={sessionId}
      label={COPY.copySessionId}
      copiedLabel={`${COPY.sessionId} copied`}
      iconOnly
    />
  </span>
{/snippet}

{#snippet agentValue()}
  <a class="weft-chat-details__agent" href={agentHref} onclick={onOpenAgent}>{agentLabel}</a>
  <code class="ib-identifier weft-chat-details__small">{agent}</code>
{/snippet}

{#snippet modelValue()}
  {#if asRun?.model}
    {asRun.model.displayName}
    {#if asRun.model.displayName !== asRun.model.model}
      <code class="ib-identifier weft-chat-details__small">{asRun.model.model}</code>
    {/if}
  {:else}
    {SETTINGS.agentDefault}
  {/if}
{/snippet}

<div class="weft-chat-details" data-testid="chat-details">
  <DescriptionList items={sessionItems} variant="two-column" />
  {#if asRunItems.length > 0}
    <section class="weft-chat-details__group" aria-labelledby="weft-chat-details-as-run">
      <h3 class="weft-chat-details__heading" id="weft-chat-details-as-run">{COPY.asRun}</h3>
      <DescriptionList items={asRunItems} variant="two-column" />
    </section>
  {/if}
</div>

<script lang="ts">
  /**
   * What the last breadcrumb of an open chat opens (board ChatPage frame b; owner review
   * 2026-11-19): a compact list of the agent (a link, by name alone), when the chat started (and,
   * on a row of its own, when it was last active, only when that differs), and the chat's settings
   * by display name, the effort saying what it resolves to. Under the list a quiet "Copy session ID"
   * action copies the session's identifier; the identifier itself is never a headline row.
   *
   * It is plain data in and markup out, except for the agent's definition, read only to say which
   * effort an unset one resolves to. A fact the page has not read yet is left out of the list rather
   * than guessed, so the popover of a chat that could not be read still names the agent and copies
   * the session.
   */
  import { CopyButton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import { getAgentDefinition } from '../../lib/agent-definitions.ts';
  import type { Effort, PermissionMode } from '../../lib/bureau-client.ts';
  import { dayAndTime, clockTime, calendarDay } from '../../lib/format/clock.ts';
  import { queryKeys } from '../../lib/query.ts';

  interface ChatDetailsProps {
    /** The session's identifier, which the quiet action at the bottom copies. */
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
     * What the chat runs with. `undefined` until the session has been read, which leaves the
     * settings out; `model` is `null` when neither the chat nor its agent names one.
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

  // The agent's own effort, read only when the chat left its effort unset.
  const definition = createQuery(
    () => ({
      queryKey: queryKeys.agents.definition(agent),
      queryFn: ({ signal }) => getAgentDefinition(agent, { signal }),
      enabled: asRun !== undefined && asRun.effort === null,
      retry: false,
    }),
    undefined,
  );

  const effortLabel = (effort: Effort | null | undefined): string | undefined =>
    SETTINGS.effortOptions.find((option) => option.value === effort)?.label;

  /** "Medium", or for an unset effort what it resolves to: "Medium, the agent's default". */
  const effort = $derived.by((): string => {
    const own = effortLabel(asRun?.effort);
    if (own !== undefined) return own;
    const data = definition.data;
    if (data === undefined || data.definition === null) return COPY.unknownEffort;
    const agentOwn = effortLabel(data.definition.effort);
    return agentOwn === undefined ? COPY.modelEffort : COPY.agentEffort(agentOwn);
  });

  /** "Today, 10:30 AM". */
  const started = $derived(startedAt === null ? undefined : dayAndTime(startedAt, now));

  /**
   * When the chat last changed, on a row of its own, or `undefined` when it is unreadable or reads
   * the same as the start (the same minute): the day is named again only when it is a later day.
   */
  const lastActive = $derived.by((): string | undefined => {
    if (startedAt === null || lastActiveAt === null) return undefined;
    const sameDay = calendarDay(lastActiveAt) === calendarDay(startedAt);
    if (sameDay && clockTime(lastActiveAt) === clockTime(startedAt)) return undefined;
    return sameDay ? clockTime(lastActiveAt) : dayAndTime(lastActiveAt, now);
  });
</script>

<div class="weft-chat-details" data-testid="chat-details">
  <dl class="weft-chat-details__list">
    <div class="weft-chat-details__row">
      <dt>{COPY.agent}</dt>
      <dd>
        <a class="weft-chat-details__agent" href={agentHref} onclick={onOpenAgent}>{agentLabel}</a>
      </dd>
    </div>
    {#if started !== undefined}
      <div class="weft-chat-details__row">
        <dt>{COPY.started}</dt>
        <dd>{started}</dd>
      </div>
    {/if}
    {#if lastActive !== undefined}
      <div class="weft-chat-details__row">
        <dt>{COPY.lastActive}</dt>
        <dd>{lastActive}</dd>
      </div>
    {/if}
  </dl>
  {#if asRun !== undefined}
    <!-- What the chat runs with, as plain settings under a quiet rule, with no heading. -->
    <dl class="weft-chat-details__list" data-testid="chat-details-settings">
      <div class="weft-chat-details__row">
        <dt>{COPY.model}</dt>
        <dd>{asRun.model?.displayName ?? SETTINGS.agentDefault}</dd>
      </div>
      <div class="weft-chat-details__row">
        <dt>{COPY.effort}</dt>
        <dd>{effort}</dd>
      </div>
      <div class="weft-chat-details__row">
        <dt>{COPY.permissions}</dt>
        <dd>
          {SETTINGS.permissionOptions.find((option) => option.value === asRun.permissionMode)
            ?.label ?? asRun.permissionMode}
        </dd>
      </div>
    </dl>
  {/if}
  <div class="weft-chat-details__actions">
    <CopyButton value={sessionId} label={COPY.copySessionId} copiedLabel={COPY.sessionIdCopied}>
      {COPY.copySessionId}
      {#snippet confirmation()}{COPY.sessionIdCopied}{/snippet}
    </CopyButton>
  </div>
</div>

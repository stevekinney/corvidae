<script lang="ts">
  /**
   * The hooks the Hooks page and an agent's Hooks tab share, as Cinder's status-first two-line rows:
   * a status word beside the hook's name and the time of its last delivery on line one, and the hook
   * as a sentence on line two ("When a run fails, send a webhook to events.pagerduty.com"), with an
   * On switch at the far right. A hook that is off leads with Off and says no time, and moves its
   * last delivery to line two, so the status column never reads it as healthy. A hook whose last
   * delivery failed comes first, so what needs looking at is at the top. The whole row is the link to
   * the hook's own page, where its deliveries are.
   *
   * The switch saves when it is pressed. It names the revision of the hook the list read: a hook that
   * changed since is refused and the list is read again, and nothing was changed. The switch follows
   * the list once it has been read again, not the press.
   */
  import {
    Alert,
    Badge,
    DataList,
    StackedListItem,
    StatusDot,
    Toggle,
    Tooltip,
  } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { STALE_COPY } from '../../app/copy/views.ts';
  import { showFault } from '../../app/toast-host.svelte';
  import { agentFaultOf } from '../../lib/agent-definitions.ts';
  import { updateHook, type ListedHook } from '../../lib/bureau-hooks.ts';
  import { listContributedKinds } from '../../lib/bureau-plugin-kinds.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { followLinks } from '../../lib/follow-links.ts';
  import { getPlugins } from '../../lib/host-plugins.ts';
  import { hookPath } from '../../lib/identifier-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { HOOKS_COPY } from './hook-copy.ts';
  import {
    failingFirst,
    hookFailing,
    hookRowSentence,
    hookRowText,
    hookTime,
  } from './hook-presentation.ts';
  import { hookStanding, pluginTitleOf } from './hook-standing.ts';

  interface Props {
    /** The hooks to show, each with its newest delivery. */
    hooks: readonly ListedHook[];
  }

  let { hooks }: Props = $props();

  const queryClient = useQueryClient();

  const ordered = $derived(failingFirst(hooks, hookFailing));

  // What the plugins are and offer, read only when a hook of one is listed: a row says one status
  // word (Off, Unavailable, Needs setup, then its latest delivery), and a plugin's hooks can be
  // told from the rest. A host that cannot say leaves it unknown, and no state is guessed.
  const runsPlugin = $derived(hooks.some((hook) => hook.action.type === 'plugin'));
  const plugins = createQuery(
    () => ({
      queryKey: queryKeys.hostPlugins(),
      queryFn: ({ signal }: { signal: AbortSignal }) => getPlugins({ signal }),
      enabled: runsPlugin,
      retry: false,
    }),
    undefined,
  );
  const contributed = createQuery(
    () => ({
      queryKey: queryKeys.pluginKinds(),
      queryFn: ({ signal }: { signal: AbortSignal }) => listContributedKinds({ signal }),
      enabled: runsPlugin,
      retry: false,
    }),
    undefined,
  );
  const context = $derived({
    plugins: plugins.data?.plugins,
    reactions: contributed.isSuccess ? contributed.data.reactions : undefined,
  });
  // The clock the times are counted from, read again whenever the hooks are.
  const now = $derived.by(() => {
    void hooks;
    return Date.now();
  });

  /** A hook the Bureau refused to change for being stale: nothing was changed, and the list was read again. */
  let staleHook = $state<string | null>(null);

  const switching = createMutation(() => ({
    mutationFn: (input: { hook: ListedHook; enabled: boolean }) =>
      updateHook(input.hook.id, input.hook.revision, { enabled: input.enabled }),
    onMutate: () => {
      staleHook = null;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['hooks'] }),
    onError: (error: unknown, input) => {
      void queryClient.invalidateQueries({ queryKey: ['hooks'] });
      if (agentFaultOf(error).kind === 'stale') {
        staleHook = input.hook.id;
        return;
      }
      const treatment = faultTreatment(error);
      showFault({ ...treatment, message: `${HOOKS_COPY.toggleFailed}. ${treatment.message}` });
    },
  }));
</script>

{#if staleHook !== null}
  <Alert variant="warning" dismissible onDismiss={() => (staleHook = null)}>
    <p class="ib-hooks__alert-title">{STALE_COPY.title(staleHook)}</p>
    <p class="ib-hooks__alert-body">{STALE_COPY.description}</p>
  </Alert>
{/if}

<div {@attach followLinks}>
  <DataList
    items={[...ordered]}
    key={(hook) => hook.id}
    statusColumn
    aria-label={HOOKS_COPY.rowsLabel}
  >
    {#snippet children(hook)}
      {@const standing = hookStanding(hook, context)}
      {@const word = standing.word}
      {@const withdrawn = hook.declaredBy?.withdrawn === true}
      {@const delivered = hookTime(hook, now)}
      {@const text = hookRowText(hook, now)}
      {@const whole = hookRowText(hook, now, true)}
      <StackedListItem
        href={router.href(hookPath(hook.id))}
        tooltip={whole.title}
        metaTooltip={whole.line}
        wrapMeta
        data-hook={hook.id}
        data-enabled={hook.enabled ? 'true' : 'false'}
      >
        {#snippet status()}
          {#if word !== undefined}
            <StatusDot {word} size="sm" data-status-word={word} />
          {:else}
            <StatusDot status="pending" label={HOOKS_COPY.row.noDelivery} size="sm" />
          {/if}
        {/snippet}
        {#snippet title()}{text.title}{#if hook.declaredBy !== null}
            <Badge variant="neutral" size="xs" data-testid="hook-plugin-badge"
              >{HOOKS_COPY.pluginBadge}</Badge
            >{/if}{/snippet}
        {#snippet time()}
          {#if delivered !== undefined}<span data-last-delivery>{delivered}</span>{/if}
        {/snippet}
        {#snippet meta()}
          {#if text.line !== ''}<span class="ib-hooks__line">{text.line}</span>{/if}
        {/snippet}
        {#snippet trailing()}
          {#snippet theSwitch()}
            <Toggle
              {...{ 'data-changes': true }}
              id={`hook-${hook.id}-on`}
              label={hook.enabled ? HOOKS_COPY.row.on : HOOKS_COPY.row.off}
              nameDetail={hookRowSentence(hook)}
              mutating
              checked={hook.enabled}
              disabled={switching.isPending || withdrawn}
              onValueChangeRequest={(next) => {
                switching.mutate({ hook, enabled: next });
                // The switch follows the list once it has been read again, not the press. Cinder takes
                // the returned boolean as the value to show, so hand back the saved one: a refused
                // change must keep reading as it was.
                return hook.enabled;
              }}
            />
          {/snippet}
          {#if withdrawn && hook.declaredBy !== null}
            <!-- A hook its plugin withdrew stays off: the switch is held, and the tooltip says why. -->
            <Tooltip
              text={HOOKS_COPY.standing.withdrawnSwitch(
                pluginTitleOf(hook.declaredBy.plugin, context.plugins),
              )}
            >
              {@render theSwitch()}
            </Tooltip>
          {:else}
            {@render theSwitch()}
          {/if}
        {/snippet}
      </StackedListItem>
    {/snippet}
  </DataList>
</div>

<style>
  .ib-hooks__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-hooks__alert-body {
    margin: 4px 0 8px;
  }

  /* A long sentence (a webhook's address) ends at the second line with an ellipsis; an unbroken value wraps anywhere. */
  .ib-hooks__line {
    display: -webkit-box;
    overflow: hidden;
    overflow-wrap: anywhere;
    white-space: normal;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
</style>

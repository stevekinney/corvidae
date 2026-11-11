<script lang="ts">
  /**
   * Enabling the plugin behind the unavailable agents, from the list (board PageAgents, "Enable and
   * restart · confirmation" and its captioned states). The question is a Cinder confirm dialog
   * titled "Enable Demo and restart?": Interborough restarts to load the plugin, which brings the
   * held-back agents back, and an inset note says what the restart does to work in flight. It
   * counts the runs going now and the reviews waiting on the person, and never says nothing is
   * running. Confirming writes the plugin's switch and restarts through the same flow Settings ›
   * Plugins and a chat use; a plugin that cannot be enabled keeps the dialog open with a danger
   * callout and a link to Plugins, and nothing was restarted.
   *
   * The restart's own states are not redrawn here (row 37a): while the host restarts a banner above
   * the list says so, a restart that never came back is the shared failed dialog, and once the host
   * is back a success banner names what is on and links to Settings › Plugins, where the steps of
   * the restart are drawn.
   */
  import { Banner, Button, ConfirmDialog, Link } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { onDestroy, untrack } from 'svelte';

  import { AGENTS_COPY, RESTART_COPY } from '../../app/copy.ts';
  import RestartDialog from '../../app/restart/restart-dialog.svelte';
  import { router } from '../../lib/router.svelte.ts';
  import { listBureauReviews } from '../../lib/bureau-reviews.ts';
  import { listRunningTasks } from '../../lib/bureau-tasks.ts';
  import { queryKeys } from '../../lib/query.ts';
  import type { RestartRefusal } from '../../app/restart/host-restart-flow.svelte.ts';
  import { RestartFlow } from '../settings/plugins/restart-flow.svelte.ts';

  interface Props {
    /** Whether the question is showing. Bindable: the page opens it, and the dialog closes it. */
    open?: boolean;
    /** The plugins to enable, each by name (what the host stores the choice under) and by title (what a person reads). */
    plugins: readonly { readonly name: string; readonly title: string }[];
    /** The held-back agents the restart brings back, as a person reads their names. */
    agents: readonly string[];
  }

  let { open = $bindable(false), plugins, agents }: Props = $props();

  const queryClient = useQueryClient();
  const flow = new RestartFlow();
  onDestroy(() => flow.dispose());

  // Read only while the question is open: they are information for the note, and the confirmation
  // never waits on them. The keys are the ones Home and the sidebar read, so the answers are shared.
  const runningTasks = createQuery(
    () => ({
      queryKey: queryKeys.bureauTasks.running(),
      queryFn: ({ signal }) => listRunningTasks({ signal }),
      enabled: open,
      retry: false,
    }),
    undefined,
  );
  const reviews = createQuery(
    () => ({
      queryKey: queryKeys.bureauReviews.list(),
      queryFn: ({ signal }) => listBureauReviews({ signal }),
      enabled: open,
      retry: false,
    }),
    undefined,
  );
  const running = $derived(runningTasks.data?.length ?? 0);
  const waiting = $derived(reviews.data?.length ?? 0);

  // The runs going now come first when there are any; the note never says that nothing is running.
  const work = $derived(
    [running > 0 ? AGENTS_COPY.enable.running(running) : '', AGENTS_COPY.enable.work(waiting)]
      .filter((sentence) => sentence !== '')
      .join(' '),
  );

  const titles = $derived(plugins.map((plugin) => plugin.title));
  // What the restart was for, kept from the confirmation: once the host is back the held-back agents
  // are available, so the page no longer names them or the plugin.
  let applied = $state<{
    readonly plugins: readonly string[];
    readonly agents: readonly string[];
  }>({ plugins: [], agents: [] });
  const PLUGINS_PATH = '/settings/plugins';

  /** Why the plugin could not be enabled, or `undefined` while nothing has refused. */
  const failure = $derived.by(() => {
    const refusal = flow.refusal;
    if (refusal === undefined) return undefined;
    if (refusal === 'save-failed') {
      return AGENTS_COPY.enable.failedReason(
        flow.rejection?.message ?? AGENTS_COPY.enable.unknownReason,
      );
    }
    return RESTART_COPY.refusal[refusal];
  });

  // Why the host was not asked to restart after the switch was saved. The dialog has closed by
  // then (the restart was under way), so the banner above the list says it: the plugin is on and
  // the person has to restart the host where it runs.
  let notRestarted = $state<Exclude<RestartRefusal, 'save-failed'> | undefined>(undefined);

  // A refusal is the last attempt's: it is cleared when the question is asked again.
  let wasOpen = false;
  $effect(() => {
    const now = open;
    untrack(() => {
      if (now && !wasOpen) {
        flow.refusal = undefined;
        flow.rejection = undefined;
        notRestarted = undefined;
      }
      wasOpen = now;
    });
  });

  // Once the restart is under way, the banner and the shared dialog account for it. A refusal
  // while the restart is being asked for (`requesting` back to `idle`) leaves the question closed
  // and lands in `notRestarted`; a write that was refused keeps the question open with its callout.
  let previousPhase = 'idle';
  $effect(() => {
    const phase = flow.phase;
    const refusal = flow.refusal;
    untrack(() => {
      if (phase === 'idle' && previousPhase === 'requesting' && refusal !== undefined) {
        if (refusal !== 'save-failed') notRestarted = refusal;
      }
      previousPhase = phase;
      // The host applied every write at once: nothing restarts, so the question has nothing to wait for.
      if (phase === 'idle' && flow.saved) {
        open = false;
        void queryClient.invalidateQueries();
      }
    });
    if (phase === 'saving' || phase === 'idle') return;
    untrack(() => {
      open = false;
    });
  });

  // The host started again: what the rest of the application kept is from the host that stopped.
  $effect(() => {
    if (flow.phase !== 'back') return;
    untrack(() => void queryClient.invalidateQueries());
  });

  function confirm(): void {
    notRestarted = undefined;
    applied = { plugins: titles, agents: [...agents] };
    void flow.run(
      plugins.map((plugin) => ({ name: plugin.name, enabled: true })),
      false,
      { changes: titles },
    );
  }

  function openPlugins(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    open = false;
    router.navigate(PLUGINS_PATH);
  }
</script>

{#if flow.running && flow.phase !== 'saving'}
  <Banner
    preset={flow.phase === 'starting' ? 'reconnecting' : 'restarting'}
    attempt={flow.attempt === 0 ? undefined : flow.attempt}
    retryInSeconds={flow.retryInSeconds}
    onRetry={() => flow.retryNow()}
    data-testid="agents-restart-banner"
  />
{:else if flow.phase === 'back'}
  <Banner
    variant="success"
    dismissible={false}
    title={RESTART_COPY.back.title}
    data-testid="agents-restart-back"
  >
    {AGENTS_COPY.enable.back(applied.plugins, applied.agents)}
    {#snippet actions()}
      <Button variant="secondary" size="sm" href={router.href(PLUGINS_PATH)} onclick={openPlugins}
        >{AGENTS_COPY.enable.openPlugins}</Button
      >
      <Button variant="secondary" size="sm" onclick={() => flow.close()}
        >{RESTART_COPY.back.dismiss}</Button
      >
    {/snippet}
  </Banner>
{:else if flow.phase === 'unconfirmed'}
  <Banner
    variant="warning"
    dismissible
    onDismiss={() => flow.close()}
    title={RESTART_COPY.unconfirmed.title}
    data-testid="agents-restart-unconfirmed"
  >
    {RESTART_COPY.unconfirmed.description}
  </Banner>
{:else if notRestarted !== undefined}
  <Banner
    variant="danger"
    dismissible
    onDismiss={() => (notRestarted = undefined)}
    title={AGENTS_COPY.enable.notRestartedTitle(applied.plugins)}
    data-testid="agents-restart-refused"
  >
    {RESTART_COPY.refusal[notRestarted]}
    {#snippet actions()}
      <Button variant="secondary" size="sm" href={router.href(PLUGINS_PATH)} onclick={openPlugins}
        >{AGENTS_COPY.enable.openPlugins}</Button
      >
    {/snippet}
  </Banner>
{/if}

{#snippet note()}
  <div class="ib-agent-enable__note" data-testid="agent-enable-note">
    <p data-testid="agent-enable-work">{work}</p>
    {#if failure !== undefined}
      <p>
        <Link href={router.href(PLUGINS_PATH)} onclick={openPlugins}
          >{AGENTS_COPY.enable.openPlugins}</Link
        >
      </p>
    {/if}
  </div>
{/snippet}

<ConfirmDialog
  bind:open
  title={AGENTS_COPY.enable.title(titles)}
  description={AGENTS_COPY.enable.description(titles, agents)}
  options={note}
  confirmLabel={AGENTS_COPY.enable.confirm}
  closeOnConfirm={false}
  busy={flow.phase === 'saving'}
  errorTitle={failure === undefined ? undefined : AGENTS_COPY.enable.failedTitle(titles.join(', '))}
  error={failure}
  onConfirm={confirm}
/>
<RestartDialog {flow} failedOnly />

<style>
  .ib-agent-enable__note {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    padding: var(--cinder-space-3);
    border-radius: var(--cinder-radius-md);
    background: var(--cinder-surface-inset);
    color: var(--cinder-text-secondary);
    font-size: var(--cinder-text-sm);
  }

  .ib-agent-enable__note p {
    margin: 0;
  }
</style>

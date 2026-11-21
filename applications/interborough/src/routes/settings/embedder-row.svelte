<script lang="ts">
  /**
   * The Embedder row of Settings › General (`memory.embedder`, board COR-2189, rows EM6-01 to
   * EM6-23): a Cinder `SettingRow` whose control is a picker over the embedders memory can use, and
   * whose disclosure is the line of the switch to another one. The setting is what starts a switch,
   * so the switch belongs beside it.
   *
   * The picker is never bound to the setting. Its value is the embedder memory uses now (the
   * status's `active.embedder`), because a canceled or failed switch leaves the setting naming the
   * embedder it asked for until the next maintenance pass. Picking another embedder opens a
   * confirmation first (`onValueChangeRequest` refuses the pick, and the write happens when it is
   * confirmed), so the page never saves a switch the person has not confirmed, and the row writes
   * the setting itself instead of through the page's autosave, which saves only a changed value
   * and says "Saved just now" where the switch line is the one status.
   *
   * The status gives identifiers and codes. `embedder-model.ts` words them, so the row shows no
   * embedder identifier and no failure code (except a code the page has no words for, which is
   * shown in monospace after its sentence).
   */
  import {
    Button,
    ConfirmDialog,
    Link,
    Progress,
    Select,
    SettingRow,
    StatusDot,
    Text,
  } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { EMBEDDER_COPY } from '../../app/copy/embedder.ts';
  import { SETTINGS_COPY } from '../../app/copy/settings.ts';
  import {
    cancelEmbeddingSwitch,
    embeddingFaultOf,
    getEmbeddingStatus,
    type EmbeddingStatus,
  } from '../../lib/bureau-embedding.ts';
  import {
    getSettings,
    settingsFaultOf,
    updateSettings,
    type SchemaNode,
    type SettingKeyState,
    type SettingsSnapshot,
  } from '../../lib/bureau-settings.ts';
  import { getHostSession } from '../../lib/host-session.ts';
  import { getPlugins } from '../../lib/host-plugins.ts';
  import { phoneViewport } from '../../lib/phone-viewport.svelte.ts';
  import { inlineSegments } from './inline-markdown.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import {
    embedderName,
    embedderOptions,
    embedderOwner,
    problemCause,
    switchLine,
  } from './embedder-model.ts';
  import { settingLabel } from './settings-controls.ts';
  import SecretDialog, { type SecretTarget } from './plugins/secret-dialog.svelte';

  interface Props {
    /** The setting's key, `memory.embedder`. */
    name: string;
    /** The setting's schema node, whose description the row shows while nothing is wrong. */
    node: SchemaNode;
    keyState: SettingKeyState;
    /** The embedder the setting holds now, else the one it applies by while it holds none. */
    stored: string | undefined;
  }

  let { name, node, keyState, stored }: Props = $props();

  const copy = EMBEDDER_COPY;
  const queryClient = useQueryClient();
  const id = $derived(`weft-setting-${name.replaceAll('.', '-')}`);
  const lineId = $derived(`${id}-switch`);
  /** How often a running switch is read again, so its count moves without a reload. */
  const SWITCH_POLL_MILLISECONDS = 5_000;

  const status = createQuery(
    () => ({
      queryKey: queryKeys.memoryEmbedding(),
      queryFn: ({ signal }) => getEmbeddingStatus({ signal }),
      retry: false,
      // poll-reason: time-derived
      refetchInterval: (query: { state: { data: EmbeddingStatus | undefined } }) =>
        query.state.data?.job?.state === 'running' ? SWITCH_POLL_MILLISECONDS : false,
    }),
    undefined,
  );
  const plugins = createQuery(
    () => ({
      queryKey: queryKeys.hostPlugins(),
      queryFn: ({ signal }) => getPlugins({ signal }),
      retry: false,
    }),
    undefined,
  );
  // Whether the caller may change settings; a session the host does not answer is not held back,
  // because the Bureau refuses the write itself.
  const session = createQuery(
    () => ({
      queryKey: queryKeys.hostSession(),
      queryFn: ({ signal }) => getHostSession({ signal }),
      retry: false,
    }),
    undefined,
  );
  const canWrite = $derived(
    session.data === undefined || session.data.scopes.includes('settings:write'),
  );

  const listed = $derived(plugins.data?.plugins ?? []);
  /** The status last read; a later read that fails leaves it standing. */
  const embedding = $derived<EmbeddingStatus | undefined>(status.data);
  /** A Bureau that keeps no memory answers the read as unsupported. */
  const noMemory = $derived(
    status.isError && embedding === undefined && embeddingFaultOf(status.error) === 'no-memory',
  );
  const loadFailed = $derived(status.isError && embedding === undefined && !noMemory);

  const inUse = $derived(embedding?.active.embedder);
  const current = $derived(inUse === undefined ? undefined : embedderName(inUse, listed));
  const line = $derived(embedding === undefined ? undefined : switchLine(embedding, listed));
  const running = $derived(line?.state === 'running');
  /** The embedder a failed switch was moving to, which "Retry switch" asks to switch to again. */
  const failedTarget = $derived(
    embedding?.job?.state === 'failed' ? embedding.job.target : undefined,
  );
  const cause = $derived(embedding === undefined ? undefined : problemCause(embedding));
  const owner = $derived(inUse === undefined ? undefined : embedderOwner(inUse, listed));

  /** What the picker holds before the status is here: the setting's value, named in words. */
  const placeholderValue = $derived(stored ?? 'hashing');
  const options = $derived(
    embedding === undefined
      ? noMemory
        ? []
        : [{ value: placeholderValue, label: embedderName(placeholderValue, listed) }]
      : embedderOptions(embedding, listed),
  );
  const value = $derived(noMemory ? '' : (inUse ?? placeholderValue));

  /** The setting is not the caller's to change: the deployment locked it, or the caller holds no write scope. */
  const held = $derived(keyState.locked || !canWrite);
  let writing = $state(false);
  const inert = $derived(held || embedding === undefined || running || writing);

  const description = $derived.by(() => {
    if (noMemory) return copy.noMemory;
    if (embedding !== undefined && current !== undefined) {
      switch (cause) {
        case 'not-loaded':
          return copy.problem.notLoaded(current);
        case 'needs-setup':
          return copy.problem.needsSetup(current);
        case 'dimension-changed':
          return copy.problem.dimensionChanged(current);
        case 'model-changed':
          return copy.problem.modelChanged(current);
        default:
          if (embedding.embedders.length === 1 && cause === undefined) {
            return copy.onlyEmbedder(current);
          }
      }
    }
    return inlineSegments(node.description ?? '')
      .map((segment) => segment.text)
      .join('');
  });

  /** The one secret the embedder in use waits for, which the row can ask for itself. */
  const missingKey = $derived.by(() => {
    const missing = (owner?.secrets ?? []).filter((secret) => !secret.set);
    return missing.length === 1 ? missing[0]?.key : undefined;
  });
  let secretTarget = $state<SecretTarget | null>(null);

  function openPlugin(event: MouseEvent, plugin: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(pluginPath(plugin));
  }
  const pluginPath = (plugin: string): string => `/settings/plugins?plugin=${plugin}`;

  function openPlugins(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate('/settings/plugins');
  }

  // The switch confirmation, which "Embed again" and "Retry switch" open too.
  let switchOpen = $state(false);
  let switchTarget = $state('');
  /** Whether the confirmation is for the embedder already in use ("Embed again"), not another one. */
  let again = $state(false);
  // What the row says of a switch the server did not take; nothing changed.
  let refusal = $state<{
    readonly target: string;
    readonly reason: string;
    readonly retry: boolean;
  }>();

  /** The embedder search keeps using, as the confirmation was opened: it does not move under an open dialog. */
  let switchCurrent = $state('');

  function askSwitch(target: string): void {
    refusal = undefined;
    switchTarget = target;
    again = target === untrack(() => inUse);
    switchCurrent = untrack(() => current ?? '');
    switchOpen = true;
  }

  const switchTargetName = $derived(embedderName(switchTarget, listed));

  /** Reads the settings again, as the page does, so the write names the revision now current. */
  const readSettings = (): Promise<SettingsSnapshot> =>
    queryClient.fetchQuery({
      queryKey: queryKeys.settings.snapshot(),
      queryFn: ({ signal }) => getSettings({ signal }),
      staleTime: 0,
    });

  /** Writes the setting; a write the Bureau refuses as stale is read again and sent once more. */
  async function write(target: string): Promise<void> {
    const patch = { [name]: target };
    const first = await readSettings();
    try {
      await updateSettings(patch, first.revision);
    } catch (error) {
      if (settingsFaultOf(error).kind !== 'stale') throw error;
      const latest = await readSettings();
      await updateSettings(patch, latest.revision);
    }
  }

  /** The reason a refused write gives, in words: read from the Bureau's own answer to the status, never from its message. */
  async function reasonFor(
    error: unknown,
    target: string,
  ): Promise<{ reason: string; retry: boolean }> {
    const reasons = copy.refused.reasons;
    const fault = settingsFaultOf(error);
    if (fault.kind === 'locked') return { reason: reasons.locked, retry: false };
    if (fault.kind === 'forbidden') return { reason: reasons.forbidden, retry: false };
    // A second stale answer is the settings moving under the person; choosing again starts afresh.
    if (fault.kind === 'stale') return { reason: reasons.stale, retry: false };
    if (fault.kind === 'other') return { reason: reasons.unanswered, retry: true };
    // The Bureau refused the value. Which refusal it was is on the status, in terms of embedders.
    try {
      const fresh = await queryClient.fetchQuery({
        queryKey: queryKeys.memoryEmbedding(),
        queryFn: ({ signal }) => getEmbeddingStatus({ signal }),
        staleTime: 0,
      });
      const named = embedderName(target, listed);
      const entry = fresh.embedders.find((embedder) => embedder.id === target);
      if (fresh.job?.state === 'running') return { reason: reasons.running, retry: false };
      if (entry === undefined) return { reason: reasons.notLoaded(named), retry: false };
      if (entry.availability === 'needs-setup') {
        return { reason: reasons.needsSetup(named), retry: false };
      }
    } catch (statusError) {
      if (embeddingFaultOf(statusError) === 'no-memory') {
        return { reason: reasons.noMemory, retry: false };
      }
    }
    return { reason: reasons.other, retry: false };
  }

  async function submitSwitch(target: string): Promise<void> {
    if (writing) return;
    writing = true;
    refusal = undefined;
    try {
      await write(target);
      // The switch is the status's now; read it before the dialog closes so its line is there.
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.snapshot() });
      await status.refetch();
    } catch (error) {
      refusal = { target, ...(await reasonFor(error, target)) };
    } finally {
      writing = false;
      switchOpen = false;
    }
  }

  // The cancel confirmation. It names the switch and the count as they were when it opened, so a
  // switch that moves or ends under it never rewrites the question; once none is running, there is
  // nothing left to cancel and it closes.
  let cancelOpen = $state(false);
  let canceling = $state(false);
  let cancelFailed = $state(false);
  let cancelAsked = $state({ target: '', done: 0, current: '' });

  function askCancel(): void {
    if (line?.state !== 'running') return;
    cancelAsked = { target: line.target, done: line.done, current: line.current };
    cancelFailed = false;
    cancelOpen = true;
  }

  $effect(() => {
    if (!running && !untrack(() => canceling)) cancelOpen = false;
  });

  // A key saved in the secret dialog changes what the plugin can do at once: read the status again.
  let askingForKey = false;
  $effect(() => {
    const asking = secretTarget !== null;
    untrack(() => {
      if (askingForKey && !asking) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.memoryEmbedding() });
      }
      askingForKey = asking;
    });
  });

  async function submitCancel(): Promise<void> {
    if (canceling) return;
    canceling = true;
    cancelFailed = false;
    try {
      // `false` is a switch that finished or was canceled first, which is nothing to report.
      await cancelEmbeddingSwitch();
      await status.refetch();
      cancelOpen = false;
    } catch {
      cancelFailed = true;
    } finally {
      canceling = false;
    }
  }

  const rowError = $derived(
    refusal === undefined
      ? undefined
      : copy.refused.row(embedderName(refusal.target, listed), refusal.reason),
  );
  function retryRow(): void {
    if (refusal?.retry === true) void submitSwitch(refusal.target);
    else if (loadFailed) void status.refetch();
  }
  const retriable = $derived(refusal === undefined ? loadFailed : refusal.retry);
</script>

{#snippet descriptionAction()}
  {#if cause === 'not-loaded' && owner !== undefined}
    <Link
      href={router.href(pluginPath(owner.descriptor.name))}
      underline="always"
      onclick={(event: MouseEvent) => openPlugin(event, owner.descriptor.name)}
      >{copy.problem.openPlugin(owner.descriptor.title)}</Link
    >
  {:else if cause === 'needs-setup' && owner !== undefined}
    {#if missingKey !== undefined && canWrite}
      <Button
        variant="ghost-accent"
        size="xs"
        label={copy.problem.addKey}
        onclick={() => (secretTarget = { plugin: owner.descriptor.name, key: missingKey })}
      />
    {:else}
      <Link
        href={router.href(pluginPath(owner.descriptor.name))}
        underline="always"
        onclick={(event: MouseEvent) => openPlugin(event, owner.descriptor.name)}
        >{copy.problem.openPlugin(owner.descriptor.title)}</Link
      >
    {/if}
  {:else if (cause === 'dimension-changed' || cause === 'model-changed') && inUse !== undefined && canWrite && !running}
    <Button
      variant="ghost-accent"
      size="xs"
      label={copy.problem.embedAgain}
      data-changes
      onclick={() => askSwitch(inUse)}
    />
  {:else if cause === undefined && embedding !== undefined && embedding.embedders.length === 1}
    <Link href={router.href('/settings/plugins')} underline="always" onclick={openPlugins}
      >{copy.openPlugins}</Link
    >
  {/if}
{/snippet}

<div
  class="weft-setting"
  data-setting={name}
  data-apply={keyState.apply}
  data-locked={keyState.locked ? 'true' : 'false'}
  data-dirty="false"
>
  <SettingRow
    {id}
    label={settingLabel(name)}
    {...phoneViewport.current ? {} : { identifier: name }}
    {description}
    {...cause !== undefined || (embedding !== undefined && embedding.embedders.length === 1)
      ? { descriptionAction }
      : {}}
    {...rowError === undefined ? {} : { error: rowError }}
    {...loadFailed && rowError === undefined ? { loadError: copy.loadFailed } : {}}
    {...retriable ? { onRetry: retryRow } : {}}
    {...keyState.locked
      ? { managed: { message: SETTINGS_COPY.lockedMessage } }
      : !canWrite
        ? { managed: { message: SETTINGS_COPY.forbidden } }
        : {}}
    disabled={inert}
  >
    {#snippet control()}
      <Select
        {id}
        label={settingLabel(name)}
        // hidden-label-allowed: the SettingRow beside the select draws its label, name and description
        labelVisible={false}
        presentation="listbox"
        {options}
        {value}
        disabled={inert}
        data-changes
        aria-describedby={running ? lineId : undefined}
        onValueChangeRequest={(next: string) => {
          if (next !== inUse) askSwitch(next);
          return inUse ?? value;
        }}
      />
    {/snippet}
    {#snippet disclosure()}
      {#if line !== undefined}
        <div class="ib-embedder" data-testid="embedder-switch" data-state={line.state}>
          <div class="ib-embedder__sentence">
            <StatusDot
              word={line.state === 'running'
                ? 'Running'
                : line.state === 'canceled'
                  ? 'Canceled'
                  : 'Failed'}
              size="sm"
            />
            <Text as="span" id={lineId}>
              {#if line.state === 'running'}
                {copy.running.sentence(line.target, line.done, line.total)}
              {:else if line.state === 'canceled'}
                {copy.canceled(line.target, line.current)}
              {:else}
                {copy.failed.lead(line.target, line.cause)}{#if line.code !== undefined}{' '}(<code
                    class="ib-embedder__code">{line.code}</code
                  >){/if}{copy.failed.tail(line.current)}
              {/if}
            </Text>
          </div>
          {#if line.state === 'running'}
            <div class="ib-embedder__progress">
              <div class="ib-embedder__bar">
                <Progress
                  size="sm"
                  value={line.done}
                  max={Math.max(line.total, 1)}
                  ariaLabelledby={lineId}
                />
              </div>
              {#if canWrite}
                <Button
                  variant="secondary"
                  size="sm"
                  label={copy.running.cancel}
                  data-changes
                  onclick={askCancel}
                />
              {/if}
            </div>
          {:else if line.state === 'failed' && canWrite && failedTarget !== undefined}
            <div class="ib-embedder__retry">
              <Button
                variant="secondary"
                size="sm"
                label={copy.failed.retry}
                data-changes
                onclick={() => askSwitch(failedTarget)}
              />
            </div>
          {/if}
        </div>
      {/if}
    {/snippet}
  </SettingRow>
</div>

<ConfirmDialog
  open={switchOpen}
  title={again
    ? copy.confirmAgain.title(switchTargetName)
    : copy.confirmSwitch.title(switchTargetName)}
  description={again
    ? copy.confirmAgain.description(switchTargetName)
    : copy.confirmSwitch.description(switchTargetName, switchCurrent)}
  confirmLabel={again ? copy.confirmAgain.confirm : copy.confirmSwitch.confirm}
  busyLabel={again ? copy.confirmAgain.busy : copy.confirmSwitch.busy}
  cancelLabel={again ? copy.confirmAgain.cancel : copy.confirmSwitch.keep(switchCurrent)}
  busy={writing}
  closeOnConfirm={false}
  onConfirm={() => void submitSwitch(switchTarget)}
  onCancel={() => (switchOpen = false)}
/>

<ConfirmDialog
  open={cancelOpen}
  title={copy.confirmCancel.title(cancelAsked.target)}
  description={copy.confirmCancel.description(cancelAsked.done, cancelAsked.current)}
  confirmLabel={copy.confirmCancel.confirm}
  busyLabel={copy.confirmCancel.busy}
  cancelLabel={copy.confirmCancel.keep}
  destructive
  busy={canceling}
  errorTitle={cancelFailed ? copy.confirmCancel.failedTitle : undefined}
  error={cancelFailed ? copy.confirmCancel.failed : undefined}
  closeOnConfirm={false}
  onConfirm={() => void submitCancel()}
  onCancel={() => (cancelOpen = false)}
/>

<SecretDialog bind:target={secretTarget} />

<style>
  .weft-setting {
    min-inline-size: 0;
  }

  .ib-embedder {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-inline-size: 0;
    margin-block-start: var(--cinder-space-2);
  }

  .ib-embedder__sentence {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--cinder-space-1) var(--cinder-space-2);
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }

  .ib-embedder__progress {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-3);
    min-inline-size: 0;
  }

  .ib-embedder__bar {
    flex: 1 1 auto;
    min-inline-size: 0;
  }

  .ib-embedder__retry {
    display: flex;
    justify-content: flex-start;
  }

  .ib-embedder__code {
    font-family: var(--cinder-font-mono);
  }
</style>

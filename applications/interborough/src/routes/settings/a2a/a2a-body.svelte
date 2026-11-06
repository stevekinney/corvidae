<script lang="ts">
  /**
   * The body of Settings › A2A (board PageSettingsSections, "A2A · /settings/a2a" and "A2A with
   * Accept A2A calls off"): the Agent2Agent section and Recent calls, under the restart notice every
   * section shares. The section's rows save as they are left, like the rest of Settings, and say
   * "Saved" or "Applies after restart":
   *
   * - Accept A2A calls (`a2a.enabled`), the switch the others hang from. A restart applies it.
   * - Agent card URL, the address a caller reaches the list of shared agents at. It is the host's
   *   to say, since only it knows the public origin.
   * - Shared agents (`a2a.agents`), a switch per agent in the order the Agents page lists them.
   *   Each is live and overrides what the agent's own file says.
   * - Push notifications (`a2a.push.enabled`), and the interval its leftovers are swept at.
   *
   * With Accept A2A calls off the three rows after it stay visible but cannot be changed, and a line
   * under them says so. Recent calls lists the calls the audit trail kept (`recent-calls.svelte`).
   */
  import {
    Button,
    CopyButton,
    FormSection,
    Input,
    SettingRow,
    Skeleton,
    Toggle,
    validateSchemaFormValue,
  } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { onDestroy, untrack } from 'svelte';

  import { A2A_COPY, SETTINGS_COPY } from '../../../app/copy.ts';
  import { HostRestartFlow } from '../../../app/restart/host-restart-flow.svelte.ts';
  import { dismissToast, showToast } from '../../../app/toast-host.svelte';
  import { agentLabel } from '../../../lib/agent-label.ts';
  import { listAgents } from '../../../lib/bureau-client.ts';
  import {
    getSettings,
    updateSettings,
    type SettingKeyState,
    type SettingsSchema,
    type SettingsSnapshot,
  } from '../../../lib/bureau-settings.ts';
  import { getHostPaths } from '../../../lib/host-paths.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import SettingField from '../setting-field.svelte';
  import { SettingsAutosave } from '../settings-autosave.svelte.ts';
  import { controlFor, inSection, type Control } from '../settings-controls.ts';
  import { formSchemaOf, numbersCommitted } from '../settings-form-schema.ts';
  import { SettingsForm } from '../settings-form.svelte.ts';
  import SettingsRestartNotice from '../settings-restart-notice.svelte';
  import { SettingsRevert } from '../settings-revert.svelte.ts';
  import RecentCalls from './recent-calls.svelte';

  interface Props {
    schema: SettingsSchema;
    snapshot: SettingsSnapshot;
  }

  let { schema, snapshot }: Props = $props();

  const queryClient = useQueryClient();
  const copy = A2A_COPY;

  const ENABLED = 'a2a.enabled';
  const AGENTS = 'a2a.agents';
  const PUSH = 'a2a.push.enabled';

  // The settings machinery the General page uses: a form over the schema, each setting saving as
  // it is left, and the restart notice every section of Settings shares.
  const controls = new Map<string, Control>(
    untrack(() => Object.entries(schema).map(([key, node]) => [key, controlFor(key, node)])),
  );

  /** What a key without a state from the Bureau is: a live key nothing holds. */
  const UNKNOWN_STATE: SettingKeyState = { apply: 'live', locked: false, pendingRestart: false };
  const stateOf = (key: string): SettingKeyState => snapshot.keys[key] ?? UNKNOWN_STATE;

  async function validate(key: string, value: unknown): Promise<string | undefined> {
    const node = schema[key];
    if (node === undefined) return undefined;
    const result = await validateSchemaFormValue(formSchemaOf(key, node), value);
    return result.valid ? undefined : (result.issues[0]?.message ?? SETTINGS_COPY.invalidValue);
  }

  function committed(key: string, value: unknown): boolean {
    const node = schema[key];
    return node === undefined || numbersCommitted(formSchemaOf(key, node), value);
  }

  const form = new SettingsForm(controls, (key) => stateOf(key).locked, validate, committed);
  untrack(() => form.load(snapshot));

  const readSettings = (): Promise<SettingsSnapshot> =>
    queryClient.fetchQuery({
      queryKey: queryKeys.settings.snapshot(),
      queryFn: ({ signal }) => getSettings({ signal }),
      staleTime: 0,
    });

  const autosave = new SettingsAutosave({
    form,
    update: (patch, expectedRevision) => updateSettings(patch, expectedRevision),
    read: readSettings,
  });

  const revert = new SettingsRevert({
    form,
    update: (patch, expectedRevision) => updateSettings(patch, expectedRevision),
    read: readSettings,
    showUndo: (message, undo) => showToast(message, { undo }),
    dismiss: dismissToast,
    fail: (message) => void showToast(message, { variant: 'danger' }),
  });
  onDestroy(() => revert.dispose());

  // The settings were read again: every setting not being edited takes them.
  $effect(() => {
    const latest = snapshot;
    if (autosave.busy) return;
    untrack(() => {
      if (latest.revision !== form.revision) form.rebase(latest);
    });
  });

  const restartFlow = new HostRestartFlow<SettingsSnapshot>({
    read: () => getSettings(),
    waiting: (current) => Object.values(current.keys).some((key) => key.pendingRestart),
  });
  onDestroy(() => restartFlow.dispose());
  $effect(() => {
    if (restartFlow.phase !== 'back') return;
    untrack(() => void queryClient.invalidateQueries());
  });

  /** The settings that wait for a restart, in the schema's order. */
  const restartKeys = $derived(Object.keys(schema).filter((key) => stateOf(key).pendingRestart));

  /** The keys this section holds that the board draws no row for: they follow the drawn rows. */
  const extraKeys = $derived(
    Object.keys(schema).filter(
      (key) => inSection(key, 'a2a') && key !== ENABLED && key !== AGENTS && key !== PUSH,
    ),
  );

  /** Whether Accept A2A calls is off, which holds the rows after it. */
  const off = $derived(form.draft(ENABLED) === false);

  const hostPaths = createQuery(
    () => ({
      queryKey: queryKeys.hostPaths(),
      queryFn: ({ signal }) => getHostPaths({ signal }),
      retry: false,
    }),
    undefined,
  );

  const agents = createQuery(
    () => ({
      queryKey: queryKeys.agents.list(),
      queryFn: ({ signal }) => listAgents({ signal }),
      retry: false,
    }),
    undefined,
  );

  /** What the `a2a.agents` record holds now: the agents the person named, each shared or withdrawn. */
  const overrides = $derived.by((): Readonly<Record<string, boolean>> => {
    const draft = form.draft(AGENTS);
    if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) return {};
    return Object.fromEntries(
      Object.entries(draft).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
      ),
    );
  });

  /** Whether an agent answers remote calls: what the record says of it, else what its own definition says. */
  function shared(name: string, definition: boolean): boolean {
    return Object.hasOwn(overrides, name) ? overrides[name] === true : definition;
  }

  /** Shares or withdraws an agent: the record names it, and the setting saves at once. */
  function share(name: string, next: boolean): void {
    autosave.clear(AGENTS);
    revert.forget(AGENTS);
    form.set(AGENTS, { ...overrides, [name]: next });
    void autosave
      .commit(AGENTS)
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() }));
  }

  /** An element id for an agent's switch: the agent's name, without the characters an id should not carry. */
  const switchId = (rowId: string, name: string): string =>
    `${rowId}-${name.replaceAll(/[^A-Za-z0-9_-]/g, '-')}`;
</script>

{#snippet field(key: string, label: string, description: string, held: boolean)}
  {@const node = schema[key]}
  {@const control = controls.get(key)}
  {#if node !== undefined && control !== undefined}
    <SettingField
      name={key}
      {node}
      {control}
      {form}
      keyState={stateOf(key)}
      {autosave}
      reverted={revert.isReverted(key)}
      descriptionOverride={description}
      labelOverride={label}
      disabled={held}
      statusNote={key === ENABLED && off ? copy.enabled.off : undefined}
      onEdit={() => revert.forget(key)}
    />
  {/if}
{/snippet}

{#snippet agentSwitches({ id, disabled }: { id: string; disabled: boolean })}
  <div class="ib-a2a__agents" data-testid="a2a-agent-switches">
    {#if agents.data !== undefined}
      {#if agents.data.length === 0}
        <span class="ib-a2a__muted">{copy.agents.none}</span>
      {:else}
        <ul class="ib-a2a__agent-list" aria-label={copy.agents.listLabel}>
          {#each agents.data as agent (agent.name)}
            <li data-agent={agent.name}>
              <Toggle
                id={switchId(id, agent.name)}
                label={agentLabel(agent.name, agents.data)}
                standalone
                labelPosition="start"
                checked={shared(agent.name, agent.a2a)}
                {disabled}
                onValueChange={(next) => share(agent.name, next)}
              />
            </li>
          {/each}
        </ul>
      {/if}
    {:else if agents.isError}
      <span class="ib-a2a__muted">{copy.agents.loadFailed}</span>
      <Button variant="secondary" size="sm" onclick={() => void agents.refetch()}
        >{copy.agents.retry}</Button
      >
    {:else}
      <div role="status" aria-busy="true" aria-label={copy.agents.loading}>
        <Skeleton height="1.25rem" />
        <Skeleton height="1.25rem" />
      </div>
    {/if}
  </div>
{/snippet}

<SettingsRestartNotice
  keys={restartKeys}
  {snapshot}
  flow={restartFlow}
  {revert}
  saving={autosave.busy}
/>

<div class="ib-a2a" role="group" aria-label={SETTINGS_COPY.formLabel}>
  <FormSection grouped heading={copy.heading}>
    {@render field(ENABLED, copy.enabled.label, copy.enabled.description, false)}

    <div class="ib-a2a__row" data-setting="agent-card-url">
      <SettingRow
        id="ib-a2a-card-url"
        label={copy.cardUrl.label}
        description={copy.cardUrl.description}
        controlWidth="25rem"
      >
        {#snippet control()}
          <div class="ib-a2a__card">
            <div class="ib-a2a__address">
              <Input
                id="ib-a2a-card-url"
                variant="code"
                readonly
                value={hostPaths.data?.a2aDirectoryUrl ?? copy.cardUrl.unavailable}
                data-testid="a2a-card-url"
              />
            </div>
            {#if hostPaths.data !== undefined}
              <CopyButton
                value={hostPaths.data.a2aDirectoryUrl}
                label={copy.cardUrl.copy}
                copiedLabel={copy.cardUrl.copied}
                iconOnly
              />
            {/if}
          </div>
        {/snippet}
      </SettingRow>
    </div>

    {#if schema[AGENTS] !== undefined && controls.get(AGENTS) !== undefined}
      <SettingField
        name={AGENTS}
        node={schema[AGENTS]}
        control={controls.get(AGENTS)!}
        {form}
        keyState={stateOf(AGENTS)}
        {autosave}
        reverted={revert.isReverted(AGENTS)}
        descriptionOverride={copy.agents.description(agents.data?.length ?? 0)}
        labelOverride={copy.agents.label}
        disabled={off}
        custom={agentSwitches}
        controlWidth="16.25rem"
        onEdit={() => revert.forget(AGENTS)}
      />
    {/if}

    {@render field(PUSH, copy.pushNotifications.label, copy.pushNotifications.description, off)}
    {#each extraKeys as key (key)}
      {@const node = schema[key]}
      {@const control = controls.get(key)}
      {#if node !== undefined && control !== undefined}
        <SettingField
          name={key}
          {node}
          {control}
          {form}
          keyState={stateOf(key)}
          {autosave}
          reverted={revert.isReverted(key)}
          disabled={off}
          onEdit={() => revert.forget(key)}
        />
      {/if}
    {/each}
    {#if off}
      <p class="ib-a2a__readonly" data-testid="a2a-read-only">{copy.readOnly}</p>
    {/if}
  </FormSection>

  <RecentCalls agents={agents.data ?? []} />
</div>

<style>
  .ib-a2a {
    grid-area: content;
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-8);
    max-inline-size: 46rem;
    min-inline-size: 0;
  }

  .ib-a2a__row {
    min-inline-size: 0;
  }

  .ib-a2a__card {
    display: flex;
    gap: var(--cinder-space-2);
    align-items: center;
    inline-size: 100%;
    min-inline-size: 0;
  }

  .ib-a2a__address {
    flex: 1;
    min-inline-size: 0;
  }

  .ib-a2a__agents {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-inline-size: 0;
    inline-size: 100%;
  }

  .ib-a2a__agent-list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ib-a2a__agent-list > li {
    padding-block: var(--cinder-space-2);
  }

  .ib-a2a__muted,
  .ib-a2a__readonly {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>

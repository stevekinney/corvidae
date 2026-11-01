<script lang="ts">
  /**
   * Only for, in the When step of the hook editor: it adapts to the events chosen, offering the kinds
   * of subject every one of them can be told by (an agent, a workflow, a schedule), then the one
   * meant, and it says so instead when the events are about the whole system. The catalog says what
   * each event allows (`scopes`), which is the rule the Bureau holds a save to.
   *
   * A subject on the hook that the lists no longer hold (a workflow since deleted) stays offered, so
   * opening a hook never changes it.
   */
  import { Alert, Select } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { listAgents } from '../../lib/bureau-client.ts';
  import type { HookEventKind, HookScopeKind } from '../../lib/bureau-hooks.ts';
  import { listBureauSchedules } from '../../lib/bureau-schedules.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { listWorkflowFiles } from '../../lib/workflow-files.ts';
  import { HOOKS_COPY } from './hook-copy.ts';
  import type { HookFormState } from './hook-form-state.svelte.ts';
  import { isScopeKind, scopeKindsFor } from './hook-presentation.ts';

  interface Props {
    /** The editor's draft: Only for writes its scope. */
    form: HookFormState;
    /** Every event kind the Bureau describes. */
    kinds: readonly HookEventKind[];
  }

  let { form, kinds }: Props = $props();

  const copy = HOOKS_COPY.editor.onlyFor;

  const allowed = $derived(scopeKindsFor(form.events, kinds));

  const agents = createQuery(
    () => ({
      queryKey: queryKeys.agents.list(),
      queryFn: ({ signal }: { signal: AbortSignal }) => listAgents({ signal }),
      enabled: form.scopeKind === 'agent',
      retry: false,
    }),
    undefined,
  );
  const workflows = createQuery(
    () => ({
      queryKey: queryKeys.hooks.workflows(),
      queryFn: ({ signal }: { signal: AbortSignal }) => listWorkflowFiles({ signal }),
      enabled: form.scopeKind === 'workflow',
      retry: false,
    }),
    undefined,
  );
  const schedules = createQuery(
    () => ({
      queryKey: queryKeys.hooks.schedules(),
      queryFn: ({ signal }: { signal: AbortSignal }) => listBureauSchedules({ signal }),
      enabled: form.scopeKind === 'schedule',
      retry: false,
    }),
    undefined,
  );

  const kindOptions = $derived([
    { value: '', label: copy.everything },
    ...allowed.map((kind) => ({ value: kind, label: copy.kinds[kind] })),
    // A kind the events no longer allow stays shown: the page says why it cannot be saved.
    ...(isScopeKind(form.scopeKind) && !allowed.includes(form.scopeKind)
      ? [{ value: form.scopeKind, label: copy.kinds[form.scopeKind], disabled: true }]
      : []),
  ]);

  /** The subjects of the kind chosen, as the Bureau lists them. */
  function subjectsOf(kind: HookScopeKind): { value: string; label: string }[] {
    switch (kind) {
      case 'agent':
        return (agents.data ?? []).map((agent) => ({
          value: agent.name,
          label: agent.displayName ?? agent.name,
        }));
      case 'workflow':
        return (workflows.data ?? []).map((file) => ({ value: file.id, label: file.id }));
      case 'schedule':
        return (schedules.data ?? []).map((schedule) => ({
          value: schedule.id,
          label: schedule.description ?? schedule.id,
        }));
    }
  }

  const subjectOptions = $derived.by(() => {
    if (!isScopeKind(form.scopeKind)) return [];
    const subjects = subjectsOf(form.scopeKind);
    const held = form.scopeId !== '' && !subjects.some((subject) => subject.value === form.scopeId);
    return [
      { value: '', label: copy.placeholder, disabled: true },
      ...(held ? [{ value: form.scopeId, label: form.scopeId }] : []),
      ...subjects,
    ];
  });

  const subjectsFailed = $derived(
    (form.scopeKind === 'agent' && agents.isError) ||
      (form.scopeKind === 'workflow' && workflows.isError) ||
      (form.scopeKind === 'schedule' && schedules.isError),
  );

  function chooseKind(value: string): void {
    form.scopeKind = value;
    form.scopeId = '';
  }
</script>

{#if allowed.length > 0 || form.scopeKind !== ''}
  <Select
    id="ib-hook-only-for"
    label={copy.label}
    description={copy.description}
    options={kindOptions}
    value={form.scopeKind}
    onchange={(event) => chooseKind(event.currentTarget.value)}
  />
  {#if isScopeKind(form.scopeKind)}
    <Select
      id="ib-hook-only-for-subject"
      label={copy.subject[form.scopeKind]}
      options={subjectOptions}
      value={form.scopeId}
      onchange={(event) => (form.scopeId = event.currentTarget.value)}
    />
    {#if subjectsFailed}
      <Alert variant="danger">{copy.loadFailed}</Alert>
    {/if}
  {/if}
{:else if form.events.length > 0 && kinds.length > 0}
  <p class="ib-hook-only-for__none" data-testid="hook-only-for-none">{copy.none}</p>
{/if}

<style>
  .ib-hook-only-for__none {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>

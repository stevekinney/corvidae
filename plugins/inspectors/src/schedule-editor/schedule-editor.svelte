<script lang="ts">
  /**
   * The schedule editor (COR-2545): the schedules a person may change, and one schedule's form,
   * drawn with Cinder through the panel kit. Text goes in as text, never as markup. The status line
   * is one polite live region, and each field shows the error that belongs to it: the checks the
   * page makes before a save, and the Bureau's own answer to a save, which names the argument that
   * caused it. The page redraws in place, so focus and a half-typed value survive every read.
   */
  import {
    Button,
    Callout,
    Input,
    Section,
    Select,
    Text,
    Textarea,
    Toggle,
  } from '@lostgradient/cinder';
  import type { ScheduleDraft } from '@lostgradient/interborough-plugin/schedule-form';

  import { scheduleLabel, withCurrent } from './model.ts';
  import type { EditorView } from './view.svelte.ts';

  /** What the page asks of its script. */
  type Handlers = {
    readonly onOpen: (id: string) => void;
    readonly onNew: () => void;
    readonly onBack: () => void;
    readonly onSave: () => void;
    readonly onReload: () => void;
    readonly onEdit: (change: Partial<ScheduleDraft>) => void;
  };

  let { view, handlers }: { view: EditorView; handlers: Handlers } = $props();

  /** A field's error as the control takes it: present only when there is one. */
  function errorOf(message: string | undefined): { error?: string } {
    return message === undefined ? {} : { error: message };
  }

  const KIND_OPTIONS = [
    { value: 'agent', label: 'An agent' },
    { value: 'workflow', label: 'A workflow' },
  ];

  const making = $derived(view.source === undefined);
  const cancelled = $derived(view.source?.status === 'cancelled');
  // The platform select shows its first option while nothing is chosen, so an option that says
  // "Choose" stands for nothing, and the draft's empty target is a choice the control shows.
  const targets = $derived([
    {
      value: '',
      label: view.draft.targetKind === 'agent' ? 'Choose an agent' : 'Choose a workflow',
    },
    ...(view.draft.targetKind === 'agent'
      ? withCurrent(view.agents, view.draft.target)
      : withCurrent(view.workflows, view.draft.target)),
  ]);
  const locked = $derived(view.busy || !view.connected);
  const calloutVariant = $derived(
    view.tone === 'danger' ? 'danger' : view.tone === 'success' ? 'success' : 'info',
  );
  // An agent's text is asked only when it is new, as a new schedule or a workflow made to run an
  // agent has none: a schedule that runs an agent keeps the text it sends, whichever agent it runs.
  const asksText = $derived(
    view.draft.targetKind === 'agent' && (making || view.source?.target.kind !== 'agent'),
  );
</script>

{#if view.phase === 'loading'}
  <p role="status" aria-live="polite" class="panel-status">Loading schedules…</p>
{:else if view.phase === 'failed'}
  <p role="status" aria-live="polite" class="panel-status">The schedules could not be read.</p>
{:else}
  <main class="panel-page" aria-labelledby="schedule-editor-title">
    <Text as="h1" variant="h3" id="schedule-editor-title">Schedule editor</Text>
    <Callout variant={calloutVariant}>
      <p role="status" aria-live="polite" data-tone={view.tone}>{view.status}</p>
    </Callout>

    {#if view.screen === 'choose'}
      <Section title="Schedules">
        {#if view.schedules.length === 0}
          <p>There are no schedules yet.</p>
        {:else}
          <ul aria-label="Schedules" class="panel-list schedule-list">
            {#each view.schedules as schedule (schedule.id)}
              <li>
                <span>{scheduleLabel(schedule)}</span>
                <Button
                  id={`open-${schedule.id}`}
                  variant="secondary"
                  size="sm"
                  label="Open"
                  disabled={locked}
                  onclick={() => handlers.onOpen(schedule.id)}
                />
              </li>
            {/each}
          </ul>
        {/if}
        <div class="panel-actions">
          <Button
            id="new-schedule"
            variant="primary"
            label="New schedule"
            disabled={locked}
            onclick={handlers.onNew}
          />
        </div>
      </Section>
    {:else}
      <Section title={making ? 'New schedule' : 'Change schedule'}>
        {#if cancelled}
          <p>This schedule was canceled, so it cannot be changed.</p>
        {/if}
        <form
          class="schedule-form"
          onsubmit={(event: SubmitEvent) => {
            event.preventDefault();
            handlers.onSave();
          }}
        >
          <Input
            id="schedule-spec"
            label="When it runs"
            description="A cron expression such as 0 9 * * *, or a duration such as 30s, 6h or 1d."
            value={view.draft.spec}
            {...errorOf(view.errors.spec)}
            disabled={locked || cancelled}
            oninput={(event: Event) =>
              handlers.onEdit({ spec: (event.currentTarget as HTMLInputElement).value })}
          />
          <Input
            id="schedule-time-zone"
            label="Time zone"
            description="An IANA zone such as America/New_York. A duration runs in UTC."
            value={view.draft.timeZone}
            {...errorOf(view.errors.timeZone)}
            disabled={locked || cancelled}
            oninput={(event: Event) =>
              handlers.onEdit({ timeZone: (event.currentTarget as HTMLInputElement).value })}
          />
          <Select
            id="schedule-target-kind"
            label="Runs"
            options={KIND_OPTIONS}
            value={view.draft.targetKind}
            disabled={locked || cancelled}
            onValueChange={(next: string) =>
              handlers.onEdit({
                targetKind: next === 'workflow' ? 'workflow' : 'agent',
                target: '',
              })}
          />
          <Select
            id="schedule-target"
            label={view.draft.targetKind === 'agent' ? 'Agent' : 'Workflow'}
            options={targets}
            value={view.draft.target}
            {...errorOf(view.errors.target)}
            disabled={locked || cancelled}
            onValueChange={(next: string) => handlers.onEdit({ target: next })}
          />
          {#if view.draft.targetKind === 'agent'}
            <Textarea
              id="schedule-input"
              label={asksText ? 'What each run sends the agent' : 'New text for each run'}
              {...asksText
                ? {}
                : { description: 'Leave empty to keep the text the schedule sends now.' }}
              rows={3}
              value={view.draft.input}
              {...errorOf(view.errors.input)}
              disabled={locked || cancelled}
              oninput={(event: Event) =>
                handlers.onEdit({ input: (event.currentTarget as HTMLTextAreaElement).value })}
            />
          {:else}
            <Textarea
              id="schedule-workflow-input"
              label="Input for each run, as JSON"
              description="Leave empty to start the workflow with no input."
              rows={3}
              value={view.draft.workflowInput}
              {...errorOf(view.errors.workflowInput)}
              disabled={locked || cancelled}
              oninput={(event: Event) =>
                handlers.onEdit({
                  workflowInput: (event.currentTarget as HTMLTextAreaElement).value,
                })}
            />
          {/if}
          <Input
            id="schedule-description"
            label="Description"
            value={view.draft.description}
            {...errorOf(view.errors.description)}
            disabled={locked || cancelled}
            oninput={(event: Event) =>
              handlers.onEdit({ description: (event.currentTarget as HTMLInputElement).value })}
          />
          <Toggle
            id="schedule-paused"
            label="Paused"
            description="A paused schedule starts no run until it is resumed."
            checked={view.draft.paused}
            disabled={locked || cancelled}
            onValueChange={(next: boolean) => handlers.onEdit({ paused: next })}
          />
          <div class="panel-actions">
            {#if view.stale}
              <Button
                id="schedule-reload"
                variant="secondary"
                label="Read it again"
                disabled={locked}
                onclick={handlers.onReload}
              />
            {/if}
            <Button
              id="schedule-save"
              variant="primary"
              type="submit"
              label={making ? 'Create schedule' : 'Save changes'}
              disabled={locked || cancelled || view.stale}
            />
            <Button
              id="schedule-back"
              variant="secondary"
              label="Back to schedules"
              disabled={view.busy}
              onclick={handlers.onBack}
            />
          </div>
        </form>
      </Section>
    {/if}
  </main>
{/if}

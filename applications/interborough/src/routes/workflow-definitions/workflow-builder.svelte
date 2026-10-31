<script lang="ts">
  /**
   * The workflow step builder, shared by `/workflows/new` and `/workflows/:workflow/edit`: a
   * Builder tab (name and description, a trigger, then the steps as one-line rows with a plain-words
   * summary under them) and a JSON tab. The page owns the file's text. The builder reads it and
   * writes a changed copy back through `onTextChange`, and the JSON tab edits the same text, so each
   * view shows the other's edits and neither can lose what the other wrote
   * (`workflow-builder-model.ts`). Text that is not a JSON object leaves the builder with nothing to
   * read, so it says so and points at the JSON tab.
   */
  import {
    Alert,
    Badge,
    Button,
    EmptyState,
    FormSection,
    Input,
    JsonEditor,
    SectionHeading,
    Select,
    Tabs,
    Textarea,
  } from '@lostgradient/cinder';

  import { useQueryClient } from '@tanstack/svelte-query';

  import { WORKFLOW_COPY } from '../../app/copy.ts';
  import { defaultAgentQuery } from '../../lib/default-agent.ts';
  import {
    addStep,
    moveStep,
    readBuilder,
    removeStep,
    setDescription,
    setName,
    setStepField,
    setTrigger,
    type BuilderStepKind,
    type BuilderTriggerKind,
  } from './workflow-builder-model.ts';

  interface Props {
    /** The file's text, which the page owns. */
    text: string;
    /** Takes the text after an edit. */
    onTextChange: (next: string) => void;
    /** A new workflow's name is its identifier and is typed here; an existing workflow's is fixed. */
    mode: 'create' | 'edit';
    /** Why the text cannot be saved, or the Bureau's words for a document it refused. */
    error: string;
    /** The JSON editor's id and words, which the page's tests and labels already know. */
    jsonId: string;
    jsonLabel: string;
    jsonDescription: string;
  }

  let { text, onTextChange, mode, error, jsonId, jsonLabel, jsonDescription }: Props = $props();

  const copy = WORKFLOW_COPY.builder;

  const queryClient = useQueryClient();

  /**
   * Adds a step at the end. A new agent step names the first agent that can run, asked for when
   * the step is added, and none when no agent can or the host does not say. The text is read after
   * the answer, so an edit made while it was coming is kept.
   */
  async function appendStep(kind: BuilderStepKind): Promise<void> {
    const agent =
      kind === 'agent'
        ? ((await queryClient.fetchQuery(defaultAgentQuery()).catch(() => null)) ?? '')
        : '';
    onTextChange(addStep(text, kind, agent));
  }

  let tab = $state<'builder' | 'json'>('builder');

  const view = $derived(readBuilder(text));

  const TRIGGER_OPTIONS = [
    { value: 'schedule', label: copy.triggerKinds.schedule },
    { value: 'signal', label: copy.triggerKinds.signal },
  ] as const;

  const ADD_ACTIONS: readonly { kind: BuilderStepKind; label: string }[] = [
    { kind: 'agent', label: copy.addAgent },
    { kind: 'wait', label: copy.addWait },
    { kind: 'signal', label: copy.addSignal },
  ];

  function changeTriggerKind(kind: string): void {
    if (kind === 'schedule' || kind === 'signal') {
      onTextChange(setTrigger(text, kind as BuilderTriggerKind, ''));
    }
  }
</script>

<div class="weft-workflow-builder" data-testid="workflow-builder">
  <Tabs bind:value={tab}>
    <Tabs.List label={copy.tabsLabel}>
      <Tabs.Trigger value="builder">{copy.builderTab}</Tabs.Trigger>
      <Tabs.Trigger value="json">{copy.jsonTab}</Tabs.Trigger>
    </Tabs.List>

    <Tabs.Panel value="builder">
      {#if view === undefined}
        <Alert variant="warning">
          <p class="weft-workflow-builder__alert-title">{copy.unreadable.title}</p>
          <p class="weft-workflow-builder__alert-body">{copy.unreadable.description}</p>
          <Button variant="secondary" onclick={() => (tab = 'json')}
            >{copy.unreadable.action}</Button
          >
        </Alert>
      {:else}
        {#if error !== ''}
          <Alert variant="danger">{error}</Alert>
        {/if}

        <div class="weft-workflow-builder__body">
          <FormSection heading={copy.detailsHeading} columns={2}>
            <Input
              id="workflow-builder-name"
              label={copy.nameLabel}
              description={copy.nameDescription}
              variant="code"
              readonly={mode === 'edit'}
              value={view.name}
              onValueChange={(next) => onTextChange(setName(text, next))}
            />
            <Textarea
              id="workflow-builder-description"
              label={copy.descriptionLabel}
              description={copy.descriptionDescription}
              rows={2}
              value={view.description}
              oninput={(event) => onTextChange(setDescription(text, event.currentTarget.value))}
            />
          </FormSection>

          <FormSection heading={copy.triggerHeading} columns={2}>
            <Select
              id="workflow-builder-trigger-kind"
              label={copy.triggerKindLabel}
              options={TRIGGER_OPTIONS}
              value={view.trigger?.kind === 'signal' ? 'signal' : 'schedule'}
              onchange={(event) => changeTriggerKind(event.currentTarget.value)}
              disabled={view.trigger?.kind === 'other'}
            />
            {#if view.trigger?.kind === 'signal'}
              <Input
                id="workflow-builder-trigger-field"
                label={copy.signalNameLabel}
                variant="code"
                value={view.trigger.name}
                onValueChange={(next) => onTextChange(setTrigger(text, 'signal', next))}
              />
            {:else if view.trigger?.kind === 'other'}
              <p class="weft-workflow-builder__note">{view.trigger.label}. {copy.otherTrigger}</p>
            {:else}
              <Input
                id="workflow-builder-trigger-field"
                label={copy.scheduleLabel}
                description={copy.scheduleDescription}
                variant="code"
                value={view.trigger?.spec ?? ''}
                onValueChange={(next) => onTextChange(setTrigger(text, 'schedule', next))}
              />
            {/if}
          </FormSection>

          <section class="weft-workflow-builder__steps" aria-label={copy.stepsHeading}>
            <SectionHeading level={2} title={copy.stepsHeading} />
            <p class="weft-workflow-builder__note">{copy.stepsDescription}</p>

            {#if !view.stepsEditable}
              <p
                class="weft-workflow-builder__note"
                data-testid="workflow-builder-steps-unreadable"
              >
                {copy.stepsUnreadable}
              </p>
            {:else if view.steps.length === 0}
              <EmptyState
                kind="first-use"
                size="compact"
                align="start"
                headingLevel={3}
                title={copy.noSteps.title}
                description={copy.noSteps.description}
              >
                {#snippet action()}
                  <Button variant="primary" size="sm" onclick={() => void appendStep('agent')}
                    >{copy.addAgent}</Button
                  >
                {/snippet}
              </EmptyState>
            {:else}
              <ol class="weft-workflow-builder__rows">
                {#each view.steps as step, index (index)}
                  {@const position = index + 1}
                  <li class="weft-workflow-builder__row" data-step-kind={step.kind}>
                    <span class="weft-workflow-builder__kind">
                      <span class="weft-workflow-builder__position">{position}</span>
                      <Badge variant="neutral">{copy.stepKinds[step.kind]}</Badge>
                    </span>
                    <div class="weft-workflow-builder__fields">
                      {#if step.kind === 'agent'}
                        <Input
                          id={`workflow-builder-step-${String(position)}-agent`}
                          label={copy.agentLabel(position)}
                          labelVisible={false}
                          size="sm"
                          variant="code"
                          value={step.agent}
                          onValueChange={(next) =>
                            onTextChange(setStepField(text, index, 'agent', next))}
                        />
                        <Textarea
                          id={`workflow-builder-step-${String(position)}-message`}
                          aria-label={copy.messageLabel(position)}
                          size="sm"
                          rows={2}
                          value={step.message}
                          oninput={(event) =>
                            onTextChange(
                              setStepField(text, index, 'message', event.currentTarget.value),
                            )}
                        />
                      {:else if step.kind === 'wait'}
                        <Input
                          id={`workflow-builder-step-${String(position)}-duration`}
                          label={copy.durationLabel(position)}
                          labelVisible={false}
                          description={copy.durationDescription}
                          size="sm"
                          variant="code"
                          value={step.duration}
                          onValueChange={(next) =>
                            onTextChange(setStepField(text, index, 'duration', next))}
                        />
                      {:else if step.kind === 'signal'}
                        <Input
                          id={`workflow-builder-step-${String(position)}-signal`}
                          label={copy.signalLabel(position)}
                          labelVisible={false}
                          size="sm"
                          variant="code"
                          value={step.signal}
                          onValueChange={(next) =>
                            onTextChange(setStepField(text, index, 'signal', next))}
                        />
                      {:else}
                        <span class="weft-workflow-builder__other">{step.label}</span>
                        <span class="weft-workflow-builder__note">{copy.otherStepNote}</span>
                      {/if}
                    </div>
                    <div class="weft-workflow-builder__row-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={index === 0}
                        aria-label={copy.moveEarlier(position)}
                        onclick={() => onTextChange(moveStep(text, index, -1))}>↑</Button
                      >
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={index === view.steps.length - 1}
                        aria-label={copy.moveLater(position)}
                        onclick={() => onTextChange(moveStep(text, index, 1))}>↓</Button
                      >
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={copy.remove(position)}
                        onclick={() => onTextChange(removeStep(text, index))}>×</Button
                      >
                    </div>
                  </li>
                {/each}
              </ol>
              <div class="weft-workflow-builder__add">
                {#each ADD_ACTIONS as action (action.kind)}
                  <Button variant="secondary" size="sm" onclick={() => void appendStep(action.kind)}
                    >{action.label}</Button
                  >
                {/each}
              </div>
            {/if}
          </section>

          <footer class="weft-workflow-builder__summary" data-testid="workflow-builder-summary">
            <p class="weft-workflow-builder__summary-label">{copy.summaryLabel}</p>
            <p class="weft-workflow-builder__summary-text">
              {view.summary === '' ? copy.summaryEmpty : view.summary}
            </p>
          </footer>
        </div>
      {/if}
    </Tabs.Panel>

    <Tabs.Panel value="json">
      <JsonEditor
        id={jsonId}
        label={jsonLabel}
        description={jsonDescription}
        rows={18}
        value={text}
        {error}
        validFeedbackVisible={false}
        onValueChange={onTextChange}
      />
    </Tabs.Panel>
  </Tabs>
</div>

<style>
  .weft-workflow-builder {
    min-width: 0;
  }

  .weft-workflow-builder__body {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding-top: var(--cinder-space-3);
  }

  .weft-workflow-builder__steps {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .weft-workflow-builder__rows {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .weft-workflow-builder__row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: var(--cinder-space-2);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-md);
  }

  .weft-workflow-builder__kind {
    display: inline-flex;
    gap: 8px;
    align-items: center;
    min-width: 5.5rem;
  }

  .weft-workflow-builder__position {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
  }

  .weft-workflow-builder__fields {
    display: flex;
    flex: 1 1 14rem;
    flex-wrap: wrap;
    gap: 8px;
    min-width: 0;
  }

  .weft-workflow-builder__fields > :global(*) {
    flex: 1 1 10rem;
    min-width: 0;
  }

  .weft-workflow-builder__other {
    overflow-wrap: anywhere;
  }

  .weft-workflow-builder__row-actions,
  .weft-workflow-builder__add {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .weft-workflow-builder__summary {
    padding-top: var(--cinder-space-3);
    border-top: 1px solid var(--cinder-border);
  }

  .weft-workflow-builder__summary-label,
  .weft-workflow-builder__note {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
  }

  .weft-workflow-builder__summary-text {
    margin: 4px 0 0;
    overflow-wrap: anywhere;
  }

  .weft-workflow-builder__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-workflow-builder__alert-body {
    margin: 4px 0 8px;
  }
</style>

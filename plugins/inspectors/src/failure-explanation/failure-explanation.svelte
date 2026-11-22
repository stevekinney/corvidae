<script lang="ts">
  /**
   * Why a run failed, drawn from Cinder's parts (COR-2533, COR-2543): the Bureau's sentence first,
   * then the facts in a two-column list (the cause, the step, how often it was tried, each
   * guardrail that fired), then what to do next. The Run page and the failure explanation panel
   * both draw the answer with this one component, so they cannot drift apart. A run the Bureau will
   * not explain is drawn here too, as a refusal, in the same type and the same stack, with a
   * sentence of its own (`refusalSentence`) in place of the Bureau's message. Every part is text,
   * never markup. The host names the step itself when it has a heading that does
   * (`showStep={false}`), so a step is never named twice on one card. The cause is plain text on
   * the label's edge, not a badge: a badge's fill is the alert's own tint on a failed run's card.
   */
  import { DescriptionList, Stack, Text, type DescriptionListItem } from '@lostgradient/cinder';

  import {
    FAILURE_EXPLANATION_LABELS as labels,
    failureCategoryLabel,
    refusalSentence,
    type ExplanationModel,
    type ExplanationRefusal,
  } from '@lostgradient/interborough-plugin/failure-explanation';

  let {
    model,
    refusal,
    showStep = true,
  }: {
    /** The answer to draw, for a failed run. */
    model?: ExplanationModel;
    /** The Bureau's refusal to draw instead, for a run it would not explain. */
    refusal?: ExplanationRefusal;
    showStep?: boolean;
  } = $props();

  const facts = $derived.by((): DescriptionListItem[] => {
    if (model === undefined) return [];
    const items: DescriptionListItem[] = [{ id: 'cause', term: labels.cause, definition: cause }];
    if (showStep && model.step !== null) {
      items.push({ id: 'step', term: labels.step, definition: model.step });
    }
    if (model.tries !== null) {
      items.push({ id: 'tries', term: labels.tries, definition: model.tries });
    }
    if (model.verdicts.length > 0) {
      items.push({ id: 'guardrails', term: labels.guardrails, definition: guardrails });
    }
    return items;
  });
</script>

{#snippet cause()}
  <span data-explanation="cause">
    {model === undefined ? '' : failureCategoryLabel(model.category)}
    {#if model !== undefined && model.causeDetail !== ''}{' '}<span data-explanation="cause-detail"
        >{model.causeDetail}</span
      >{/if}
  </span>
{/snippet}

{#snippet guardrails()}
  <!-- Keyed by place: the same guardrail can fire again, in the run or in a child run, and a
       verdict has no identity of its own. -->
  <Stack gap="var(--cinder-space-1)" data-explanation="guardrails">
    {#each model?.verdicts ?? [] as verdict, index (index)}
      <span>{verdict}</span>
    {/each}
  </Stack>
{/snippet}

{#if model !== undefined}
  <Stack gap="var(--cinder-space-3)" data-explanation="root">
    <Text variant="body" data-explanation="summary">{model.summary}</Text>
    <DescriptionList items={facts} variant="two-column" />
    <Text variant="body" data-explanation="remediation">
      <strong>{labels.next}.</strong>
      {model.remediation}
    </Text>
  </Stack>
{:else if refusal !== undefined}
  <Stack gap="var(--cinder-space-3)" data-explanation="root">
    <Text variant="body" data-explanation="summary">{refusalSentence(refusal)}</Text>
    {#if refusal.remediation !== null}
      <Text variant="body" data-explanation="remediation">
        <strong>{labels.next}.</strong>
        {refusal.remediation}
      </Text>
    {/if}
  </Stack>
{/if}

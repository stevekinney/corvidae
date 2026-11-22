<script lang="ts">
  /**
   * Why a run failed, drawn from Cinder's parts (COR-2533, COR-2543): the Bureau's sentence first,
   * then the facts in a two-column list (the cause under its badge, the step, how often it was
   * tried, each guardrail that fired), then what to do next. The Run page and the failure
   * explanation panel both draw the answer with this one component, so they cannot drift apart.
   * Every part is text, never markup. The host names the step itself when it has a heading that
   * does (`showStep={false}`), so a step is never named twice on one card.
   */
  import {
    Badge,
    DescriptionList,
    Stack,
    Text,
    type DescriptionListItem,
  } from '@lostgradient/cinder';

  import {
    FAILURE_EXPLANATION_LABELS as labels,
    failureCategoryLabel,
    failureCategoryTone,
    type ExplanationModel,
  } from './failure-explanation.ts';

  let { model, showStep = true }: { model: ExplanationModel; showStep?: boolean } = $props();

  const facts = $derived.by((): DescriptionListItem[] => {
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
    <Badge variant={failureCategoryTone(model.category)}>
      {failureCategoryLabel(model.category)}
    </Badge>
    {#if model.causeDetail !== ''}{' '}<span data-explanation="cause-detail"
        >{model.causeDetail}</span
      >{/if}
  </span>
{/snippet}

{#snippet guardrails()}
  <!-- Keyed by place: the same guardrail can fire again, in the run or in a child run, and a
       verdict has no identity of its own. -->
  <Stack gap="var(--cinder-space-1)" data-explanation="guardrails">
    {#each model.verdicts as verdict, index (index)}
      <span>{verdict}</span>
    {/each}
  </Stack>
{/snippet}

<Stack gap="var(--cinder-space-3)" data-explanation="root">
  <Text variant="body" data-explanation="summary">{model.summary}</Text>
  <DescriptionList items={facts} variant="two-column" />
  <Text variant="body" data-explanation="remediation">
    <strong>{labels.next}.</strong>
    {model.remediation}
  </Text>
</Stack>

<script lang="ts">
  /**
   * What a skill tells the agent (board PageCapabilities, frame "Skills tab, detail", row 31n,
   * COR-2435): the section "What it tells the agent" with a Show all link at its inline end, the
   * skill's SKILL.md rendered first in a card headed "Instructions" with the file's name and size,
   * and the raw file in a collapsed disclosure last. The body is read from the host
   * (`bureau.skills.get`) only while the skill is open; its Markdown is untrusted text, so it is
   * rendered and sanitized by `@lostgradient/markdown`, never inserted raw. Until Show all, the
   * rendered card is cut to a few lines.
   */
  import {
    Button,
    Card,
    Collapsible,
    EmptyState,
    SectionHeading,
    Skeleton,
  } from '@lostgradient/cinder';
  import { renderMarkdown } from '@lostgradient/markdown';
  import { createQuery } from '@tanstack/svelte-query';

  import { CAPABILITIES_COPY } from '../../app/copy/capabilities.ts';
  import { getSkillInstructions, skillBody } from '../../lib/bureau-skills.ts';
  import { formatBytes } from '../../lib/format/index.ts';
  import { queryKeys } from '../../lib/query.ts';

  interface Props {
    /** The skill's name, which the host reads its SKILL.md by. */
    name: string;
    /** The skill's name for a person, for the disclosure's label. */
    heading: string;
  }

  let { name, heading }: Props = $props();

  const copy = CAPABILITIES_COPY.skill.instructions;

  const read = createQuery(
    () => ({
      queryKey: queryKeys.skills.instructions(name),
      queryFn: ({ signal }) => getSkillInstructions(name, { signal }),
      retry: false,
    }),
    undefined,
  );

  let expanded = $state(false);
  const instructions = $derived(read.data?.instructions ?? null);
  const body = $derived(instructions === null ? '' : skillBody(instructions.text));
  const html = $derived(body === '' ? '' : renderMarkdown(body).html);
  const size = $derived(
    instructions === null ? '' : formatBytes(instructions.size).replace('.0 ', ' '),
  );
</script>

<section class="ib-capability__section" data-testid="skill-instructions">
  <SectionHeading level={4} title={copy.heading}>
    {#snippet actions()}
      {#if html !== ''}
        <Button
          variant="ghost-accent"
          size="sm"
          aria-expanded={expanded}
          onclick={() => (expanded = !expanded)}
          data-testid="skill-instructions-toggle">{expanded ? copy.showLess : copy.showAll}</Button
        >
      {/if}
    {/snippet}
  </SectionHeading>

  {#if read.isPending}
    <Skeleton variant="card" lines={3} delay={300} label={copy.loading} />
  {:else if read.isError}
    <p class="ib-capability__line" data-testid="skill-instructions-failed">{copy.failed}</p>
  {:else if instructions === null}
    <p class="ib-capability__line" data-testid="skill-instructions-unavailable">
      {copy.unavailable[read.data?.unavailableReason ?? 'unavailable'] ??
        copy.unavailable['unavailable']}
    </p>
  {:else}
    <Card variant="card" edge="border">
      <p class="ib-skill-instructions__title" data-testid="skill-instructions-title">
        <span class="ib-skill-instructions__name">{copy.cardTitle}</span>
        <span class="ib-skill-instructions__file">{copy.cardFile(size)}</span>
      </p>
      {#if html === ''}
        <!-- Cinder's one empty state, as every empty section is (COR-2431). -->
        <EmptyState kind="first-use" headingLevel={4} title={copy.empty} />
      {:else}
        <!-- `renderMarkdown` sanitizes before it returns HTML: a skill's file is untrusted text. -->
        <div
          class="cinder-markdown-content ib-skill-instructions__body"
          data-clamped={expanded ? undefined : ''}
          data-testid="skill-instructions-body"
        >
          {@html html}
        </div>
      {/if}
    </Card>
    {#if instructions.truncated}
      <p class="ib-capability__line" data-testid="skill-instructions-truncated">
        {copy.truncated}
      </p>
    {/if}
    <!-- Flat, as SchemaView's own disclosure is: not a box inside the detail's box. -->
    <Collapsible variant="flat" trigger={copy.raw} data-testid="skill-instructions-raw">
      <pre
        class="ib-skill-instructions__raw"
        aria-label={copy.rawLabel(heading)}>{instructions.text}</pre>
    </Collapsible>
  {/if}
</section>

<style>
  .ib-skill-instructions__title {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: baseline;
    margin: 0 0 var(--cinder-space-2);
  }

  .ib-skill-instructions__name {
    font-weight: var(--cinder-font-semibold);
  }

  .ib-skill-instructions__file {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  /* Until Show all, a few lines of the rendered file: the rest is one click away. */
  .ib-skill-instructions__body[data-clamped] {
    max-block-size: 12lh;
    overflow: hidden;
  }

  .ib-skill-instructions__raw {
    margin: 0;
    overflow-x: auto;
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>

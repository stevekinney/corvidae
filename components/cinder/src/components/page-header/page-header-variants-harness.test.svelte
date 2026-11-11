<script lang="ts">
  import Button from '../button/button.svelte';
  import PageHeader from './page-header.svelte';
  import type {
    PageHeaderOverflowAction,
    PageHeaderTone,
    PageHeaderVariant,
  } from './page-header.types.ts';

  let {
    variant = 'default',
    tone,
    collapsedBar,
    eyebrow,
    titleSoft,
    overflow,
    withDecisions = false,
    withActions = false,
    withFacts = false,
    withMedia = false,
    withArt = false,
    withFocal = false,
    title = 'Refund order 4471',
  }: {
    variant?: PageHeaderVariant;
    tone?: PageHeaderTone;
    collapsedBar?: boolean;
    eyebrow?: string;
    titleSoft?: string;
    overflow?: PageHeaderOverflowAction[];
    withDecisions?: boolean;
    withActions?: boolean;
    withFacts?: boolean;
    withMedia?: boolean;
    withArt?: boolean;
    withFocal?: boolean;
    title?: string;
  } = $props();
</script>

{#snippet decisionsSnippet()}
  <Button variant="primary">Approve</Button>
  <Button>Deny</Button>
{/snippet}

{#snippet actionsSnippet()}
  <Button variant="primary">Find a spot</Button>
{/snippet}

{#snippet factsSnippet()}
  <span class="harness-facts">LoDo</span>
{/snippet}

{#snippet mediaSnippet()}
  <span class="harness-media">Map of LoDo</span>
{/snippet}

{#snippet artSnippet()}
  <svg class="harness-art" viewBox="0 0 24 24"></svg>
{/snippet}

{#snippet focalSnippet()}
  <span class="harness-focal-value">$84.20</span>
  <small>Refund amount</small>
{/snippet}

<PageHeader
  {title}
  {variant}
  {...tone === undefined ? {} : { tone }}
  {...collapsedBar === undefined ? {} : { collapsedBar }}
  {...eyebrow === undefined ? {} : { eyebrow }}
  {...titleSoft === undefined ? {} : { titleSoft }}
  {...overflow === undefined ? {} : { overflow }}
  {...withDecisions ? { decisions: decisionsSnippet } : {}}
  {...withActions ? { actions: actionsSnippet } : {}}
  {...withFacts ? { facts: factsSnippet } : {}}
  {...withMedia ? { media: mediaSnippet } : {}}
  {...withArt ? { art: artSnippet } : {}}
  {...withFocal ? { focal: focalSnippet } : {}}
/>

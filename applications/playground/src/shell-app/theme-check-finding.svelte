<script lang="ts">
  /*
   * One finding: its rule, the measured and required values, the tokens, context and scene it
   * came from, the exceptions and untested areas, and a button that selects the exact editor
   * and preview state. `actions` is the seam COR-487 fills with fix actions; this component
   * renders nothing into it.
   */
  import { Button } from '@lostgradient/cinder';
  import type { Snippet } from 'svelte';

  import { ruleById } from './theme-check-rules.ts';
  import type { ReportRecord } from './theme-check-types.ts';

  type Props = {
    record: ReportRecord;
    onshow: (record: ReportRecord) => void;
    actions?: Snippet<[ReportRecord]> | undefined;
  };
  let { record, onshow, actions }: Props = $props();

  const rule = $derived(ruleById(record.ruleId));
  const scene = $derived(record.scenes[0]);
  const format = (value: number | null): string =>
    value === null ? 'not measured' : value.toFixed(3);
  // Labels name the context without the word "motion", which the toolbar's own control owns.
  const contextLabel = $derived(record.context.replace('/', ' ').replace('-motion', ''));
  const heading = $derived(`${rule.title} (${contextLabel})`);
</script>

<li
  class="finding"
  data-testid="finding"
  data-finding-id={record.id}
  data-severity={record.severity}
>
  <p class="finding__title">
    <strong>{rule.title}</strong>
    <span class="finding__context">{record.context}</span>
  </p>
  <p class="finding__message">{record.message}</p>
  <dl class="finding__details">
    <div>
      <dt>Measured</dt>
      <dd>{format(record.measured)}{record.unit === 'ratio' ? ':1' : ''}</dd>
    </div>
    <div>
      <dt>Required</dt>
      <dd>
        {record.required === null ? 'no threshold' : format(record.required)}{record.unit ===
          'ratio' && record.required !== null
          ? ':1'
          : ''}
      </dd>
    </div>
    <div>
      <dt>Tokens</dt>
      <dd>{record.tokenPaths.length === 0 ? 'none' : record.tokenPaths.join(', ')}</dd>
    </div>
    <div>
      <dt>Scene</dt>
      <dd>
        {#if scene}
          {scene.sceneId}, {scene.state} state, on {scene.background}
        {:else}
          no reference scene
        {/if}
      </dd>
    </div>
    <div>
      <dt>Source revision</dt>
      <dd>{record.sourceRevision}</dd>
    </div>
  </dl>
  {#if record.exceptions.length > 0 || record.untested.length > 0}
    <details class="finding__notes">
      <summary>Scope of this check</summary>
      {#if record.exceptions.length > 0}
        <p>Exceptions</p>
        <ul>
          {#each record.exceptions as exception (exception)}
            <li>{exception}</li>
          {/each}
        </ul>
      {/if}
      {#if record.untested.length > 0}
        <p>Not tested</p>
        <ul>
          {#each record.untested as area (area)}
            <li>{area}</li>
          {/each}
        </ul>
      {/if}
    </details>
  {/if}
  <div class="finding__actions" role="group" aria-label={`Actions for ${heading}`}>
    <Button
      label="Show in editor"
      variant="secondary"
      size="sm"
      aria-label={`Show in editor: ${rule.title}, ${contextLabel}`}
      onclick={() => onshow(record)}
    />
    {#if actions}
      {@render actions(record)}
    {/if}
  </div>
</li>

<style>
  .finding {
    display: grid;
    gap: 6px;
    padding: 10px 0;
    border-block-start: 1px solid var(--cinder-border-muted);
    list-style: none;
  }
  p {
    margin: 0;
  }
  .finding__context {
    margin-inline-start: 0.75ch;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
  .finding__message,
  .finding__details,
  .finding__notes {
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }
  .finding__details {
    display: grid;
    gap: 2px;
    margin: 0;
  }
  .finding__details div {
    display: flex;
    flex-wrap: wrap;
    gap: 0 1ch;
  }
  dt {
    color: var(--cinder-text-muted);
  }
  dt::after {
    content: ':';
  }
  dd {
    margin: 0;
  }
  .finding__notes ul {
    margin: 2px 0 6px;
    padding-inline-start: 1.25rem;
  }
  .finding__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>

<script lang="ts">
  /**
   * One tool the agent may call: a checkbox named by the tool, the line a person is shown for it,
   * and, when the model is told more than the line says, a disclosure with the full text. The line
   * is at most 120 characters (`lib/tool-line.ts`), so a tool whose description is a long prompt
   * does not turn the list into a wall of text.
   *
   * The disclosure is Cinder's `Collapsible`, flattened below: the component is a bordered card
   * with roomy padding, which a list of one-line rows cannot afford.
   */
  import { Checkbox, Collapsible } from '@lostgradient/cinder';

  import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
  import type { AgentCatalog } from '../../lib/agent-definitions.ts';
  import { toolLine } from '../../lib/tool-line.ts';

  interface Props {
    tool: AgentCatalog['tools'][number];
    checked: boolean;
    onChange: (next: boolean) => void;
  }

  let { tool, checked, onChange }: Props = $props();

  const copy = AGENT_EDITOR_COPY;
  const summary = $derived(toolLine(tool));
</script>

<li class="weft-tool-row" data-tool={tool.name}>
  <Checkbox id={`agent-tool-${tool.name}`} label={tool.name} {checked} onValueChange={onChange} />
  <div class="weft-tool-row__text">
    <span class="weft-tool-row__line" data-testid="agent-tool-line">{summary.line}</span>
    {#if summary.expandable}
      <Collapsible trigger={copy.toolDisclosure} animated={false} class="weft-tool-row__more">
        <p class="weft-tool-row__full" data-testid="agent-tool-full">{tool.description}</p>
      </Collapsible>
    {/if}
  </div>
</li>

<style>
  /* The name and its line share a row where there is room; on a phone the line wraps under the name. */
  .weft-tool-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    column-gap: var(--cinder-space-4);
    align-items: baseline;
    min-width: 0;
  }

  @media (min-width: 40rem) {
    .weft-tool-row {
      grid-template-columns: 13rem minmax(0, 1fr);
    }
  }

  /* A tool's name is an identifier, so it is set in monospace. */
  .weft-tool-row :global(.cinder-form-field__label) {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
  }

  /* The line, and the disclosure that follows it on the same row while there is room. */
  .weft-tool-row__text {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--cinder-space-3);
    align-items: baseline;
    min-width: 0;
  }

  .weft-tool-row__line {
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
    overflow-wrap: anywhere;
  }

  /* Flat: no card, no border, no band; just a quiet text control and the text it opens. */
  .weft-tool-row :global(.weft-tool-row__more) {
    background: none;
    border: none;
    border-radius: 0;
  }

  .weft-tool-row :global(.weft-tool-row__more[data-cinder-expanded]) {
    flex-basis: 100%;
  }

  .weft-tool-row :global(.weft-tool-row__more .cinder-collapsible__trigger) {
    inline-size: auto;
    gap: var(--cinder-space-1);
    padding: 0;
    background: none;
    color: var(--cinder-text-secondary);
    font-size: var(--cinder-text-sm);
    font-weight: var(--cinder-font-normal);
  }

  .weft-tool-row :global(.weft-tool-row__more .cinder-collapsible__trigger:hover:not(:disabled)) {
    background: none;
    text-decoration: underline;
  }

  .weft-tool-row :global(.weft-tool-row__more .cinder-collapsible__label) {
    flex: none;
    font-weight: var(--cinder-font-normal);
  }

  .weft-tool-row :global(.weft-tool-row__more .cinder-collapsible__chevron) {
    inline-size: 1rem;
    block-size: 1rem;
  }

  .weft-tool-row :global(.weft-tool-row__more .cinder-collapsible__panel-inner) {
    padding: var(--cinder-space-1) 0 var(--cinder-space-2);
    background: none;
    font-size: var(--cinder-text-sm);
  }

  .weft-tool-row__full {
    margin: 0;
    color: var(--cinder-text-muted);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>

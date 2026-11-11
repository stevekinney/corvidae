<script lang="ts">
  /**
   * The Edit agent form while the agent is read (rows 43h, 43i): nothing for the first 300 ms, so a
   * quick read never flashes a placeholder, then placeholders for the form's fields with "Loading
   * agent" announced and no spinner. The sticky summary reads "Loading agent". Save is inert
   * (`aria-disabled`, still focusable, described by the same words) until the agent loads, so an
   * agent that has not loaded cannot be submitted; Cancel stays live. Try it is not drawn until
   * the agent is, because it chats with the form as it stands.
   */
  import { Button, Skeleton, Tooltip } from '@lostgradient/cinder';

  import { AGENT_EDITOR_COPY } from '../../app/copy.ts';

  interface Props {
    /** Leaves the page, as Cancel does on the form. */
    onCancel: () => void;
  }

  let { onCancel }: Props = $props();

  const copy = AGENT_EDITOR_COPY;

  /** The wait before placeholders show, in milliseconds (the loading rule every page shares). */
  const LOADING_DELAY_MILLISECONDS = 300;
</script>

<div class="weft-agent-loading" data-testid="agent-loading">
  <Skeleton variant="form" rows={4} delay={LOADING_DELAY_MILLISECONDS} label={copy.edit.loading} />

  <!-- The same bar the form ends with, so nothing moves when the agent arrives. -->
  <div class="weft-agent-loading__footer">
    <p class="weft-agent-loading__status" role="status" data-testid="agent-save-status">
      {copy.edit.loading}
    </p>
    <div class="weft-agent-loading__actions">
      <Button type="button" variant="ghost" onclick={onCancel}>{copy.cancelAction}</Button>
      <Tooltip text={copy.edit.loading}>
        <Button type="button" variant="primary" aria-disabled="true">{copy.saveAction}</Button>
      </Tooltip>
    </div>
  </div>
</div>

<style>
  .weft-agent-loading {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    max-inline-size: 48rem;
  }

  /* The form's sticky bar (`agent-editor-form.svelte`), drawn the same way. */
  .weft-agent-loading__footer {
    position: sticky;
    bottom: calc(-1 * var(--cinder-space-6));
    z-index: 1;
    margin-block-end: calc(-1 * var(--cinder-space-6));
    padding-block: var(--cinder-space-3);
    background: var(--cinder-surface-canvas);
    border-block-start: 1px solid var(--cinder-border);
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-3) var(--cinder-space-4);
    align-items: center;
    justify-content: flex-end;
  }

  .weft-agent-loading__status {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }

  .weft-agent-loading__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: center;
  }
</style>

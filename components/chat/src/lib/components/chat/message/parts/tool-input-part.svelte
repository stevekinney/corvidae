<script lang="ts" module>
  import type { ToolInputMessagePart } from '../../utilities/types.ts';

  export type ToolInputPartProps = {
    /** The tool-input render part. */
    part: ToolInputMessagePart;
    /** Called with the schema-valid value when the user submits the form. */
    onInputSubmit?: ((toolCallId: string, value: unknown) => void | Promise<void>) | undefined;
  };
</script>

<script lang="ts">
  import { SchemaForm } from '@lostgradient/cinder';

  let { part, onInputSubmit }: ToolInputPartProps = $props();

  const headingId = $props.id();
  let submitted = $state(false);
  let failed = $state(false);

  // SchemaForm calls this only after the value validates, and ignores further
  // submits while it awaits, so one valid submit reaches the callback once.
  async function submitInput(value: unknown): Promise<void> {
    if (onInputSubmit === undefined || submitted) return;
    failed = false;
    try {
      await onInputSubmit(part.toolCallId, value);
      submitted = true;
    } catch {
      failed = true;
    }
  }
</script>

<section class="chat-tool-input" aria-labelledby={headingId} data-cinder-tool-input>
  <h4 id={headingId} class="chat-tool-input-heading">Input requested by {part.toolName}</h4>
  {#if part.message}
    <p class="chat-tool-input-message">{part.message}</p>
  {/if}
  {#if submitted}
    <p class="chat-tool-input-status" role="status">Input submitted.</p>
  {:else if onInputSubmit !== undefined}
    {#if failed}
      <p class="chat-tool-input-error" role="alert">The input could not be sent. Try again.</p>
    {/if}
    <SchemaForm schema={part.schema} onSubmit={submitInput} />
  {/if}
</section>

<style>
  .chat-tool-input {
    display: grid;
    gap: var(--cinder-space-2);
    inline-size: 100%;
  }

  .chat-tool-input-heading {
    margin: 0;
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
    font-weight: var(--cinder-font-semibold);
  }

  .chat-tool-input-message,
  .chat-tool-input-status {
    margin: 0;
  }

  .chat-tool-input-error {
    margin: 0;
    padding: var(--cinder-space-2) var(--cinder-space-3);
    background: var(--cinder-status-danger-background);
    border-radius: var(--cinder-radius-md);
    color: var(--cinder-status-danger-text);
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
  }
</style>

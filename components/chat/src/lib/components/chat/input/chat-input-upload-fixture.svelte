<script lang="ts" module>
  import type { ChatAttachmentErrorFormatter, ChatAttachmentUpload } from './chat-attachment.ts';

  export type ChatInputUploadFixtureProps = {
    acceptedTypes: string[];
    maxFileSize: number;
    uploadAttachment?: ChatAttachmentUpload | undefined;
    formatAttachmentError?: ChatAttachmentErrorFormatter | undefined;
    onAttachmentFailure?: ((file: File, error: string) => void) | undefined;
  };
</script>

<script lang="ts">
  /**
   * A composer whose `acceptedTypes` and `maxFileSize` a test can change after attachments are in
   * it, which is what a host does when the agent a person is writing to changes.
   */
  import ChatInput from './chat-input.svelte';

  let {
    acceptedTypes: initialTypes,
    maxFileSize: initialSize,
    ...rest
  }: ChatInputUploadFixtureProps = $props();

  // The props are the starting point; the test then changes the live values.
  let acceptedTypes = $state<string[]>(
    // svelte-ignore state_referenced_locally
    initialTypes,
  );
  let maxFileSize = $state(
    // svelte-ignore state_referenced_locally
    initialSize,
  );
  let input: ChatInput | undefined = $state();

  export function setLimits(next: { acceptedTypes?: string[]; maxFileSize?: number }): void {
    if (next.acceptedTypes !== undefined) acceptedTypes = next.acceptedTypes;
    if (next.maxFileSize !== undefined) maxFileSize = next.maxFileSize;
  }

  export function addFiles(files: File[]): void {
    input?.addFiles(files);
  }
</script>

<ChatInput id="recheck-composer" bind:this={input} {acceptedTypes} {maxFileSize} {...rest} />

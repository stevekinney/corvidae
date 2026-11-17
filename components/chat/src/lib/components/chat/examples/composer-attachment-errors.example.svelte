<script lang="ts" module>
  export const title = 'Composer with attachment errors';
  export const description =
    'Each failed file stays as a chip naming it, with the reason beside it and a Remove link: an unsupported type, a file over the limit, and a failed upload. The composer keeps the typed text and Send stays enabled for the text; a failed file is left out of the message.';
</script>

<script lang="ts">
  import { onMount } from 'svelte';

  import { ChatInput, type ChatAttachmentFailure } from '@lostgradient/chat';

  const MEGABYTE = 1024 * 1024;
  let value = $state('Please refund order 4471, it arrived damaged.');
  let input: ReturnType<typeof ChatInput> | undefined;

  function words(failure: ChatAttachmentFailure): string {
    if (failure.kind === 'type-not-accepted') {
      return 'Can’t attach: TIFF files aren’t supported. Use PNG, JPG, PDF or text.';
    }
    if (failure.kind === 'too-large') return 'Can’t attach: 28 MB is over the 10 MB limit.';
    return 'Upload failed. Try again, or remove it.';
  }

  // The third file passes the checks and then fails to upload.
  async function upload(file: File): Promise<{ id: string }> {
    if (file.name === 'invoice.pdf') throw new Error('The upload did not finish.');
    return { id: file.name };
  }

  onMount(() => {
    const big = new File([new Uint8Array(8)], 'photo.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 28 * MEGABYTE });
    input?.addFiles([
      new File(['II*'], 'scan.tiff', { type: 'image/tiff' }),
      big,
      new File(['%PDF'], 'invoice.pdf', { type: 'application/pdf' }),
    ]);
  });
</script>

<ChatInput
  id="composer-attachment-errors"
  bind:this={input}
  bind:value
  placeholder="Message Tool runner…"
  acceptedTypes={['image/png', 'image/jpeg', 'application/pdf', 'text/*']}
  maxFileSize={10 * MEGABYTE}
  uploadAttachment={upload}
  formatAttachmentError={words}
/>

<script lang="ts">
  import { FileUpload, FormField } from '@lostgradient/cinder';
  import type { FileUploadEntry } from '@lostgradient/cinder';

  let acceptedNames = $state<string[]>([]);
  let rejectedMessages = $state<string[]>([]);

  function handleFilesChange(entries: FileUploadEntry[]) {
    acceptedNames = entries
      .filter((entry) => entry.rejectionReason === undefined)
      .map((entry) => entry.file.name);
    rejectedMessages = entries.flatMap((entry) =>
      entry.rejectionReason !== undefined && entry.error ? [entry.error] : [],
    );
  }
</script>

<!-- Compose with FormField so the file input has an associated <label>. -->
<FormField id="attachment" label="Attachment" description="Images or PDF, up to 5 MB.">
  <FileUpload
    id="attachment"
    accept="image/*,.pdf"
    multiple
    maxSize={5 * 1024 * 1024}
    onFilesChange={handleFilesChange}
  />
</FormField>

{#if acceptedNames.length > 0}
  <p class="note margin-block-start-2">
    Accepted: {acceptedNames.join(', ')}
  </p>
{/if}

{#if rejectedMessages.length > 0}
  <p class="note-layout margin-block-start-2">
    {rejectedMessages.join('; ')}
  </p>
{/if}

<style>
  .note {
    color: var(--cinder-status-success-text);
  }

  .note-layout {
    color: var(--cinder-status-danger-text);
  }
</style>

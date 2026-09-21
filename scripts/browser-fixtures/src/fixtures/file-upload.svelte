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
  <p style="margin-top: 0.5rem; color: var(--cinder-status-success-text);">
    Accepted: {acceptedNames.join(', ')}
  </p>
{/if}

{#if rejectedMessages.length > 0}
  <p style="margin-top: 0.5rem; color: var(--cinder-status-danger-text);">
    {rejectedMessages.join('; ')}
  </p>
{/if}

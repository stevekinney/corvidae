<script lang="ts">
  /**
   * Renders a raw storage value (plan §9.6: "Value display via
   * PayloadInspector — values are opaque bytes — handle non-JSON
   * gracefully"). JSON small enough to lay out goes through `PayloadInspector` as fields with a
   * switch to the JSON itself. Text that is not JSON, and JSON too large to lay out, is shown as
   * plain monospaced text under "Value, text, 2.1 MB", its first 64 KB only, with a note that says
   * so and that Copy value copies all of it. Anything that fails UTF-8 decoding renders as an
   * explicit binary fallback instead of garbling through the inspector. The inspector is bare: the
   * pane around it is the card.
   */
  import { PayloadInspector } from '@lostgradient/cinder';

  import { STORAGE_COPY } from '../../app/copy.ts';
  import { formatBytes } from '../../lib/format/index.ts';
  import { formatStoredField, TEXT_VIEW_BYTES, textViewOf } from './key-value.ts';
  import { previewStorageValue } from './value-preview.ts';

  interface StorageValueDisplayProps {
    value: Uint8Array;
    label?: string;
  }

  let { value, label = 'Value' }: StorageValueDisplayProps = $props();

  const copy = STORAGE_COPY.detail;
  const preview = $derived(previewStorageValue(value));
  const textView = $derived(textViewOf(value));
  // "Showing the first 64 KB. Copy value copies all 2.1 MB." only when the start is all that is shown,
  // then why there is no switch.
  const note = $derived.by((): string | undefined => {
    if (textView === undefined) return undefined;
    const why = textView.reason === 'not-json' ? copy.textNote.notJson : copy.textNote.tooLarge;
    return textView.truncated
      ? `${copy.textNote.shownStart(formatBytes(TEXT_VIEW_BYTES), formatBytes(preview.byteLength))} ${why}`
      : why;
  });
</script>

{#if preview.kind === 'empty'}
  <p class="weft-storage-empty-value">Empty value (0 bytes).</p>
{:else if preview.kind === 'binary'}
  <p class="weft-storage-binary-value">
    Binary value, {formatBytes(preview.byteLength)} — not valid UTF-8, cannot be displayed as text.
  </p>
{:else if textView !== undefined}
  <div class="ib-storage-text" data-testid="storage-text-value">
    <PayloadInspector
      value={textView.shown}
      label={copy.textValueLabel(formatBytes(preview.byteLength))}
      redact={[]}
      bare
      plain
    />
    <p class="ib-storage-text__note" data-testid="storage-text-note">{note}</p>
  </div>
{:else}
  <!-- The stored value is the source: nothing else shows it, so no property is hidden by its name. -->
  <PayloadInspector value={preview.text} {label} redact={[]} bare formatValue={formatStoredField} />
{/if}

<style>
  .ib-storage-text {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-storage-text__note {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>

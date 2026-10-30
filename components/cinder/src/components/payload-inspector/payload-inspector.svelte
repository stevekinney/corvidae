<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status stable
   * @purpose Inspector for structured payloads: labelled fields by default with a Fields / JSON switch, a copy action, and size and truncation status.
   * @tag json
   * @tag inspector
   * @tag payload
   * @useWhen Inspecting workflow inputs, signal payloads, activity results, or API response bodies in a dashboard.
   * @useWhen Displaying a structured payload with a visible label, byte size, and copy affordance.
   * @useWhen Reading a payload as data first, with the raw JSON one switch away.
   * @avoidWhen Rendering a raw code block only — use code-block directly instead.
   * @avoidWhen Needing search, filtering, or virtualization over large collections — compose a custom viewer.
   * @related json-viewer, code-block, copy-button, schema-view
   */
  export type {
    PayloadInspectorField,
    PayloadInspectorProps,
    PayloadInspectorSchemaProps,
    PayloadInspectorSchemaValue,
    PayloadInspectorView,
  } from './payload-inspector.types.ts';
</script>

<script lang="ts">
  import type { PayloadInspectorProps, PayloadInspectorView } from './payload-inspector.types.ts';

  import Badge from '../badge/badge.svelte';
  import CopyButton from '../copy-button/copy-button.svelte';
  import JsonViewer from '../json-viewer/json-viewer.svelte';
  import Segment from '../segment/segment.svelte';
  import SegmentedControl from '../segmented-control/segmented-control.svelte';
  import { classNames } from '../../utilities/class-names.ts';
  import { humanizeIdentifier } from '../../utilities/humanize-identifier.ts';
  import { isIdentifierField, readPayloadEntries } from './payload-inspector-fields.ts';

  let {
    value,
    truncated = false,
    initialDepth = 1,
    maxDepth = 50,
    maxBytes = 1_048_576,
    parse,
    label = 'Payload inspector',
    view = $bindable('fields'),
    linkFor,
    class: className,
    ...rest
  }: PayloadInspectorProps = $props();

  const switchId = $props.id();

  // --------------------------------------------------------------------------
  // Parsing: preserve plain string values, while still accepting serialized JSON
  // strings for object, array, and JSON primitive payloads.
  // --------------------------------------------------------------------------

  type ParseResult = { ok: true; parsed: unknown } | { ok: false; error: string };

  function shouldParseString(raw: string): boolean {
    const trimmed = raw.trim();
    if (/^[{["]/.test(trimmed)) return true;
    return /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(trimmed);
  }

  const parseResult = $derived.by((): ParseResult => {
    if (typeof value !== 'string') {
      return { ok: true, parsed: value };
    }
    // Empty string is treated as null/absent rather than an error.
    if (value.trim() === '') {
      return { ok: true, parsed: null };
    }
    if (parse === undefined && !shouldParseString(value)) {
      return { ok: true, parsed: value };
    }
    try {
      const parser = parse ?? JSON.parse;
      return { ok: true, parsed: parser(value) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const parsedValue = $derived(parseResult.ok ? parseResult.parsed : undefined);

  // --------------------------------------------------------------------------
  // Serialized size — compute once from the canonical in-memory value so that
  // size display and the oversize gate are consistent with each other.
  // --------------------------------------------------------------------------

  type SizeResult = { ok: true; bytes: number } | { ok: false };

  const sizeResult = $derived.by((): SizeResult => {
    if (!parseResult.ok) return { ok: false };
    try {
      const json = JSON.stringify(parsedValue);
      if (typeof json !== 'string') return { ok: false };
      return { ok: true, bytes: new Blob([json]).size };
    } catch {
      return { ok: false };
    }
  });

  const byteLabel = $derived.by((): string => {
    if (!sizeResult.ok) return 'Unknown size';
    const bytes = sizeResult.bytes;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  });

  // True when the in-memory value cannot be round-tripped through JSON.stringify
  // (e.g. circular references, BigInt). Only fires for non-string values that
  // parsed successfully — string parse errors are handled by parseResult.ok.
  const unserializable = $derived.by((): boolean => {
    if (typeof value === 'string' || !parseResult.ok) return false;
    try {
      JSON.stringify(parsedValue);
      return false;
    } catch {
      return true;
    }
  });

  const isEmpty = $derived(parsedValue === undefined && value === undefined);

  const isPrimitive = $derived(
    parsedValue === null ||
      typeof parsedValue === 'boolean' ||
      typeof parsedValue === 'number' ||
      typeof parsedValue === 'string',
  );

  // Copy target: the original string verbatim whenever the payload itself was
  // a string — including a JSON-encoded string primitive like '"hello"',
  // which parses to the bare string `hello` but should still copy as the
  // original input, not the unquoted parsed result. Everything else copies
  // as pretty-printed JSON of the parsed value.
  const copyText = $derived.by((): string => {
    if (!parseResult.ok) return typeof value === 'string' ? value : '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(parsedValue, null, 2) ?? '';
    } catch {
      return '';
    }
  });

  const canCopy = $derived(!isEmpty && copyText !== '');

  // Fields and JSON describe a structured payload. A primitive, an empty value,
  // a parse failure and an unserializable value have nothing to switch between.
  const isStructured = $derived(
    parseResult.ok &&
      !unserializable &&
      !isEmpty &&
      !isPrimitive &&
      typeof parsedValue === 'object',
  );

  const tooLarge = $derived(sizeResult.ok && sizeResult.bytes > maxBytes);

  function selectView(next: PayloadInspectorView): void {
    view = next;
  }

  function handleViewChange(next: string): void {
    if (next === 'fields' || next === 'json') selectView(next);
  }

  // Fields view only: how many entries of one object or array render before the
  // rest are summarised, so a very wide payload cannot build an unbounded DOM.
  const FIELD_ENTRY_LIMIT = 100;
</script>

{#snippet scalar(key: string, value: unknown, path: string[])}
  {@const href = linkFor?.({ path, key, value })}
  {#if value === null}
    <span class="cinder-payload-inspector__null">null</span>
  {:else if typeof value === 'string' && value === ''}
    <span class="cinder-payload-inspector__null">Empty</span>
  {:else if href !== undefined}
    <a
      class="cinder-payload-inspector__link"
      data-cinder-identifier={isIdentifierField(key, value) || undefined}
      {href}>{String(value)}</a
    >
  {:else if isIdentifierField(key, value)}
    <code class="cinder-payload-inspector__identifier">{String(value)}</code>
  {:else if typeof value === 'number' || typeof value === 'bigint'}
    <span class="cinder-payload-inspector__number">{String(value)}</span>
  {:else}
    <span class="cinder-payload-inspector__text">{String(value)}</span>
  {/if}
{/snippet}

{#snippet fieldRows(source: unknown, path: string[], depth: number)}
  {@const entries = readPayloadEntries(source)}
  {#if entries.length === 0}
    <span class="cinder-payload-inspector__null"
      >{Array.isArray(source) ? 'No items' : 'No fields'}</span
    >
  {:else}
    <dl class="cinder-payload-inspector__fields">
      {#each entries.slice(0, FIELD_ENTRY_LIMIT) as entry (entry.key)}
        <div class="cinder-payload-inspector__field">
          <dt class="cinder-payload-inspector__field-label">
            {entry.isIndex ? entry.key : humanizeIdentifier(entry.key)}
          </dt>
          <dd class="cinder-payload-inspector__field-value">
            {#if entry.nested && depth < maxDepth}
              {@render fieldRows(entry.value, [...path, entry.key], depth + 1)}
            {:else if entry.nested}
              <span class="cinder-payload-inspector__null">Too deep to show here.</span>
            {:else}
              {@render scalar(entry.key, entry.value, [...path, entry.key])}
            {/if}
          </dd>
        </div>
      {/each}
    </dl>
    {#if entries.length > FIELD_ENTRY_LIMIT}
      <p class="cinder-payload-inspector__more">
        {entries.length - FIELD_ENTRY_LIMIT} more not shown. Switch to JSON to see them.
      </p>
    {/if}
  {/if}
{/snippet}

<div {...rest} class={classNames('cinder-payload-inspector', className)}>
  <!-- Heading row: label on the left; size, view switch and copy on the right -->
  <div class="cinder-payload-inspector__header">
    <span class="cinder-payload-inspector__label">{label}</span>
    <div class="cinder-payload-inspector__header-actions">
      {#if isStructured}
        <SegmentedControl
          id={switchId}
          label={`${label} view`}
          labelVisible={false}
          size="sm"
          value={view}
          onValueChange={handleViewChange}
        >
          <Segment value="fields">Fields</Segment>
          <Segment value="json">JSON</Segment>
        </SegmentedControl>
      {/if}
      {#if sizeResult.ok}
        <span class="cinder-payload-inspector__size" aria-label={`${byteLabel} payload size`}>
          {byteLabel}
        </span>
      {/if}
      {#if truncated}
        <Badge variant="warning" size="xs">Truncated</Badge>
      {/if}
      {#if canCopy}
        <CopyButton
          value={copyText}
          label={`Copy ${label}`}
          copiedLabel="Copied"
          title={`Copy ${label}`}
          iconOnly
        />
      {/if}
    </div>
  </div>

  <div class="cinder-payload-inspector__panel">
    {#if isEmpty}
      <div class="cinder-payload-inspector__empty" role="status">No payload</div>
    {:else if !parseResult.ok}
      <div
        class="cinder-payload-inspector__notice cinder-payload-inspector__notice--warning"
        role="alert"
      >
        Parse error: {parseResult.error}
      </div>
      {#if typeof value === 'string'}
        <pre class="cinder-payload-inspector__primitive">{value}</pre>
      {/if}
    {:else if unserializable}
      <div class="cinder-payload-inspector__notice" role="status">
        This value can't be serialized as JSON (it may contain circular references or BigInt
        values).
      </div>
    {:else if isPrimitive}
      <pre class="cinder-payload-inspector__primitive">{String(parsedValue)}</pre>
    {:else if view === 'json'}
      <JsonViewer value={parsedValue} {initialDepth} {maxDepth} {maxBytes} />
    {:else if tooLarge}
      <div class="cinder-payload-inspector__notice" role="status">
        Payload too large to show as fields (~{Math.round(
          (sizeResult.ok ? sizeResult.bytes : 0) / 1024,
        )} KB; cap is {Math.round(maxBytes / 1024)} KB). Copy it to inspect the raw JSON.
      </div>
    {:else}
      <div class="cinder-payload-inspector__field-view">
        {@render fieldRows(parsedValue, [], 0)}
      </div>
    {/if}
  </div>
</div>

<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status stable
   * @purpose Card for any payload: sentence-case fields by default, a Fields / JSON switch, count and size, one copy action, secret masking, and states from streaming to failed.
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

  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Check from '@lucide/svelte/icons/check';
  import Download from '@lucide/svelte/icons/download';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Badge from '../badge/badge.svelte';
  import Button from '../button/button.svelte';
  import CodeBlock from '../code-block/code-block.svelte';
  import CopyButton from '../copy-button/copy-button.svelte';
  import InlineLoading from '../inline-loading/inline-loading.svelte';
  import JsonViewer from '../json-viewer/json-viewer.svelte';
  import Segment from '../segment/segment.svelte';

  import SegmentedControl from '../segmented-control/segmented-control.svelte';
  import { classNames } from '../../utilities/class-names.ts';
  import { formatBytes } from '../../utilities/format-bytes.ts';
  import {
    chooseFieldsLayout,
    headerCount,
    isTreePayload,
    LARGE_ARRAY_ABOVE,
    readPartialObject,
  } from './payload-inspector-model.ts';
  import {
    containsSecret,
    maskSecrets,
    SECRET_MASK,
    writeSecretsAsText,
  } from './payload-inspector-secrets.ts';
  import PayloadFields from './_payload-fields.svelte';
  import PayloadScalar from './_payload-scalar.svelte';

  let {
    value,
    truncated = false,
    initialDepth = 1,
    maxDepth = 50,
    maxBytes = 1_048_576,
    parse,
    label,
    view = $bindable('fields'),
    linkFor,
    redact,
    formatValue,
    streaming = false,
    failed = false,
    failedMessage = "Couldn't load the full result.",
    onRetry,
    emptyLabel = 'No payload',
    downloadFilename = 'payload.json',
    class: className,
    ...rest
  }: PayloadInspectorProps = $props();

  const switchId = $props.id();

  // --------------------------------------------------------------------------
  // Parsing: preserve plain string values, while still accepting serialized JSON
  // strings for object, array, and JSON primitive payloads. A payload still
  // arriving is text that is not whole yet, so it is read as it stands below.
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

  // The text received so far. `value` is a string while a payload streams, and nothing before the first chunk.
  const arrivedText = $derived(typeof value === 'string' ? value : '');
  const arriving = $derived(streaming && (typeof value === 'string' || value === undefined));
  const partial = $derived(arriving ? readPartialObject(arrivedText) : undefined);
  const isEmpty = $derived(!arriving && value === undefined);

  // True when the in-memory value cannot be round-tripped through JSON.stringify
  // (e.g. circular references, BigInt). Only fires for non-string values that
  // parsed successfully — string parse errors are handled by parseResult.ok.
  const unserializable = $derived.by((): boolean => {
    if (arriving || typeof value === 'string' || !parseResult.ok || isEmpty) return false;
    try {
      return typeof JSON.stringify(parseResult.parsed) !== 'string';
    } catch {
      return true;
    }
  });

  // Secrets are hidden here, before any size, layout or copy text is worked out from the value.
  const shown = $derived.by((): unknown => {
    if (arriving) return maskSecrets(Object.fromEntries(partial?.entries ?? []), redact);
    if (!parseResult.ok || isEmpty || unserializable) return undefined;
    return maskSecrets(parseResult.parsed, redact);
  });

  const serialized = $derived.by((): string | undefined => {
    if (shown === undefined || arriving) return undefined;
    try {
      return JSON.stringify(shown);
    } catch {
      return undefined;
    }
  });
  const bytes = $derived(serialized === undefined ? undefined : new Blob([serialized]).size);
  const tooLarge = $derived(bytes !== undefined && bytes > maxBytes);

  const isStructured = $derived(
    typeof shown === 'object' && shown !== null && !(shown instanceof Date),
  );

  type Mode = 'failed' | 'none' | 'unserializable' | 'oversize' | 'invalid' | 'streaming' | 'ready';

  // The card is in exactly one of these states, and each one decides the header and the body, so
  // the order below is the precedence.
  const mode = $derived.by((): Mode => {
    if (failed) return 'failed';
    if (isEmpty) return 'none';
    if (arriving) return 'streaming';
    if (!parseResult.ok) return 'invalid';
    if (unserializable) return 'unserializable';
    if (tooLarge) return 'oversize';
    return 'ready';
  });

  // Copy writes what the card shows. A string payload copies as it came, unless a secret in it was
  // hidden, in which case the hidden copy is written instead so Copy never holds the stored value.
  const copyText = $derived.by((): string => {
    if (mode === 'invalid') return typeof value === 'string' ? value : '';
    if (mode !== 'ready' && mode !== 'oversize') return '';
    if (typeof value === 'string' && !containsSecret(shown)) return value;
    return serialized === undefined ? '' : (JSON.stringify(shown, null, 2) ?? '');
  });

  const copyLabel = $derived(mode === 'invalid' ? 'Copy text' : `Copy ${label ?? 'payload'}`);
  const showCopy = $derived(mode !== 'none' && mode !== 'unserializable');
  const copyDisabled = $derived(mode === 'failed' || mode === 'streaming');
  const showSwitch = $derived(mode === 'ready' || mode === 'streaming' || mode === 'invalid');

  const countText = $derived.by((): string | undefined => {
    if (mode === 'ready') return headerCount(shown, { bytes });
    if (mode === 'streaming') return headerCount(shown, { streaming: true });
    if (mode === 'invalid') return 'Text';
    if (mode === 'oversize' && bytes !== undefined) return formatBytes(bytes);
    return undefined;
  });

  const fieldsOptions = $derived({
    linkFor,
    formatValue,
    initialDepth,
    maxDepth,
    tree: isTreePayload(shown),
  });

  // A payload that has said nothing whole yet has no field to list, only the wait.
  const receivingOnly = $derived(
    mode === 'streaming' &&
      (partial === undefined || (partial.entries.length === 0 && partial.pendingKey === undefined)),
  );

  const rootLayout = $derived.by(() => {
    if (
      typeof shown !== 'object' ||
      shown === null ||
      Array.isArray(shown) ||
      shown instanceof Date
    ) {
      return 'rows' as const;
    }
    return chooseFieldsLayout(
      Object.entries(shown).map(([key, entry]) => ({
        key,
        value: entry,
        linked:
          linkFor?.({ path: [key], key, value: entry }) !== undefined &&
          (entry === null || typeof entry !== 'object'),
      })),
      { streaming: arriving },
    );
  });

  // The JSON view of a payload still arriving is the text so far, with a hidden value written as
  // bullets, so what has not arrived whole is shown as received.
  const streamingText = $derived.by((): string => {
    if (!arriving) return '';
    if (partial === undefined) return arrivedText;
    const lines = Object.entries(shown as Record<string, unknown>).map(
      ([key, entry]) =>
        `  ${JSON.stringify(key)}: ${JSON.stringify(writeSecretsAsText(entry), null, 2)?.replaceAll('\n', '\n  ')}`,
    );
    if (partial.pendingKey !== undefined) {
      const pending = maskSecrets({ [partial.pendingKey]: 0 }, redact) as Record<string, unknown>;
      const hidden = typeof pending[partial.pendingKey] !== 'number';
      lines.push(
        `  ${JSON.stringify(partial.pendingKey)}: ${hidden ? JSON.stringify(SECRET_MASK) : (partial.pendingText ?? '')}`,
      );
    }
    return `{\n${lines.join(',\n')}`;
  });

  function handleViewChange(next: string): void {
    if (next === 'fields' || next === 'json') view = next satisfies PayloadInspectorView;
  }

  function download(): void {
    const url = URL.createObjectURL(new Blob([copyText], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = downloadFilename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
</script>

<div
  {...rest}
  role="group"
  aria-label={label ?? 'Payload'}
  data-cinder-state={mode}
  class={classNames('cinder-payload-inspector', className)}
>
  {#if mode === 'none'}
    <p class="cinder-payload-inspector__empty">{emptyLabel}</p>
  {:else}
    <div class="cinder-payload-inspector__header">
      {#if label !== undefined}
        <span class="cinder-payload-inspector__label">{label}</span>
      {/if}
      {#if showSwitch}
        <SegmentedControl
          id={switchId}
          label={`${label ?? 'Payload'} view`}
          labelVisible={false}
          size="sm"
          value={mode === 'invalid' ? 'fields' : view}
          disabled={mode === 'invalid'}
          onValueChange={handleViewChange}
        >
          <Segment value="fields">Fields</Segment>
          <Segment value="json">JSON</Segment>
        </SegmentedControl>
      {/if}
      <div class="cinder-payload-inspector__header-actions">
        {#if countText !== undefined}
          <span class="cinder-payload-inspector__size">{countText}</span>
        {/if}
        {#if truncated}
          <Badge variant="warning" size="xs">Truncated</Badge>
        {/if}
        {#if showCopy}
          <CopyButton
            value={copyText}
            label={copyLabel}
            copiedLabel="Copied"
            title={copyLabel}
            confirmDuration={2000}
            disabled={copyDisabled}
            iconOnly
          >
            {#snippet confirmation()}
              <Check class="cinder-icon-sm" aria-hidden="true" />
              <span class="cinder-payload-inspector__copied">Copied</span>
            {/snippet}
          </CopyButton>
        {/if}
      </div>
    </div>

    <div class="cinder-payload-inspector__panel">
      {#if mode === 'failed'}
        <div class="cinder-payload-inspector__error" role="alert">
          <CircleAlert class="cinder-icon-sm" aria-hidden="true" />
          <span>{failedMessage}</span>
          {#if onRetry !== undefined}
            <Button variant="secondary" size="sm" onclick={onRetry}>Try again</Button>
          {/if}
        </div>
      {:else if mode === 'unserializable'}
        <p class="cinder-payload-inspector__notice">
          This value can't be serialized as JSON (it may contain circular references or BigInt
          values).
        </p>
      {:else if mode === 'oversize' && bytes !== undefined}
        <p class="cinder-payload-inspector__notice">
          This payload is {formatBytes(bytes)}, over the {formatBytes(maxBytes)} shown here. It isn't
          rendered, so the page stays fast.
        </p>
        <div>
          <Button variant="secondary" size="sm" onclick={download}>
            {#snippet leadingIcon()}<Download class="cinder-icon-sm" aria-hidden="true" />{/snippet}
            Download JSON
          </Button>
        </div>
      {:else if mode === 'invalid'}
        <p class="cinder-payload-inspector__warning">
          <TriangleAlert class="cinder-icon-sm" aria-hidden="true" />
          <span>This isn't valid JSON, so it's shown as text.</span>
        </p>
        <CodeBlock code={typeof value === 'string' ? value : ''} wrap />
      {:else if view === 'json'}
        {#if mode === 'streaming'}
          <CodeBlock code={streamingText} wrap />
        {:else}
          <JsonViewer
            value={writeSecretsAsText(shown)}
            {initialDepth}
            {maxDepth}
            {maxBytes}
            largeArrayAbove={LARGE_ARRAY_ABOVE}
            maxKeyLength={40}
            maxStringLength={200}
          />
        {/if}
      {:else if receivingOnly}
        <InlineLoading status="active" description="Receiving…" />
      {:else if isStructured}
        <div
          class="cinder-payload-inspector__field-view"
          data-cinder-tree={fieldsOptions.tree || undefined}
        >
          <PayloadFields
            source={shown}
            path={[]}
            depth={0}
            options={fieldsOptions}
            layout={rootLayout}
            pendingKey={mode === 'streaming' ? partial?.pendingKey : undefined}
          />
        </div>
      {:else}
        <div class="cinder-payload-inspector__primitive">
          <PayloadScalar fieldKey="" value={shown} path={[]} options={fieldsOptions} />
        </div>
      {/if}
    </div>
  {/if}
</div>

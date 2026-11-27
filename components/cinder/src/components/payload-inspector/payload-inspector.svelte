<script lang="ts" module>
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
    jsonOnlyKeysOf,
    LARGE_ARRAY_ABOVE,
    readPartialObject,
    withoutKeys,
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
    labelCode,
    view = $bindable('fields'),
    bare = false,
    plain = false,
    linkFor,
    redact,
    formatValue,
    jsonOnly,
    fieldsValue,
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
  // The card's name: the label, with the name drawn in code after it ("Output, notes").
  const accessibleLabel = $derived(
    label === undefined
      ? 'Payload'
      : labelCode === undefined || labelCode === ''
        ? label
        : `${label}, ${labelCode}`,
  );

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

  type Mode =
    'failed' | 'none' | 'unserializable' | 'oversize' | 'invalid' | 'streaming' | 'text' | 'ready';

  // The card is in exactly one of these states, and each one decides the header and the body, so
  // the order below is the precedence.
  const mode = $derived.by((): Mode => {
    if (failed) return 'failed';
    if (isEmpty) return 'none';
    if (plain && typeof value === 'string' && !streaming) return 'text';
    if (arriving) return 'streaming';
    if (!parseResult.ok) return 'invalid';
    if (unserializable) return 'unserializable';
    if (tooLarge) return 'oversize';
    return 'ready';
  });

  // Copy writes what the card shows. A string payload copies as it came, unless a secret in it was
  // hidden, in which case the hidden copy is written instead so Copy never holds the stored value.
  const copyText = $derived.by((): string => {
    if (mode === 'invalid' || mode === 'text') return typeof value === 'string' ? value : '';
    if (mode !== 'ready' && mode !== 'oversize') return '';
    if (typeof value === 'string' && !containsSecret(shown)) return value;
    return serialized === undefined ? '' : (JSON.stringify(shown, null, 2) ?? '');
  });

  const copyLabel = $derived(
    mode === 'invalid' || mode === 'text' ? 'Copy text' : `Copy ${label ?? 'payload'}`,
  );
  const showCopy = $derived(!bare && mode !== 'none' && mode !== 'unserializable');
  const copyDisabled = $derived(mode === 'failed' || mode === 'streaming');
  const showSwitch = $derived(mode === 'ready' || mode === 'streaming' || mode === 'invalid');

  // What the Fields view lays out and counts: the caller's `fieldsValue` when it gives one (secrets
  // hidden the same way), else the payload itself. The JSON view and Copy keep the stored payload.
  const fieldsSource = $derived(
    fieldsValue === undefined || arriving || mode !== 'ready'
      ? shown
      : maskSecrets(fieldsValue, redact),
  );
  // The top-level fields only the JSON view shows, and the payload the Fields view lays out without them.
  const hiddenFields = $derived(arriving ? [] : jsonOnlyKeysOf(fieldsSource, jsonOnly));
  const fieldsShown = $derived(withoutKeys(fieldsSource, hiddenFields));

  const countText = $derived.by((): string | undefined => {
    if (bare) return undefined;
    if (mode === 'ready') {
      return headerCount(fieldsSource, { bytes, jsonOnly: hiddenFields.length });
    }
    if (mode === 'streaming') return headerCount(shown, { streaming: true });
    if (mode === 'invalid' || mode === 'text') return 'Text';
    if (mode === 'oversize' && bytes !== undefined) return formatBytes(bytes);
    return undefined;
  });

  const fieldsOptions = $derived({
    linkFor,
    formatValue,
    initialDepth,
    maxDepth,
    tree: isTreePayload(fieldsShown),
  });

  // A payload that has said nothing whole yet has no field to list, only the wait.
  const receivingOnly = $derived(
    mode === 'streaming' &&
      (partial === undefined || (partial.entries.length === 0 && partial.pendingKey === undefined)),
  );

  const chosenLayout = $derived.by(() => {
    if (
      typeof fieldsShown !== 'object' ||
      fieldsShown === null ||
      Array.isArray(fieldsShown) ||
      fieldsShown instanceof Date
    ) {
      return 'rows' as const;
    }
    return chooseFieldsLayout(
      Object.entries(fieldsShown).map(([key, entry]) => ({
        key,
        value: entry,
        linked:
          linkFor?.({ path: [key], key, value: entry }) !== undefined &&
          (entry === null || typeof entry !== 'object'),
      })),
      { streaming: arriving },
    );
  });

  // A bare payload is read as a list: one label and value per row, whatever few or many there are.
  const rootLayout = $derived(bare ? ('rows' as const) : chosenLayout);

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

{#snippet viewSwitch()}
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
{/snippet}

<div
  {...rest}
  role="group"
  aria-label={accessibleLabel}
  data-cinder-state={mode}
  data-cinder-bare={bare || undefined}
  class={classNames('cinder-payload-inspector', className)}
>
  {#if mode === 'none'}
    <p class="cinder-payload-inspector__empty">{emptyLabel}</p>
  {:else}
    <div class="cinder-payload-inspector__header">
      <!-- A labelled card sets its count as a muted line under the label, start-aligned, so the
           count never takes a line of its own at the inline end; an unlabelled card keeps it with
           the copy button (COR-2582). -->
      {#if label !== undefined}
        <div class="cinder-payload-inspector__title">
          <!-- The name after the label is set a space apart in the code face and a lighter weight,
               never after a comma (no comma between pieces inside a Cinder component). -->
          <span class="cinder-payload-inspector__label"
            >{label}{#if labelCode !== undefined && labelCode !== ''}{' '}<code
                class="cinder-payload-inspector__label-code">{labelCode}</code
              >{/if}</span
          >
          {#if !bare && countText !== undefined}
            <span class="cinder-payload-inspector__size">{countText}</span>
          {/if}
        </div>
      {/if}
      <!-- A labelled card keeps the switch with Copy at the inline end, one group on the title's
           row, so a narrow card never drops Copy to a line of its own; an unlabelled or bare card
           leads with the switch (27c). -->
      {#if showSwitch && (bare || label === undefined)}
        {@render viewSwitch()}
      {/if}
      {#if !bare}
        <div class="cinder-payload-inspector__header-actions">
          {#if showSwitch && label !== undefined}
            {@render viewSwitch()}
          {/if}
          {#if label === undefined && countText !== undefined}
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
            />
          {/if}
        </div>
      {/if}
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
      {:else if mode === 'text'}
        <CodeBlock code={typeof value === 'string' ? value : ''} wrap />
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
            {...isStructured ? { maxStringLength: 200 } : {}}
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
            source={fieldsShown}
            path={[]}
            depth={0}
            options={fieldsOptions}
            layout={rootLayout}
            pendingKey={mode === 'streaming' ? partial?.pendingKey : undefined}
          />
          {#if hiddenFields.length > 0}
            <p class="cinder-payload-inspector__more">{hiddenFields.length} more in JSON</p>
          {/if}
        </div>
      {:else}
        <div class="cinder-payload-inspector__primitive">
          <PayloadScalar fieldKey="" value={shown} path={[]} options={fieldsOptions} />
        </div>
      {/if}
    </div>
  {/if}
</div>

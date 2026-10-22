<script lang="ts" module>
  export type A2uiNodeProps = {
    /** The component to render. */
    id: string;
    /** The scope relative paths resolve in: `''` at the root, an item's pointer in a template. */
    scope: string;
    /** The ids of the components above this one, to stop a component containing itself. */
    ancestry: readonly string[];
    /** Renders text as inline phrasing (inside a button or a label). */
    inline?: boolean;
    /** Replaces a Button's action, as a Modal does for its trigger. */
    activate?: (() => void) | undefined;
  };
</script>

<script lang="ts">
  import {
    AudioPlayer,
    Button,
    Card,
    Checkbox,
    CheckboxGroup,
    Combobox,
    DatePicker,
    Divider,
    Image,
    Input,
    Modal,
    MultiSelect,
    NumberInput,
    RadioGroup,
    ScrollArea,
    Select,
    Slider,
    Stack,
    Tab,
    TabList,
    TabPanel,
    Tabs,
    Text,
    Textarea,
    TimeField,
    VideoPlayer,
  } from '@lostgradient/cinder';

  import MarkdownPreview from '../components/chat/message/markdown-preview.svelte';
  import A2uiAsset from './a2ui-asset.svelte';
  // A node renders its children as nodes: the recursion is the component tree itself.
  // oxlint-disable-next-line import/no-cycle, import/no-self-import
  import Self from './a2ui-node.svelte';
  import {
    A2UI_ENUM_MAPPINGS,
    choicePickerControl,
    dateTimeControl,
    isBasicComponent,
    mapEnum,
  } from './catalog-mapping.ts';
  import { A2UI_ICONS } from './icon-names.ts';
  import {
    boundPointer,
    elementId,
    evaluationContext,
    expandChildren,
    failingCheck,
    plainText,
    resolveBoolean,
    resolveNumber,
    resolveString,
    resolveStringList,
    runAction,
  } from './node-helpers.ts';
  import { getA2uiRenderContext } from './render-context.ts';
  import type { A2uiComponent, A2uiJsonValue } from './types.ts';

  let { id, scope, ancestry, inline = false, activate }: A2uiNodeProps = $props();

  const context = getA2uiRenderContext();

  const component = $derived(context.component(id));
  const evaluation = $derived(evaluationContext(context, id, scope));
  const lineage = $derived([...ancestry, id]);
  const domId = $derived(elementId(context, id, scope));

  /** Why this node renders nothing, reported once; `undefined` when it renders. */
  const problem = $derived.by((): string | undefined => {
    if (component === undefined) return 'missing';
    if (ancestry.includes(id)) return 'cycle';
    if (!isBasicComponent(component.component)) return 'unsupported';
    return undefined;
  });

  $effect(() => {
    if (problem === 'missing') {
      context.report('missing-component', id, `no component has the id "${id}"`);
    } else if (problem === 'cycle') {
      context.report('component-cycle', id, `"${id}" contains itself`);
    } else if (problem === undefined && component?.component === 'Icon') {
      const name = resolveDynamicProp('name');
      if (typeof name === 'string' && !A2UI_ICONS[name]) {
        context.report('unknown-icon', id, `Cinder has no icon for "${name}"`);
      }
    } else if (problem === 'unsupported' && component !== undefined) {
      context.report(
        'unsupported-component',
        id,
        `"${component.component}" is not in the A2UI basic catalog`,
      );
    }
  });

  function prop(name: string): unknown {
    return component?.[name];
  }

  function report(message: string): void {
    context.report('unsupported-value', id, message);
  }

  function text(name: string): string {
    return resolveString(prop(name), evaluation);
  }

  function resolveDynamicProp(name: string): unknown {
    const value = prop(name);
    const pointer = boundPointer(value, scope);
    return pointer === undefined ? value : context.model.get(pointer);
  }

  // A literal input's own value, once the user has changed it.
  const local = $state<{ value: A2uiJsonValue; touched: boolean }>({ value: null, touched: false });

  /** A bound input's value: the data model's when it is bound, its own once changed otherwise. */
  function read(name: string): unknown {
    if (boundPointer(prop(name), scope) === undefined && local.touched) return local.value;
    return resolveDynamicProp(name);
  }

  /** Writes an input's value: to its bound path at once, or to its own state for a literal. */
  function setLocal(name: string, value: A2uiJsonValue): void {
    const pointer = boundPointer(prop(name), scope);
    if (pointer === undefined) {
      local.value = value;
      local.touched = true;
    } else {
      context.model.set(pointer, value);
    }
  }

  /** `{ [name]: value }`, or nothing when the value is absent (Cinder's props are exact). */
  function optional<T>(name: string, value: T | undefined): Record<string, T> {
    return value === undefined ? {} : { [name]: value };
  }

  const checkMessage = $derived(failingCheck(prop('checks'), evaluation));

  // ── Modal ──
  let modalOpen = $state(false);
  let modalTrigger = $state<HTMLElement | null>(null);
  const triggerComponent = $derived(
    typeof prop('trigger') === 'string' ? context.component(prop('trigger') as string) : undefined,
  );

  /** A Modal's title: the trigger's own text, so the dialog is named after what opened it. */
  function triggerTitle(trigger: A2uiComponent | undefined): string {
    if (trigger === undefined) return 'Dialog';
    if (trigger.component === 'Text') return plainText(resolveString(trigger['text'], evaluation));
    if (trigger.component === 'Button' && typeof trigger['child'] === 'string') {
      return triggerTitle(context.component(trigger['child']));
    }
    return 'Dialog';
  }

  // ── Tabs ──
  let selectedTab = $state('0');

  function openModal(): void {
    modalOpen = true;
  }
</script>

{#snippet child(childId: unknown, childScope: string = scope, childInline = false)}
  {#if typeof childId === 'string'}
    <Self id={childId} scope={childScope} ancestry={lineage} inline={childInline} />
  {/if}
{/snippet}

{#snippet children(list: unknown)}
  {#each expandChildren(list, scope, context) as entry (entry.key)}
    <Self id={entry.id} scope={entry.scope} ancestry={lineage} />
  {/each}
{/snippet}

{#if component !== undefined && problem === undefined}
  {@const type = component.component}
  <svelte:element
    this={inline ? 'span' : 'div'}
    class="a2ui-node"
    data-a2ui-component={type}
    data-a2ui-id={id}
  >
    {#if type === 'Text'}
      {@const variant = mapEnum(
        A2UI_ENUM_MAPPINGS.Text.variant,
        'Text.variant',
        prop('variant'),
        report,
      )}
      {@const content = text('text')}
      {#if inline}
        <span class="a2ui-inline-text">{plainText(content)}</span>
      {:else if variant === 'body' || variant === 'caption'}
        <Text {variant} as="div" class="a2ui-text"><MarkdownPreview {content} /></Text>
      {:else}
        <Text {variant} class="a2ui-text">{plainText(content)}</Text>
      {/if}
    {:else if type === 'Image'}
      <A2uiAsset url={text('url')} componentId={id}>
        {#snippet children(src)}
          <Image
            {src}
            alt={text('description')}
            fit={mapEnum(A2UI_ENUM_MAPPINGS.Image.fit, 'Image.fit', prop('fit'), report)}
            size={mapEnum(
              A2UI_ENUM_MAPPINGS.Image.variant,
              'Image.variant',
              prop('variant'),
              report,
            )}
            class="a2ui-leaf"
          />
        {/snippet}
      </A2uiAsset>
    {:else if type === 'Icon'}
      {@const name = resolveDynamicProp('name')}
      {#if typeof name === 'object' && name !== null && typeof (name as { svgPath?: unknown }).svgPath === 'string'}
        <svg class="a2ui-icon" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
          <path d={(name as { svgPath: string }).svgPath} />
        </svg>
      {:else}
        {@const Icon = typeof name === 'string' ? A2UI_ICONS[name] : undefined}
        {#if Icon}
          <Icon class="a2ui-icon" size={24} aria-hidden="true" />
        {/if}
      {/if}
    {:else if type === 'Video'}
      <A2uiAsset url={text('url')} componentId={id}>
        {#snippet children(src)}
          <VideoPlayer {src} label="Video" class="a2ui-leaf" />
        {/snippet}
      </A2uiAsset>
    {:else if type === 'AudioPlayer'}
      <A2uiAsset url={text('url')} componentId={id}>
        {#snippet children(src)}
          <AudioPlayer {src} label={text('description') || 'Audio'} class="a2ui-leaf" />
        {/snippet}
      </A2uiAsset>
    {:else if type === 'Row' || type === 'Column'}
      <Stack
        direction={type === 'Row' ? 'row' : 'column'}
        justify={mapEnum(
          A2UI_ENUM_MAPPINGS[type].justify,
          `${type}.justify`,
          prop('justify'),
          report,
        )}
        align={mapEnum(A2UI_ENUM_MAPPINGS[type].align, `${type}.align`, prop('align'), report)}
        gap="0"
        class="a2ui-container"
      >
        {@render children(prop('children'))}
      </Stack>
    {:else if type === 'List'}
      {@const direction = mapEnum(
        A2UI_ENUM_MAPPINGS.List.direction,
        'List.direction',
        prop('direction'),
        report,
      )}
      <ScrollArea {direction} class="a2ui-container">
        <Stack
          direction={direction === 'horizontal' ? 'row' : 'column'}
          align={mapEnum(A2UI_ENUM_MAPPINGS.List.align, 'List.align', prop('align'), report)}
          gap="0"
        >
          {@render children(prop('children'))}
        </Stack>
      </ScrollArea>
    {:else if type === 'Card'}
      <Card class="a2ui-leaf">{@render child(prop('child'))}</Card>
    {:else if type === 'Tabs'}
      {@const tabs = Array.isArray(prop('tabs'))
        ? (prop('tabs') as { title?: unknown; child?: unknown }[])
        : []}
      <Tabs bind:value={selectedTab} class="a2ui-leaf">
        <TabList>
          {#each tabs as tab, index (index)}
            <Tab value={String(index)}>{plainText(resolveString(tab.title, evaluation))}</Tab>
          {/each}
        </TabList>
        {#each tabs as tab, index (index)}
          <TabPanel value={String(index)}>{@render child(tab.child)}</TabPanel>
        {/each}
      </Tabs>
    {:else if type === 'Divider'}
      <Divider
        orientation={mapEnum(A2UI_ENUM_MAPPINGS.Divider.axis, 'Divider.axis', prop('axis'), report)}
      />
    {:else if type === 'Modal'}
      <span bind:this={modalTrigger} class="a2ui-modal-trigger">
        {#if triggerComponent?.component === 'Button'}
          <Self id={triggerComponent.id} {scope} ancestry={lineage} activate={openModal} />
        {:else}
          <Button variant="secondary" onclick={openModal} class="a2ui-leaf">
            {@render child(prop('trigger'), scope, true)}
          </Button>
        {/if}
      </span>
      <Modal bind:open={modalOpen} title={triggerTitle(triggerComponent)} triggerRef={modalTrigger}>
        {@render child(prop('content'))}
      </Modal>
    {:else if type === 'Button'}
      <Button
        variant={mapEnum(
          A2UI_ENUM_MAPPINGS.Button.variant,
          'Button.variant',
          prop('variant'),
          report,
        )}
        disabled={activate === undefined && checkMessage !== undefined}
        title={checkMessage}
        class="a2ui-leaf"
        onclick={() => {
          if (activate !== undefined) activate();
          else runAction(prop('action'), component, context, evaluation);
        }}
      >
        {@render child(prop('child'), scope, true)}
      </Button>
    {:else if type === 'TextField'}
      {@const control = mapEnum(
        A2UI_ENUM_MAPPINGS.TextField.variant,
        'TextField.variant',
        prop('variant'),
        report,
      )}
      {@const value = read('value')}
      {@const pattern =
        typeof prop('validationRegexp') === 'string'
          ? (prop('validationRegexp') as string)
          : undefined}
      {@const patternError =
        pattern !== undefined &&
        typeof value === 'string' &&
        value !== '' &&
        !new RegExp(pattern).test(value)
          ? 'The value is not in the expected format.'
          : undefined}
      {@const error = checkMessage ?? patternError}
      {#if control === 'textarea'}
        <Textarea
          id={domId}
          label={text('label')}
          value={typeof value === 'string' ? value : ''}
          {...optional('error', error)}
          class="a2ui-leaf"
          oninput={(event: Event) =>
            setLocal('value', (event.currentTarget as HTMLTextAreaElement).value)}
        />
      {:else if control === 'number-input'}
        <NumberInput
          id={domId}
          label={text('label')}
          value={typeof value === 'number' ? value : (resolveNumber(value, evaluation) ?? null)}
          {...optional('error', error)}
          class="a2ui-leaf"
          onValueChange={(next: number | null) => setLocal('value', next)}
        />
      {:else}
        <Input
          id={domId}
          type={control === 'password' ? 'password' : 'text'}
          label={text('label')}
          value={typeof value === 'string' ? value : ''}
          {...optional('error', error)}
          class="a2ui-leaf"
          onValueChange={(next: string) => setLocal('value', next)}
        />
      {/if}
    {:else if type === 'CheckBox'}
      <Checkbox
        id={domId}
        label={text('label')}
        checked={read('value') === true}
        {...optional('error', checkMessage)}
        class="a2ui-leaf"
        onValueChange={(next: boolean) => setLocal('value', next)}
      />
    {:else if type === 'ChoicePicker'}
      {@const options = Array.isArray(prop('options'))
        ? (prop('options') as { label?: unknown; value?: unknown }[])
            .filter((option) => typeof option.value === 'string')
            .map((option) => ({
              value: option.value as string,
              label: plainText(resolveString(option.label, evaluation)),
            }))
        : []}
      {@const selected = resolveStringList(read('value'), evaluation)}
      {@const control = choicePickerControl(
        mapEnum(
          A2UI_ENUM_MAPPINGS.ChoicePicker.variant,
          'ChoicePicker.variant',
          prop('variant'),
          report,
        ),
        mapEnum(
          A2UI_ENUM_MAPPINGS.ChoicePicker.displayStyle,
          'ChoicePicker.displayStyle',
          prop('displayStyle'),
          report,
        ),
        resolveBoolean(prop('filterable'), evaluation),
      )}
      {@const label = text('label')}
      {#if control === 'checkbox-group'}
        <CheckboxGroup {label} {...optional('error', checkMessage)} class="a2ui-leaf">
          {#each options as option (option.value)}
            <Checkbox
              id={`${domId}-${option.value}`}
              label={option.label}
              checked={selected.includes(option.value)}
              onValueChange={(next: boolean) =>
                setLocal(
                  'value',
                  next
                    ? [...selected, option.value]
                    : selected.filter((entry) => entry !== option.value),
                )}
            />
          {/each}
        </CheckboxGroup>
      {:else if control === 'multi-select'}
        <MultiSelect
          id={domId}
          {label}
          items={options.map((option) => ({ id: option.value, label: option.label }))}
          bind:selectedIds={() => selected, (next) => setLocal('value', [...next])}
          filterable={resolveBoolean(prop('filterable'), evaluation)}
          {...optional('error', checkMessage)}
          class="a2ui-leaf"
        />
      {:else if control === 'radio-group'}
        <RadioGroup
          name={domId}
          {label}
          bind:value={() => selected[0] ?? '', (next) => setLocal('value', [next])}
          {...optional('error', checkMessage)}
          class="a2ui-leaf"
        >
          {#each options as option (option.value)}
            <RadioGroup.Option
              id={`${domId}-${option.value}`}
              value={option.value}
              label={option.label}
            />
          {/each}
        </RadioGroup>
      {:else if control === 'combobox'}
        <Combobox
          id={domId}
          {label}
          {options}
          bind:value={
            () => selected[0] ?? '', (next) => setLocal('value', next === '' ? [] : [next])
          }
          {...optional('error', checkMessage)}
          class="a2ui-leaf"
        />
      {:else}
        <Select
          id={domId}
          {label}
          {options}
          bind:value={
            () => selected[0] ?? '', (next) => setLocal('value', next === '' ? [] : [next])
          }
          {...optional('error', checkMessage)}
          class="a2ui-leaf"
        />
      {/if}
    {:else if type === 'Slider'}
      <Slider
        label={text('label') || 'Value'}
        min={resolveNumber(prop('min'), evaluation) ?? 0}
        max={resolveNumber(prop('max'), evaluation) ?? 100}
        bind:value={
          () =>
            resolveNumber(read('value'), evaluation) ?? resolveNumber(prop('min'), evaluation) ?? 0,
          (next) => setLocal('value', next)
        }
        class="a2ui-leaf"
      />
    {:else if type === 'DateTimeInput'}
      {@const kind = dateTimeControl(
        resolveBoolean(prop('enableDate'), evaluation),
        resolveBoolean(prop('enableTime'), evaluation),
      )}
      {@const value = read('value')}
      {#if kind.control === 'time-field'}
        <TimeField
          id={domId}
          label={text('label')}
          bind:value={
            () => (typeof value === 'string' ? value : ''), (next) => setLocal('value', next)
          }
          {...optional('error', checkMessage)}
          class="a2ui-leaf"
        />
      {:else}
        <DatePicker
          id={domId}
          label={text('label')}
          granularity={kind.granularity}
          {...optional('min', text('min') || undefined)}
          {...optional('max', text('max') || undefined)}
          bind:value={
            () => (typeof value === 'string' && value !== '' ? value : undefined),
            (next) => setLocal('value', next ?? '')
          }
          {...optional('error', checkMessage)}
          class="a2ui-leaf"
        />
      {/if}
    {/if}
  </svelte:element>
{/if}

<style>
  /* Leaf-margin spacing (the basic catalog's guide): containers add no space,
     and every visible leaf carries the same margin. */
  :global(.a2ui-leaf),
  :global(.a2ui-text) {
    margin: var(--cinder-space-2);
  }

  :global(.a2ui-icon) {
    inline-size: 1.5rem;
    block-size: 1.5rem;
    margin: var(--cinder-space-2);
    color: currentcolor;
  }

  .a2ui-node,
  .a2ui-modal-trigger {
    display: contents;
  }
</style>

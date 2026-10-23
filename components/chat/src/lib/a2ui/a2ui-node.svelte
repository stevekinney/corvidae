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
    activate?: ((event: MouseEvent) => void) | undefined;
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
    FormField,
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

  import { untrack } from 'svelte';

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
  import { resolveDynamic } from './functions.ts';
  import { A2UI_ICONS } from './icon-names.ts';
  import {
    boundPointer,
    elementId,
    evaluationContext,
    expandChildren,
    dateTimeForControl,
    failingCheck,
    iconLabel,
    matchesPattern,
    plainText,
    resolveBoolean,
    resolveNumber,
    resolveString,
    resolveStringList,
    runAction,
    sliderStep,
    timeOutOfRange,
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
      if (typeof name === 'string' && !(Object.hasOwn(A2UI_ICONS, name) && A2UI_ICONS[name])) {
        context.report('unknown-icon', id, `Cinder has no icon for "${name}"`);
      }
    } else if (
      problem === undefined &&
      component?.component === 'DateTimeInput' &&
      dateTimeControl(
        resolveBoolean(prop('enableDate'), evaluation),
        resolveBoolean(prop('enableTime'), evaluation),
      ).control === 'none'
    ) {
      report('a DateTimeInput enables neither a date nor a time, so it renders no control');
    } else if (
      problem === undefined &&
      component?.component === 'TextField' &&
      typeof prop('validationRegexp') === 'string' &&
      matchesPattern(prop('validationRegexp') as string, '') === undefined
    ) {
      // RE2 runs neither an invalid pattern nor backreferences or lookaround,
      // so the field is not checked against it; say so rather than pass silently.
      report(
        'validationRegexp is not a valid pattern, or needs backreferences or lookaround, which do not run; the field is not checked against it',
      );
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
    return pointer === undefined ? resolveDynamic(value, evaluation) : context.model.get(pointer);
  }

  // A literal input's own value, once the user has changed it.
  const local = $state<{ value: A2uiJsonValue; touched: boolean }>({ value: null, touched: false });

  // A new value from the server (an `updateComponents` that changes it) replaces the user's edit.
  $effect.pre(() => {
    void JSON.stringify(component?.['value'] ?? null);
    untrack(() => {
      local.touched = false;
    });
  });

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

  // ── Accessibility (ComponentCommon.accessibility) ──
  /** An `accessibility` field as text, or `undefined` when it is absent or empty. */
  function accessibilityText(name: 'label' | 'description'): string | undefined {
    const accessibility = prop('accessibility');
    if (typeof accessibility !== 'object' || accessibility === null) return undefined;
    const value = plainText(resolveString(Reflect.get(accessibility, name), evaluation));
    return value === '' ? undefined : value;
  }

  /** The explicit accessible name, which wins over any name inferred from content. */
  const accessibleName = $derived(accessibilityText('label'));
  const accessibleDescription = $derived(accessibilityText('description'));
  const descriptionId = $derived(elementId(context, id, scope, 'description'));
  /** Points a control at its explicit description, when it has one. */
  const describedBy = $derived(
    optional('aria-describedby', accessibleDescription === undefined ? undefined : descriptionId),
  );

  /** A control's name: its visible label, else its explicit name, else a fallback. */
  function nameOr(visible: string, fallback: string): string {
    return visible || accessibleName || fallback;
  }

  // ── Modal ──
  let modalOpen = $state(false);
  let modalTrigger = $state<HTMLElement | null>(null);
  const triggerComponent = $derived(
    typeof prop('trigger') === 'string' ? context.component(prop('trigger') as string) : undefined,
  );

  /**
   * What a Modal's trigger is called, or `''`: its explicit name, else its own
   * text, image description, or icon name (a Button's, its child's). Both the
   * dialog's title and the name of the button a trigger is wrapped in come from
   * here, each with its own fallback, so neither is ever empty.
   */
  function triggerName(trigger: A2uiComponent | undefined, seen: readonly string[] = []): string {
    if (trigger === undefined || seen.includes(trigger.id)) return '';
    const accessibility = trigger['accessibility'];
    const explicit =
      typeof accessibility === 'object' && accessibility !== null
        ? plainText(resolveString(Reflect.get(accessibility, 'label'), evaluation)).trim()
        : '';
    if (explicit !== '') return explicit;
    switch (trigger.component) {
      case 'Text':
        return plainText(resolveString(trigger['text'], evaluation)).trim();
      case 'Image':
        return plainText(resolveString(trigger['description'], evaluation)).trim();
      case 'Icon':
        return iconButtonLabel(trigger.id) ?? '';
      case 'Button':
        return triggerName(
          typeof trigger['child'] === 'string' ? context.component(trigger['child']) : undefined,
          [...seen, trigger.id],
        );
      default:
        return '';
    }
  }

  const INTERACTIVE_COMPONENTS: ReadonlySet<string> = new Set([
    'Button',
    'TextField',
    'CheckBox',
    'ChoicePicker',
    'Slider',
    'DateTimeInput',
    'Modal',
    'Tabs',
    // Both players render their own play and seek controls.
    'AudioPlayer',
    'Video',
  ]);

  /** Whether `childId`'s subtree holds a control, reported once when it does. */
  function holdsInteractive(childId: unknown, seen: readonly string[] = []): boolean {
    if (typeof childId !== 'string' || seen.includes(childId)) return false;
    const node = context.component(childId);
    if (node === undefined) return false;
    if (INTERACTIVE_COMPONENTS.has(node.component)) {
      report(`a Button's child holds the interactive "${node.component}" "${node.id}"`);
      return true;
    }
    const nested = [...seen, childId];
    const children = node['children'];
    const ids = Array.isArray(children)
      ? children
      : typeof children === 'object' && children !== null
        ? [Reflect.get(children, 'componentId')]
        : [];
    return [node['child'], ...ids].some((descendant) => holdsInteractive(descendant, nested));
  }

  /** An icon-only Button's name: its icon's name in words, since the icon itself is hidden. */
  function iconButtonLabel(childId: unknown = prop('child')): string | undefined {
    const childComponent = typeof childId === 'string' ? context.component(childId) : undefined;
    if (childComponent?.component !== 'Icon') return undefined;
    const name = resolveDynamic(childComponent['name'], evaluation);
    return typeof name === 'string' ? iconLabel(name) : 'Icon';
  }

  /** A Row or Column child's relative weight, when it gives one. */
  const weight = $derived(
    typeof component?.['weight'] === 'number' && component['weight'] >= 0
      ? component['weight']
      : undefined,
  );

  /** A DateTimeInput's name when the surface gives it no label. */
  function dateTimeLabel(
    kind: Exclude<ReturnType<typeof dateTimeControl>, { control: 'none' }>,
  ): string {
    if (kind.control === 'time-field') return 'Time';
    return kind.granularity === 'day' ? 'Date' : 'Date and time';
  }

  /**
   * A ChoicePicker's options, each value once: a repeated value would give two
   * controls one key and one id, so the first wins and the rest are reported.
   * A single-choice control also skips an empty value, which it reads as no selection.
   */
  function choiceOptions(raw: unknown, single: boolean): { value: string; label: string }[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const options: { value: string; label: string }[] = [];
    for (const entry of raw as unknown[]) {
      if (typeof entry !== 'object' || entry === null) {
        report('a ChoicePicker option is not an object; it is skipped');
        continue;
      }
      const option = entry as { label?: unknown; value?: unknown };
      if (typeof option.value !== 'string') continue;
      if (single && option.value === '') {
        // Cinder's single-choice controls use `''` for no selection, so none could pick it.
        report('a ChoicePicker option has an empty value; it is skipped');
        continue;
      }
      if (seen.has(option.value)) {
        report(`ChoicePicker option "${option.value}" is listed more than once; the first is kept`);
        continue;
      }
      seen.add(option.value);
      options.push({
        value: option.value,
        label: plainText(resolveString(option.label, evaluation)),
      });
    }
    return options;
  }

  // ── Tabs ──
  let selectedTab = $state('0');
  /** The child of the tab the user selected, to follow it when an update moves it. */
  let selectedChild: unknown;
  const tabs = $derived(
    component?.component === 'Tabs' && Array.isArray(prop('tabs'))
      ? (prop('tabs') as unknown[]).filter(
          (tab): tab is { title?: unknown; child?: unknown } =>
            typeof tab === 'object' && tab !== null,
        )
      : [],
  );

  // A server update that moves the selected tab keeps it selected; one that
  // removes it leaves the first selected.
  $effect.pre(() => {
    const current = tabs[Number(selectedTab)];
    if (current !== undefined && (selectedChild === undefined || current.child === selectedChild)) {
      selectedChild = current.child;
      return;
    }
    const moved = tabs.findIndex((tab) => tab.child === selectedChild);
    const next = moved === -1 ? 0 : moved;
    selectedTab = String(next);
    selectedChild = tabs[next]?.child;
  });

  function selectTab(next: string): void {
    selectedTab = next;
    selectedChild = tabs[Number(next)]?.child;
  }

  // ── Number TextField ──
  /**
   * The number a focused number field shows. Cinder's NumberInput replaces the
   * text being typed whenever its value changes, so while the user types into a
   * field that writes its model on each keystroke, the field keeps the value it
   * had when focused; the commit on blur brings it back in step. A host update
   * (a new model generation) ends the hold, so the server's value shows and wins.
   */
  let heldNumber = $state<{ value: number | null; generation: number } | undefined>(undefined);

  /** Writes a number field's model as the user types, not only when they commit. */
  function writeWhileTyping(input: HTMLInputElement): () => void {
    const hold = () => {
      const current = read('value');
      heldNumber = {
        value: typeof current === 'number' ? current : (resolveNumber(current, evaluation) ?? null),
        generation: context.model.generation,
      };
    };
    // `focusout` follows `blur`, so the field's own commit on blur runs first.
    const release = () => {
      heldNumber = undefined;
    };
    // A TextField's value is text, so the model holds what is typed, in the
    // field's own locale (`1,5`); the commit on blur writes the canonical number.
    const write = () => setLocal('value', input.value.trim());
    input.addEventListener('focus', hold);
    input.addEventListener('focusout', release);
    input.addEventListener('input', write);
    return () => {
      input.removeEventListener('focus', hold);
      input.removeEventListener('focusout', release);
      input.removeEventListener('input', write);
      // Removing a focused input need not emit `focusout`, so the hold ends here too.
      release();
    };
  }

  /** Opens the dialog, remembering the control that opened it so focus can return there. */
  function openModal(event: MouseEvent): void {
    modalTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
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
    class:a2ui-node--weighted={weight !== undefined}
    style={weight === undefined ? undefined : `flex: ${weight} 1 0%;`}
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
        <Text {variant} as="div" class="a2ui-text"
          ><MarkdownPreview {content} images={false} links={false} /></Text
        >
      {:else}
        <Text {variant} class="a2ui-text">{plainText(content)}</Text>
      {/if}
    {:else if type === 'Image'}
      <A2uiAsset url={text('url')} componentId={id}>
        {#snippet children(src)}
          <Image
            {src}
            alt={accessibleName ?? text('description')}
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
        <svg
          class="a2ui-icon"
          viewBox="0 0 24 24"
          fill="currentColor"
          {...accessibleName === undefined
            ? { 'aria-hidden': 'true' }
            : { role: 'img', 'aria-label': accessibleName }}
        >
          <path d={(name as { svgPath: string }).svgPath} />
        </svg>
      {:else}
        {@const Icon =
          typeof name === 'string' && Object.hasOwn(A2UI_ICONS, name)
            ? A2UI_ICONS[name]
            : undefined}
        {#if Icon}
          {#if accessibleName === undefined}
            <Icon class="a2ui-icon" size={24} aria-hidden="true" />
          {:else}
            <span role="img" aria-label={accessibleName}>
              <Icon class="a2ui-icon" size={24} aria-hidden="true" />
            </span>
          {/if}
        {/if}
      {/if}
    {:else if type === 'Video'}
      <A2uiAsset url={text('url')} componentId={id}>
        {#snippet children(src)}
          <VideoPlayer {src} label={accessibleName ?? 'Video'} class="a2ui-leaf" />
        {/snippet}
      </A2uiAsset>
    {:else if type === 'AudioPlayer'}
      <A2uiAsset url={text('url')} componentId={id}>
        {#snippet children(src)}
          <AudioPlayer
            {src}
            label={accessibleName ?? (text('description') || 'Audio')}
            class="a2ui-leaf"
          />
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
      <Tabs bind:value={() => selectedTab, selectTab} class="a2ui-leaf">
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
      <span class="a2ui-modal-trigger">
        {#if triggerComponent?.component === 'Button'}
          <Self id={triggerComponent.id} {scope} ancestry={lineage} activate={openModal} />
        {:else if triggerComponent !== undefined && ['Text', 'Icon', 'Image'].includes(triggerComponent.component)}
          <!-- A non-interactive trigger is wrapped in a button so it can be reached and pressed. -->
          <Button
            variant="secondary"
            onclick={openModal}
            class="a2ui-leaf"
            aria-label={triggerName(triggerComponent) || 'Open dialog'}
          >
            {@render child(prop('trigger'), scope, true)}
          </Button>
        {:else}
          <!-- An interactive or container trigger is not nested inside a button: it
               renders as itself, and a button beside it opens the dialog. -->
          {@render child(prop('trigger'))}
          <Button variant="secondary" onclick={openModal} class="a2ui-leaf">Open</Button>
        {/if}
      </span>
      <Modal
        bind:open={modalOpen}
        title={accessibleName ?? (triggerName(triggerComponent) || 'Dialog')}
        triggerRef={modalTrigger}
        {...optional(
          'describedById',
          accessibleDescription === undefined ? undefined : descriptionId,
        )}
      >
        {@render child(prop('content'))}
      </Modal>
    {:else if type === 'Button' && holdsInteractive(prop('child'))}
      <!-- A control inside a button would be pressed through it, dispatching both
           actions, so the child renders on its own and the Button is dropped. -->
      {@render child(prop('child'))}
      {#if activate !== undefined}
        <!-- As a Modal's trigger, the dropped Button still leaves a way to open the dialog. -->
        <Button
          variant="secondary"
          disabled={checkMessage !== undefined}
          title={checkMessage}
          onclick={activate}
          class="a2ui-leaf">Open</Button
        >
      {/if}
    {:else if type === 'Button'}
      <Button
        variant={mapEnum(
          A2UI_ENUM_MAPPINGS.Button.variant,
          'Button.variant',
          prop('variant'),
          report,
        )}
        disabled={checkMessage !== undefined}
        title={checkMessage}
        {...optional('aria-label', accessibleName ?? iconButtonLabel())}
        {...describedBy}
        class="a2ui-leaf"
        onclick={(event: MouseEvent) => {
          if (activate !== undefined) activate(event);
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
        pattern !== undefined && typeof value === 'string' && value !== ''
          ? matchesPattern(pattern, value) === false
            ? 'The value is not in the expected format.'
            : undefined
          : undefined}
      {@const error = checkMessage ?? patternError}
      {#if control === 'textarea'}
        <Textarea
          id={domId}
          label={nameOr(text('label'), 'Text')}
          {...describedBy}
          value={typeof value === 'string' ? value : ''}
          {...optional('error', error)}
          class="a2ui-leaf"
          oninput={(event: Event) =>
            setLocal('value', (event.currentTarget as HTMLTextAreaElement).value)}
        />
      {:else if control === 'number-input'}
        <NumberInput
          id={domId}
          label={nameOr(text('label'), 'Number')}
          {...describedBy}
          value={heldNumber === undefined || heldNumber.generation !== context.model.generation
            ? typeof value === 'number'
              ? value
              : (resolveNumber(value, evaluation) ?? null)
            : heldNumber.value}
          {...optional('error', error)}
          class="a2ui-leaf"
          inputAttachment={writeWhileTyping}
          onValueChange={(next: number | null) =>
            setLocal('value', next === null ? '' : String(next))}
        />
      {:else}
        <Input
          id={domId}
          type={control === 'password' ? 'password' : 'text'}
          label={nameOr(text('label'), 'Text')}
          {...describedBy}
          value={typeof value === 'string' ? value : ''}
          {...optional('error', error)}
          class="a2ui-leaf"
          onValueChange={(next: string) => setLocal('value', next)}
        />
      {/if}
    {:else if type === 'CheckBox'}
      <Checkbox
        id={domId}
        label={nameOr(text('label'), 'Checkbox')}
        {...describedBy}
        checked={read('value') === true}
        {...optional('error', checkMessage)}
        class="a2ui-leaf"
        onValueChange={(next: boolean) => setLocal('value', next)}
      />
    {:else if type === 'ChoicePicker'}
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
      {@const options = choiceOptions(
        prop('options'),
        control !== 'checkbox-group' && control !== 'multi-select',
      )}
      {@const label = nameOr(text('label'), 'Options')}
      {#if control === 'checkbox-group'}
        <CheckboxGroup
          {label}
          {...optional('error', checkMessage)}
          {...describedBy}
          class="a2ui-leaf"
        >
          {#each options as option (option.value)}
            <Checkbox
              id={elementId(context, id, scope, option.value)}
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
          {...describedBy}
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
          {...optional('description', accessibleDescription)}
          bind:value={() => selected[0] ?? '', (next) => setLocal('value', [next])}
          {...optional('error', checkMessage)}
          class="a2ui-leaf"
        >
          {#each options as option (option.value)}
            <RadioGroup.Option
              id={elementId(context, id, scope, option.value)}
              value={option.value}
              label={option.label}
            />
          {/each}
        </RadioGroup>
      {:else if control === 'combobox'}
        <Combobox
          id={domId}
          {label}
          {...describedBy}
          {options}
          bind:value={
            () => selected[0] ?? '', (next) => setLocal('value', next === '' ? [] : [next])
          }
          {...optional('error', checkMessage)}
          class="a2ui-leaf"
        />
      {:else}
        <!-- Select documents `undefined` as nothing selected, though its exact
             optional type does not admit it; `''` would make it warn instead. -->
        <Select
          id={domId}
          {label}
          {...describedBy}
          {options}
          bind:value={
            () => selected[0] as string,
            (next) => setLocal('value', next === undefined ? [] : [next])
          }
          {...optional('error', checkMessage)}
          class="a2ui-leaf"
        />
      {/if}
    {:else if type === 'Slider'}
      {@const min = resolveNumber(prop('min'), evaluation) ?? 0}
      {@const max = resolveNumber(prop('max'), evaluation) ?? 100}
      {@const label = nameOr(text('label'), 'Value')}
      <!-- Slider has no error of its own; a FormField carries its failing check,
           marking it invalid and describing it with the message. -->
      <FormField id={domId} {label} {...optional('error', checkMessage)} class="a2ui-leaf">
        <Slider
          {label}
          {min}
          {max}
          step={sliderStep(min, max)}
          bind:value={
            () =>
              resolveNumber(read('value'), evaluation) ??
              resolveNumber(prop('min'), evaluation) ??
              0,
            (next) => setLocal('value', next)
          }
        />
      </FormField>
    {:else if type === 'DateTimeInput'}
      {@const kind = dateTimeControl(
        resolveBoolean(prop('enableDate'), evaluation),
        resolveBoolean(prop('enableTime'), evaluation),
      )}
      {@const value = read('value')}
      {#if kind.control === 'time-field'}
        <TimeField
          id={domId}
          label={nameOr(text('label'), dateTimeLabel(kind))}
          {...describedBy}
          bind:value={
            () => dateTimeForControl(value, 'time', context.timeZone) ?? '',
            (next) => setLocal('value', next)
          }
          {...optional(
            'error',
            checkMessage ??
              (timeOutOfRange(value, text('min'), text('max'), context.timeZone)
                ? 'The time is outside the allowed range.'
                : undefined),
          )}
          class="a2ui-leaf"
        />
      {:else if kind.control === 'date-picker'}
        <DatePicker
          id={domId}
          label={nameOr(text('label'), dateTimeLabel(kind))}
          {...describedBy}
          granularity={kind.granularity}
          {...optional('min', dateTimeForControl(text('min'), kind.granularity, context.timeZone))}
          {...optional('max', dateTimeForControl(text('max'), kind.granularity, context.timeZone))}
          bind:value={
            () => dateTimeForControl(value, kind.granularity, context.timeZone),
            (next) => {
              if (next !== dateTimeForControl(value, kind.granularity, context.timeZone))
                setLocal('value', next ?? '');
            }
          }
          {...optional('error', checkMessage)}
          class="a2ui-leaf"
        />
      {/if}
    {/if}
  </svelte:element>
  {#if accessibleDescription !== undefined}
    <span id={descriptionId} hidden>{accessibleDescription}</span>
  {/if}
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

  /* A weighted child of a Row or Column needs a box of its own to grow. */
  .a2ui-node.a2ui-node--weighted {
    display: block;
    min-inline-size: 0;
  }
</style>

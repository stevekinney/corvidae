<script lang="ts" module>
  import type { JsonSchemaValue } from './json-schema-editor-types.ts';
  import type { EnumDraft } from './enum-editor.svelte';

  export type PropertyListProps = {
    idPrefix: string;
    properties: Record<string, JsonSchemaValue>;
    required: string[];
    path: string;
    depth?: number;
    readonly?: boolean;
    enumDrafts?: Record<string, Record<number, EnumDraft>>;
    historyRevision?: number;
    /** The owning property's key, when this list renders a nested object's properties. Used to give the nested table a distinguishing accessible name. */
    parentKey?: string | undefined;
    onvalidationErrorcount?: ((count: number) => void) | undefined;
    onEnumDraftsChange?: ((next: Record<string, Record<number, EnumDraft>>) => void) | undefined;
    onValueChange: (properties: Record<string, JsonSchemaValue>, required: string[]) => void;
    /**
     * Whether the list offers required names with no field of their own. The fields form leaves it
     * out: there, Required is the table's own column and nothing else (row 65s).
     */
    requiredOnlyVisible?: boolean;
  };
</script>

<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { ArrowDown, ArrowUp } from '../icons/index.ts';
  import { onDestroy, tick } from 'svelte';
  import { classNames } from '../../utilities/class-names.ts';
  import Alert from '../alert/alert.svelte';
  import Button from '../button/button.svelte';
  import Checkbox from '../checkbox/checkbox.svelte';
  import Chip from '../chip/chip.svelte';
  import { default as Badge } from '../badge/index.ts';
  import { default as Collapsible } from '../collapsible/index.ts';
  import { default as Dropdown } from '../dropdown/index.ts';
  import { default as Table } from '../table/index.ts';
  import Input from '../input/input.svelte';
  import PropertyEditor from './property-editor.svelte';
  import { calculatePropertyValidationErrorCount } from './property-list-validation.ts';

  let {
    idPrefix,
    properties,
    required,
    path,
    depth = 0,
    readonly = false,
    enumDrafts = {},
    historyRevision = 0,
    parentKey,
    onvalidationErrorcount,
    onEnumDraftsChange,
    onValueChange,
    requiredOnlyVisible = true,
  }: PropertyListProps = $props();

  const propertyNames = $derived(Object.keys(properties));
  const requiredOnly = $derived(required.filter((name) => !propertyNames.includes(name)));

  // Per-row draft names so a partial typed name doesn't reshape the parent.
  let draftNames = $state<Record<string, string>>({});
  let renameError = $state<string | null>(null);
  let expanded = $state<Record<string, boolean>>({});
  let childValidationCounts = $state<Record<string, number>>({});

  const validationErrorCount = $derived(
    calculatePropertyValidationErrorCount(
      propertyNames,
      childValidationCounts,
      renameError !== null,
    ),
  );

  function retainedDraftCount(key: string): number {
    const propertyPrefix = `${path}/${pointerSegment(key)}`;
    return Object.entries(enumDrafts)
      .filter(
        ([draftPath]) => draftPath === propertyPrefix || draftPath.startsWith(`${propertyPrefix}/`),
      )
      .reduce((count, [, drafts]) => count + Object.keys(drafts).length, 0);
  }

  $effect(() => {
    onvalidationErrorcount?.(validationErrorCount);
  });

  onDestroy(() => {
    onvalidationErrorcount?.(0);
  });

  function getDraftName(key: string): string {
    return draftNames[key] ?? key;
  }

  function pointerSegment(value: string): string {
    return value.replaceAll('~', '~0').replaceAll('/', '~1');
  }

  function rebaseEnumDrafts(oldKey: string, newKey: string): void {
    const oldPrefix = `${path}/${pointerSegment(oldKey)}`;
    const newPrefix = `${path}/${pointerSegment(newKey)}`;
    const next = Object.fromEntries(
      Object.entries(enumDrafts).map(([draftPath, draft]) => [
        draftPath === oldPrefix || draftPath.startsWith(`${oldPrefix}/`)
          ? `${newPrefix}${draftPath.slice(oldPrefix.length)}`
          : draftPath,
        draft,
      ]),
    );
    onEnumDraftsChange?.(next);
  }

  function uniqueNewKey(): string {
    let suffix = 1;
    let candidate = 'newField';
    while (Object.prototype.hasOwnProperty.call(properties, candidate)) {
      suffix += 1;
      candidate = `newField${suffix}`;
    }
    return candidate;
  }

  function commitRename(oldKey: string) {
    if (readonly) return;
    const draft = getDraftName(oldKey).trim();
    if (!draft) {
      renameError = 'Property name cannot be empty';
      return;
    }
    if (draft === oldKey) {
      renameError = null;
      return;
    }
    if (Object.prototype.hasOwnProperty.call(properties, draft)) {
      renameError = `Duplicate property name: ${draft}`;
      return;
    }
    renameError = null;
    rebaseEnumDrafts(oldKey, draft);

    // Object.fromEntries uses CreateDataPropertyOrThrow, which — unlike a plain
    // assignment loop — defines an own data property even when a key is
    // literally "__proto__" (it never triggers the Object.prototype.__proto__
    // accessor). That keeps a schema with a real `__proto__` property key
    // intact WITHOUT resorting to Object.create(null), whose null-prototype
    // result is not structured-cloneable — the undo-history snapshot commit
    // uses structuredClone, which previously threw and silently dropped every
    // rename.
    const next: Record<string, JsonSchemaValue> = Object.fromEntries(
      propertyNames.map((k) => [k === oldKey ? draft : k, properties[k]!]),
    );
    const nextRequired = required.map((name) => (name === oldKey ? draft : name));

    delete draftNames[oldKey];
    if (expanded[oldKey]) {
      expanded[draft] = true;
      delete expanded[oldKey];
    }
    const childCount = childValidationCounts[oldKey];
    if (childCount !== undefined) {
      const { [oldKey]: _removedChildCount, ...remainingChildCounts } = childValidationCounts;
      childValidationCounts = { ...remainingChildCounts, [draft]: childCount };
    }
    onValueChange(next, nextRequired);
  }

  let actionAnnouncement = $state('');
  const propertyTriggerElements = new Map<string, HTMLButtonElement>();
  let addPropertyElement: HTMLSpanElement | undefined = $state();

  function propertyTrigger(element: HTMLButtonElement, key: string) {
    propertyTriggerElements.set(key, element);
    return {
      update(nextKey: string) {
        if (nextKey === key) return;
        propertyTriggerElements.delete(key);
        key = nextKey;
        propertyTriggerElements.set(key, element);
      },
      destroy() {
        propertyTriggerElements.delete(key);
      },
    };
  }

  async function announceAction(message: string) {
    actionAnnouncement = '';
    await tick();
    actionAnnouncement = message;
  }

  async function deleteProperty(key: string, index: number) {
    if (readonly) return;
    const focusKey = propertyNames[index + 1] ?? propertyNames[index - 1];
    const next = { ...properties };
    delete next[key];
    const nextRequired = required.filter((name) => name !== key);
    delete draftNames[key];
    delete expanded[key];
    const propertyPrefix = `${path}/${pointerSegment(key)}`;
    onEnumDraftsChange?.(
      Object.fromEntries(
        Object.entries(enumDrafts).filter(
          ([draftPath]) =>
            draftPath !== propertyPrefix && !draftPath.startsWith(`${propertyPrefix}/`),
        ),
      ),
    );
    const { [key]: _removedChildCount, ...remainingChildCounts } = childValidationCounts;
    childValidationCounts = remainingChildCounts;
    onValueChange(next, nextRequired);
    await announceAction(`Deleted ${key} property.`);
    await tick();
    const focusTarget = focusKey
      ? propertyTriggerElements.get(focusKey)
      : addPropertyElement?.querySelector<HTMLButtonElement>('button');
    focusTarget?.focus();
  }

  function setChildValidationErrorCount(key: string, count: number): void {
    if ((childValidationCounts[key] ?? 0) === count) return;
    if (count === 0) {
      const { [key]: _removedChildCount, ...remainingChildCounts } = childValidationCounts;
      childValidationCounts = remainingChildCounts;
      return;
    }
    childValidationCounts = { ...childValidationCounts, [key]: count };
  }

  function toggleExpanded(key: string, isOpen: boolean): void {
    expanded[key] = !isOpen;
    if (isOpen) setChildValidationErrorCount(key, 0);
  }

  async function moveProperty(key: string, direction: -1 | 1, index: number) {
    if (readonly || !canMoveProperty(index, direction)) return;
    const target = index + direction;
    if (target < 0 || target >= propertyNames.length) return;

    const reordered = [...propertyNames];
    [reordered[index], reordered[target]] = [reordered[target]!, reordered[index]!];
    // See the matching comment in commitRename: Object.fromEntries keeps a
    // literal "__proto__" key intact as a real own property without
    // producing a null-prototype object structuredClone can't clone.
    const next: Record<string, JsonSchemaValue> = Object.fromEntries(
      reordered.map((name) => [name, properties[name]!]),
    );
    onValueChange(next, required);
    await announceAction(`Moved ${key} property to position ${target + 1} of ${reordered.length}.`);
  }

  function canMoveProperty(index: number, direction: -1 | 1): boolean {
    const target = index + direction;
    if (target < 0 || target >= propertyNames.length) return false;
    const reordered = [...propertyNames];
    [reordered[index], reordered[target]] = [reordered[target]!, reordered[index]!];
    const next: Record<string, JsonSchemaValue> = Object.fromEntries(
      reordered.map((name) => [name, properties[name]!]),
    );
    return Object.keys(next).every((name, nextIndex) => name === reordered[nextIndex]);
  }

  function setRequired(key: string, isRequired: boolean) {
    if (readonly) return;
    const set = new Set(required);
    if (isRequired) set.add(key);
    else set.delete(key);
    onValueChange(properties, [...set]);
  }

  function setPropertySchema(key: string, schema: JsonSchemaValue) {
    if (readonly) return;
    onValueChange({ ...properties, [key]: schema }, required);
  }

  function addProperty() {
    if (readonly) return;
    const key = uniqueNewKey();
    onValueChange({ ...properties, [key]: { type: 'string' } }, required);
    expanded[key] = true;
  }

  /** A JSON Schema type in the words a person reads in the Type column: "Text", "Date", "Number". */
  const TYPE_WORDS: Readonly<Record<string, string>> = {
    string: 'Text',
    number: 'Number',
    integer: 'Whole number',
    boolean: 'Yes or no',
    object: 'Object',
    array: 'List',
    null: 'Nothing',
  };

  /** The formats of a string a person names by what it holds. */
  const FORMAT_WORDS: Readonly<Record<string, string>> = {
    date: 'Date',
    'date-time': 'Date and time',
    time: 'Time',
    email: 'Email address',
    uri: 'Link',
  };

  function typeWord(type: string): string {
    return Object.hasOwn(TYPE_WORDS, type) ? (TYPE_WORDS[type] ?? type) : type;
  }

  function summariseType(schema: JsonSchemaValue): string {
    if (typeof schema === 'boolean') return schema ? 'Any value' : 'No value';
    const t = schema.type;
    if (t === undefined && Array.isArray(schema.enum)) return 'Choice';
    const format = typeof schema.format === 'string' ? schema.format : undefined;
    if (t === 'string' && format !== undefined && Object.hasOwn(FORMAT_WORDS, format)) {
      return FORMAT_WORDS[format] ?? 'Text';
    }
    if (t === 'string' && Array.isArray(schema.enum)) return 'Choice';
    const base =
      t === undefined ? 'Any value' : Array.isArray(t) ? t.map(typeWord).join(' or ') : typeWord(t);
    // "of <items>" only makes sense when the schema is exclusively an array —
    // a multi-type schema like ['array', 'null'] isn't only an array, so
    // items don't describe every value it can hold.
    const isExclusivelyArray = Array.isArray(t)
      ? t.length === 1 && t[0] === 'array'
      : t === 'array';
    if (isExclusivelyArray) {
      return `${base} of ${summariseType(schema.items ?? {}).toLocaleLowerCase()}`;
    }
    return base;
  }

  // ===== Required-only chip editing =====
  let newRequiredOnlyName = $state('');

  function addRequiredOnly() {
    if (readonly) return;
    const name = newRequiredOnlyName.trim();
    if (!name) {
      newRequiredOnlyName = '';
      return;
    }
    if (required.includes(name)) {
      newRequiredOnlyName = '';
      return;
    }
    onValueChange(properties, [...required, name]);
    newRequiredOnlyName = '';
  }

  function removeRequiredOnly(name: string) {
    if (readonly) return;
    onValueChange(
      properties,
      required.filter((entry) => entry !== name),
    );
  }
</script>

<p class="cinder-sr-only" aria-live="polite">{actionAnnouncement}</p>

{#if renameError}
  <Alert variant="danger">{renameError}</Alert>
{/if}

<div class="cinder-jse-property-list">
  {#if propertyNames.length === 0}
    <p class="cinder-jse-property-list__empty">No properties yet.</p>
  {:else}
    <Table
      class="cinder-jse-property-table"
      aria-label={parentKey ? `Properties of ${parentKey}` : 'Schema properties'}
    >
      <Table.Header class={classNames(depth > 0 && 'cinder-sr-only')}>
        <Table.Row>
          <Table.HeaderCell>Field</Table.HeaderCell>
          <Table.HeaderCell class="cinder-jse-property-table__type-heading">Type</Table.HeaderCell>
          <Table.HeaderCell class="cinder-jse-property-table__description-heading"
            >Description</Table.HeaderCell
          >
          <Table.HeaderCell class="cinder-jse-property-table__required-heading"
            >Required</Table.HeaderCell
          >
          <Table.HeaderCell class="cinder-jse-property-table__actions-heading"
            ><span class="cinder-sr-only">Actions</span></Table.HeaderCell
          >
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each propertyNames as key, index (key)}
          {@const isRequired = required.includes(key)}
          {@const isOpen = expanded[key] === true}
          {@const childValidationErrorCount = Math.max(
            childValidationCounts[key] ?? 0,
            retainedDraftCount(key),
          )}
          {@const panelId = `${idPrefix}-${key}-panel`}
          {@const propertySchema = properties[key] ?? {}}
          {@const description =
            typeof propertySchema === 'object' ? (propertySchema.description ?? '') : ''}
          <Table.Row
            class="cinder-jse-property-row"
            data-cinder-required={isRequired ? '' : undefined}
            data-cinder-invalid={childValidationErrorCount > 0 ? '' : undefined}
          >
            <Table.Cell
              as="th"
              class="cinder-jse-property-row__key"
              style={`--cinder-jse-property-depth: ${depth}`}
            >
              <button
                use:propertyTrigger={key}
                type="button"
                class="cinder-jse-property-row__trigger"
                aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${key} property${childValidationErrorCount > 0 ? `, ${childValidationErrorCount} validation ${childValidationErrorCount === 1 ? 'error' : 'errors'}` : ''}`}
                aria-expanded={isOpen}
                aria-controls={isOpen ? panelId : undefined}
                onclick={() => toggleExpanded(key, isOpen)}
              >
                <ChevronDown
                  class="cinder-jse-property-row__chevron"
                  size={14}
                  strokeWidth={2}
                  aria-hidden="true"
                />
                <span class="cinder-jse-property-row__name">{key}</span>
                {#if childValidationErrorCount > 0}
                  <Badge
                    variant="danger"
                    aria-label={`${childValidationErrorCount} validation ${childValidationErrorCount === 1 ? 'error' : 'errors'} in ${key}`}
                  >
                    {childValidationErrorCount}{' '}
                    {childValidationErrorCount === 1 ? 'error' : 'errors'}
                  </Badge>
                {/if}
              </button>
              <!-- In a narrow container the type and the description read under the field's name,
                   where their own columns have no room (row 65s). -->
              <span class="cinder-jse-property-row__key-meta">
                <span class="cinder-jse-property-row__key-type"
                  >{summariseType(propertySchema)}</span
                >
                {#if description !== ''}
                  <span class="cinder-jse-property-row__key-description">{description}</span>
                {/if}
              </span>
            </Table.Cell>
            <Table.Cell class="cinder-jse-property-row__type">
              {summariseType(propertySchema)}
            </Table.Cell>
            <Table.Cell class="cinder-jse-property-row__description">
              {description}
            </Table.Cell>
            <!-- Whether the field is required is its own column, under its own heading (row 65s). -->
            <Table.Cell class="cinder-jse-property-row__required">
              <Checkbox
                checked={isRequired}
                disabled={readonly}
                aria-label={key}
                onValueChange={(next) => setRequired(key, next)}
              />
            </Table.Cell>
            <Table.Cell class="cinder-jse-property-row__actions">
              <!-- A row keeps its own actions inside its box: wide, the icon buttons a sortable
                   list's rows use (arrows to move, a trash can to delete); in a narrow container
                   one icon menu that holds them (row 65s). The table never scrolls sideways to
                   reach them. -->
              <span class="cinder-jse-property-row__inline-actions">
                <Button
                  iconOnly
                  variant="secondary"
                  size="sm"
                  disabled={readonly || !canMoveProperty(index, -1)}
                  aria-label={`Move ${key} up`}
                  onclick={() => moveProperty(key, -1, index)}
                >
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button
                  iconOnly
                  variant="secondary"
                  size="sm"
                  disabled={readonly || !canMoveProperty(index, 1)}
                  aria-label={`Move ${key} down`}
                  onclick={() => moveProperty(key, 1, index)}
                >
                  <ArrowDown aria-hidden="true" />
                </Button>
                <Button
                  iconOnly
                  variant="ghost"
                  size="sm"
                  disabled={readonly}
                  aria-label={`Delete ${key}`}
                  onclick={() => deleteProperty(key, index)}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </span>
              <span class="cinder-jse-property-row__menu">
                <Dropdown id={`${idPrefix}-${key}-actions`} placement="bottom-end">
                  <Dropdown.Trigger caretVisible={false} variant="ghost" size="xs">
                    <Ellipsis aria-hidden="true" size={16} />
                    <span class="cinder-sr-only">{`Actions for ${key}`}</span>
                  </Dropdown.Trigger>
                  <Dropdown.Menu>
                    <Dropdown.Item
                      disabled={readonly || !canMoveProperty(index, -1)}
                      onclick={() => moveProperty(key, -1, index)}
                    >
                      <ArrowUp aria-hidden="true" size={14} />
                      Move up
                    </Dropdown.Item>
                    <Dropdown.Item
                      disabled={readonly || !canMoveProperty(index, 1)}
                      onclick={() => moveProperty(key, 1, index)}
                    >
                      <ArrowDown aria-hidden="true" size={14} />
                      Move down
                    </Dropdown.Item>
                    <Dropdown.Item
                      variant="danger"
                      disabled={readonly}
                      onclick={() => deleteProperty(key, index)}
                    >
                      <Trash2 aria-hidden="true" size={14} />
                      Delete
                    </Dropdown.Item>
                  </Dropdown.Menu>
                </Dropdown>
              </span>
            </Table.Cell>
          </Table.Row>

          {#if isOpen}
            <Table.Row class="cinder-jse-property-row__detail-row">
              <Table.Cell
                id={panelId}
                colspan={5}
                class="cinder-jse-property-row__detail-cell"
                style={`--cinder-jse-property-depth: ${depth}`}
              >
                <Input
                  id={`${idPrefix}-${key}-name`}
                  label="Name"
                  value={getDraftName(key)}
                  disabled={readonly}
                  variant="code"
                  oninput={(event: Event) =>
                    (draftNames[key] = (event.target as HTMLInputElement).value)}
                  onblur={() => commitRename(key)}
                />
                <PropertyEditor
                  idPrefix={`${idPrefix}-${key}-schema`}
                  path={`${path}/${pointerSegment(key)}`}
                  depth={depth + 1}
                  propertyKey={key}
                  {readonly}
                  {enumDrafts}
                  {historyRevision}
                  value={properties[key] ?? {}}
                  onvalidationErrorcount={(count) => setChildValidationErrorCount(key, count)}
                  {onEnumDraftsChange}
                  onValueChange={(next) => setPropertySchema(key, next)}
                />
              </Table.Cell>
            </Table.Row>
          {/if}
        {/each}
      </Table.Body>
    </Table>
  {/if}

  <span class="cinder-jse-property-list__add-property-reference" bind:this={addPropertyElement}>
    <!-- Compact, with a leading plus, as every "Add a …" button on a builder page (row 65s). -->
    <Button variant="secondary" size="sm" disabled={readonly} onclick={addProperty}>
      {#snippet leadingIcon()}<Plus aria-hidden="true" />{/snippet}
      Add a field
    </Button>
  </span>

  {#if requiredOnlyVisible && (!readonly || requiredOnly.length > 0)}
    <Collapsible
      class="cinder-jse-required-only"
      trigger={`Required fields not yet defined (${requiredOnly.length})`}
      open={!readonly || requiredOnly.length > 0}
    >
      <div class="cinder-jse-required-only__panel">
        {#each requiredOnly as name (name)}
          <Chip
            mode="removable"
            label={name}
            disabled={readonly}
            onRemove={() => removeRequiredOnly(name)}
          />
        {/each}
        <Input
          id={`${idPrefix}-required-only-add`}
          label="Add required name"
          value={newRequiredOnlyName}
          disabled={readonly}
          oninput={(event: Event) =>
            (newRequiredOnlyName = (event.target as HTMLInputElement).value)}
          onkeydown={(event: KeyboardEvent) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addRequiredOnly();
            }
          }}
        />
        <Button variant="secondary" size="sm" disabled={readonly} onclick={addRequiredOnly}>
          Add required name
        </Button>
      </div>
    </Collapsible>
  {/if}
</div>

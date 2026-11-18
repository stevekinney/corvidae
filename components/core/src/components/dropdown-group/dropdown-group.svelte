<script lang="ts" module>
  export type { DropdownGroupProps } from './dropdown-group.types.ts';
</script>

<script lang="ts">
  import type { DropdownGroupProps } from './dropdown-group.types.ts';

  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';

  let {
    class: customClassName,
    children,
    label,
    ariaLabelledby,
    ...rest
  }: DropdownGroupProps = $props();

  function normalizeAccessibleName(
    value: string | undefined,
    propertyName: 'label' | 'ariaLabelledby',
  ): string | undefined {
    if (value === undefined) return undefined;
    const trimmedValue = value.trim();
    if (trimmedValue.length === 0) {
      throw new Error(`DropdownGroup requires a non-empty ${propertyName} value.`);
    }
    return trimmedValue;
  }

  // Resolve and validate the accessible name at render time so all three
  // invariants — non-empty label, non-empty ariaLabelledby, and exactly one of
  // the two — are enforced in a single place on both server and client, rather
  // than splitting the exclusivity check into a post-paint, SSR-skipped $effect.
  const resolvedAccessibleName = $derived.by(() => {
    const trimmedLabel = normalizeAccessibleName(label, 'label');
    const trimmedLabelledBy = normalizeAccessibleName(ariaLabelledby, 'ariaLabelledby');

    const namedByLabel = trimmedLabel !== undefined;
    const namedByReference = trimmedLabelledBy !== undefined;

    if (namedByLabel === namedByReference) {
      throw new Error(
        'DropdownGroup requires exactly one accessible naming strategy: label or ariaLabelledby.',
      );
    }

    return { label: trimmedLabel, ariaLabelledby: trimmedLabelledBy };
  });
</script>

<div
  {...rest}
  class={classNames('cinder-dropdown-group', customClassName)}
  role="group"
  aria-label={resolvedAccessibleName.label}
  aria-labelledby={resolvedAccessibleName.ariaLabelledby}
>
  {#if children}
    {@render children()}
  {/if}
</div>

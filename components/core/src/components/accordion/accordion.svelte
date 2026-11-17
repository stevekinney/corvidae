<script lang="ts" module>
  export type { AccordionContext, AccordionProps } from './accordion.types.ts';
</script>

<script lang="ts">
  import { createMultiSelection } from '@lostgradient/foundation/_internal/collection.ts';
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import { setAccordionContext } from './accordion.context.ts';
  import type { AccordionProps } from './accordion.types.ts';

  let {
    multiple = false,
    expandedIds = $bindable([]),
    class: className,
    children,
  }: AccordionProps = $props();

  // Multi-mode delegates to the shared collection helper; single-mode keeps the
  // "open one at a time" invariant local. Both update `expandedIds` in place so
  // the bindable parent prop sees the change.
  const multi = createMultiSelection<string>(
    () => expandedIds,
    (next) => {
      expandedIds = next;
    },
  );

  function toggle(id: string): void {
    if (multiple) {
      multi.toggle(id);
    } else {
      expandedIds = expandedIds.includes(id) ? [] : [id];
    }
  }

  setAccordionContext({
    get expandedIds() {
      return expandedIds;
    },
    toggle,
  });
</script>

<div class={classNames('cinder-accordion', className)}>
  {@render children()}
</div>

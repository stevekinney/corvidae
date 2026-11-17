<script lang="ts" module>
  export type {
    AccessGateLayout,
    AccessGateProps,
    AccessGateVariant,
  } from './access-gate.types.ts';
</script>

<script lang="ts">
  import { Lock } from '@lucide/svelte';

  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';

  import AccessGateInline from './access-gate-inline.svelte';
  import type { AccessGateProps } from './access-gate.types.ts';

  let {
    granted,
    variant = 'inline',
    reason,
    requirement,
    title = 'Section locked',
    headingLevel = 3,
    layout = 'inline',
    children,
    actions,
    class: customClassName,
    ...rest
  }: AccessGateProps = $props();

  const baseId = $props.id();
  const sectionTitleId = `${baseId}-title`;
  const sectionReasonId = `${baseId}-description`;
  const sectionRequirementId = `${baseId}-requirement`;
  const sectionDescriptionIds = $derived(
    requirement ? `${sectionReasonId} ${sectionRequirementId}` : sectionReasonId,
  );
  // Coerce + clamp at runtime: <h0>/<hNaN> is invalid markup however the prop was typed.
  const safeLevel = $derived(
    Number.isFinite(Math.trunc(Number(headingLevel)))
      ? Math.min(6, Math.max(1, Math.trunc(Number(headingLevel))))
      : 3,
  );
  const headingTag = $derived(`h${safeLevel}`);
  const passthroughAttributes = $derived(
    stripOwnedAccessibilityAttributes(rest as Record<string, unknown>),
  );

  function stripOwnedAccessibilityAttributes(
    attributes: Record<string, unknown>,
  ): Record<string, unknown> {
    const {
      role: _role,
      ['aria-describedby']: _ariaDescribedBy,
      ['aria-labelledby']: _ariaLabelledBy,
      ...passthrough
    } = attributes;
    return passthrough;
  }
</script>

{#if granted}
  <span
    {...passthroughAttributes}
    class="cinder-access-gate__passthrough"
    data-cinder-variant={variant}
  >
    {@render children?.()}
  </span>
{:else if variant === 'section'}
  <section
    {...passthroughAttributes}
    class={classNames('cinder-access-gate', customClassName)}
    data-cinder-variant="section"
    data-cinder-layout={layout === 'page' ? 'page' : 'inline'}
    aria-labelledby={sectionTitleId}
    aria-describedby={sectionDescriptionIds}
  >
    <span class="cinder-access-gate__section-icon" aria-hidden="true">
      <Lock />
    </span>
    <svelte:element
      this={headingTag}
      id={sectionTitleId}
      class="cinder-access-gate__section-title cinder-_label-text"
    >
      {title}
    </svelte:element>
    <p id={sectionReasonId} class="cinder-access-gate__section-reason cinder-_value-text">
      {reason}
    </p>
    {#if requirement}
      <p id={sectionRequirementId} class="cinder-access-gate__requirement">
        <code class="cinder-access-gate__requirement-value">requires {requirement}</code>
      </p>
    {/if}
    {#if actions}
      <div class="cinder-access-gate__actions">
        {@render actions()}
      </div>
    {/if}
  </section>
{:else}
  <AccessGateInline {...passthroughAttributes} class={customClassName} {reason}>
    {@render children?.()}
  </AccessGateInline>
{/if}

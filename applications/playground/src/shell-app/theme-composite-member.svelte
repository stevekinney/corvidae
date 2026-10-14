<script lang="ts">
  /*
   * One member of a composite (COR-488). The field it renders is the one the foundation and
   * color editors already use for that kind of value: the numeric field for dimensions,
   * durations and numbers, the font stack, the cubic-bezier field, and the color text and
   * channel fields. A member that is a reference shows the reference and keeps it; it becomes
   * a literal only through that member's own "Replace with literal" button.
   */
  import { Button, Checkbox, Input } from '@lostgradient/cinder';

  import type { CatalogueRow } from './theme-builder-catalogue.ts';
  import ThemeColorChannels from './theme-color-channels.svelte';
  import { authoredText, parseColorText, type DtcgColor } from './theme-color-model.ts';
  import type { Member, MemberSpec } from './theme-composite-values.ts';
  import ThemeFoundationBezierField from './theme-foundation-bezier-field.svelte';
  import ThemeFoundationFontStack from './theme-foundation-font-stack.svelte';
  import ThemeFoundationScalarField from './theme-foundation-scalar-field.svelte';
  import type { FieldErrors, FoundationFields } from './theme-foundation-values.ts';

  type Props = {
    spec: MemberSpec;
    member: Member;
    /** The error key of this member, for example `layers.1.blur`. */
    at: string;
    errors: FieldErrors;
    idBase: string;
    /** Names every field: the token, the layer, the member and the scope. */
    subject: string;
    disabled: boolean;
    onchange: (next: Member) => void;
    onreplace: () => void;
    announce: (message: string) => void;
    onenter: () => void;
  };
  let {
    spec,
    member,
    at,
    errors,
    idBase,
    subject,
    disabled,
    onchange,
    onreplace,
    announce,
    onenter,
  }: Props = $props();

  // The numeric field reads only the usage limit and kind of a row; a member supplies both.
  const shim = $derived({ type: spec.kind, profile: spec.profile } as unknown as CatalogueRow);
  const label = (part: string): string => `${subject} ${part}`;
  const problem = (key: string = at): FieldErrors => {
    const message = errors[key];
    return message === undefined ? {} : { amount: message, x1: message, families: message };
  };
  const parsedColor = $derived(member.kind === 'color' ? parseColorText(member.text) : null);
  const colorError = $derived(
    errors[at] ?? (parsedColor?.ok === false ? parsedColor.message : undefined),
  );
  const bezierPoints = $derived(
    member.kind === 'bezier' && member.fields.kind === 'cubicBezier'
      ? member.fields.points.map(Number)
      : null,
  );

  const scalar = (next: FoundationFields): void => onchange({ kind: 'scalar', fields: next });
  const noGesture = { begin: () => undefined, end: () => undefined };
</script>

<div class="member" data-member={spec.key}>
  {#if member.kind === 'ref'}
    <p class="member__reference">
      <span class="member__name">{spec.label}</span>
      is a reference:
      <code>{typeof member.value === 'string' ? member.value : JSON.stringify(member.value)}</code>
    </p>
    <Button
      label="Replace with literal"
      aria-label={`Replace ${subject} reference with a literal`}
      variant="secondary"
      size="sm"
      {disabled}
      onclick={onreplace}
    />
  {:else if member.kind === 'opaque'}
    <p class="member__reference">
      <span class="member__name">{spec.label}</span>
      is preserved as written; this editor does not read its shape:
      <code>{JSON.stringify(member.value)}</code>
    </p>
  {:else if member.kind === 'scalar' && (member.fields.kind === 'dimension' || member.fields.kind === 'duration' || member.fields.kind === 'number' || member.fields.kind === 'fontWeight')}
    <ThemeFoundationScalarField
      row={shim}
      fields={member.fields}
      errors={problem()}
      {idBase}
      {label}
      {disabled}
      onchange={scalar}
      onslide={(amount) => scalar({ ...member.fields, amount } as FoundationFields)}
      ongesture={noGesture}
      {onenter}
    />
  {:else if member.kind === 'family' && member.fields.kind === 'fontFamily'}
    <ThemeFoundationFontStack
      fields={member.fields}
      errors={errors[at] === undefined ? {} : { families: errors[at] }}
      {idBase}
      {label}
      {disabled}
      onchange={(next) => onchange({ kind: 'family', fields: next })}
      {announce}
      {onenter}
    />
  {:else if member.kind === 'bezier' && member.fields.kind === 'cubicBezier'}
    <ThemeFoundationBezierField
      fields={member.fields}
      errors={errors[at] === undefined ? {} : { x1: errors[at] }}
      {idBase}
      {label}
      {disabled}
      committed={bezierPoints}
      onchange={(next) => onchange({ kind: 'bezier', fields: next })}
      {onenter}
    />
  {:else if member.kind === 'color'}
    <Input
      id={`${idBase}-text`}
      label={label('color')}
      description="A literal color in the space you type it in, for example oklch(0.5 0.22 270)."
      autocomplete="off"
      spellcheck={false}
      {disabled}
      value={member.text}
      {...colorError === undefined ? {} : { error: colorError }}
      onValueChange={(text) => onchange({ ...member, text })}
    />
    {#if parsedColor?.ok === true}
      <ThemeColorChannels
        color={parsedColor.color}
        shipped={null}
        {subject}
        idPrefix={idBase}
        onChange={(color: DtcgColor) => onchange({ ...member, text: authoredText(color) })}
      />
    {/if}
  {:else if member.kind === 'boolean' || member.kind === 'absent'}
    <Checkbox
      id={`${idBase}-flag`}
      label={subject}
      checked={member.kind === 'boolean' && member.value}
      {disabled}
      onValueChange={(checked) =>
        onchange(checked ? { kind: 'boolean', value: true } : { kind: 'absent' })}
    />
  {/if}
</div>

<style>
  .member {
    display: grid;
    gap: 8px;
    min-width: 0;
  }
  .member__reference {
    margin: 0;
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }
  .member__name {
    font-weight: var(--cinder-font-semibold);
  }
  code {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
  }
</style>

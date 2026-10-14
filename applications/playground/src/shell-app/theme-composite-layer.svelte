<script lang="ts">
  /*
   * The members of one composite object (COR-488): a whole border, transition or typography,
   * or one shadow layer or gradient stop. Each member is its own labeled field group, so the
   * names carry the token, the layer and the scope, and an error sits beside the member that
   * caused it.
   */
  import ThemeCompositeMember from './theme-composite-member.svelte';
  import ThemeCompositeStroke from './theme-composite-stroke.svelte';
  import type { Layer, Member, MemberSpec } from './theme-composite-values.ts';
  import type { FieldErrors } from './theme-foundation-values.ts';

  type Props = {
    specs: readonly MemberSpec[];
    layer: Layer;
    /** The error-key prefix of this layer, for example `layers.1.` or empty. */
    at: string;
    errors: FieldErrors;
    idBase: string;
    subject: string;
    disabled: boolean;
    onchange: (next: Layer) => void;
    literalFor: (member: Member, spec: MemberSpec) => Member;
    announce: (message: string) => void;
    onenter: () => void;
  };
  let { specs, layer, at, errors, idBase, subject, disabled, onchange, literalFor, announce, onenter }: Props =
    $props();

  const set = (key: string, member: Member): void =>
    onchange({ ...layer, members: { ...layer.members, [key]: member } });
</script>

{#each specs as spec (spec.key)}
  {@const member = layer.members[spec.key] ?? { kind: 'absent' as const }}
  {@const name = `${subject} ${spec.label.toLowerCase()}`}
  <div class="layer__member" role="group" aria-label={name}>
    {#if member.kind === 'stroke'}
      <ThemeCompositeStroke
        stroke={member.stroke}
        at={`${at}${spec.key}`}
        {errors}
        idBase={`${idBase}-${spec.key}`}
        subject={name}
        {disabled}
        onchange={(stroke) => set(spec.key, { kind: 'stroke', stroke })}
        literalFor={(entry) => literalFor(entry, spec)}
        {announce}
        {onenter}
      />
    {:else}
      <ThemeCompositeMember
        {spec}
        {member}
        at={`${at}${spec.key}`}
        {errors}
        idBase={`${idBase}-${spec.key}`}
        subject={name}
        {disabled}
        onchange={(next) => set(spec.key, next)}
        onreplace={() => set(spec.key, literalFor(member, spec))}
        {announce}
        {onenter}
      />
    {/if}
  </div>
{/each}

<style>
  .layer__member {
    display: grid;
    gap: 8px;
    min-width: 0;
  }
</style>

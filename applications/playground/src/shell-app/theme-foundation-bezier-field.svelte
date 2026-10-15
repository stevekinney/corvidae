<script lang="ts">
  /*
   * The cubic-bezier editor (COR-489): four numeric inputs, with the x control points held to
   * [0, 1] as CSS requires, and a small curve. The curve draws the last-valid value, so a
   * half-typed number never moves it.
   */
  import { Input } from '@lostgradient/cinder';

  import {
    BEZIER_PARTS,
    type FieldErrors,
    type FoundationFields,
  } from './theme-foundation-values.ts';

  type Bezier = Extract<FoundationFields, { kind: 'cubicBezier' }>;

  type Props = {
    fields: Bezier;
    errors: FieldErrors;
    idBase: string;
    label: (part: string) => string;
    disabled: boolean;
    committed: readonly number[] | null;
    onchange: (next: Bezier) => void;
    onenter: () => void;
  };
  let { fields, errors, idBase, label, disabled, committed, onchange, onenter }: Props = $props();

  const SIZE = 80;
  const PAD = 10;
  const x = (value: number) => PAD + value * (SIZE - PAD * 2);
  const y = (value: number) => SIZE - PAD - value * (SIZE - PAD * 2);

  const path = $derived.by(() => {
    if (committed === null || committed.length !== 4) return '';
    const [x1, y1, x2, y2] = committed as [number, number, number, number];
    return `M ${x(0)} ${y(0)} C ${x(x1)} ${y(y1)}, ${x(x2)} ${y(y2)}, ${x(1)} ${y(1)}`;
  });

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      onenter();
    }
  }

  function edit(index: number, text: string): void {
    const points = [...fields.points] as Bezier['points'];
    points[index] = text;
    onchange({ ...fields, points });
  }
</script>

<div class="bezier" role="group" aria-label={label('control points')}>
  <div class="bezier__inputs" onkeydown={keydown} role="presentation">
    {#each BEZIER_PARTS as part, index (part)}
      <Input
        id={`${idBase}-${part}`}
        label={label(part)}
        inputmode="decimal"
        autocomplete="off"
        spellcheck={false}
        {disabled}
        {...part === 'x1' || part === 'x2' ? { description: 'Between 0 and 1.' } : {}}
        {...errors[part] === undefined ? {} : { error: errors[part] }}
        value={fields.points[index] ?? ''}
        onValueChange={(text) => edit(index, text)}
      />
    {/each}
  </div>
  <svg
    class="bezier__curve"
    viewBox={`0 0 ${SIZE} ${SIZE}`}
    role="img"
    aria-label={committed === null
      ? 'No curve'
      : `Curve for control points ${committed.join(', ')}`}
    data-testid="bezier-curve"
  >
    <rect
      x={PAD}
      y={PAD}
      width={SIZE - PAD * 2}
      height={SIZE - PAD * 2}
      fill="none"
      stroke="currentColor"
      stroke-opacity="0.25"
    />
    <path d={path} fill="none" stroke="currentColor" stroke-width="2" />
  </svg>
</div>

<style>
  .bezier {
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  .bezier__inputs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .bezier__curve {
    width: 120px;
    height: 120px;
    color: var(--cinder-text-default);
  }
</style>

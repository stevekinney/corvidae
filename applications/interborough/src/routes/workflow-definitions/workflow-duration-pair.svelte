<script lang="ts">
  /**
   * A length of time as a number and a unit, which a wait's "For" and "Unit" and a wait's limit
   * ("Stop waiting after") both use, so the two read and write one way. The number writes as the
   * person types, so the footer's sentence follows each digit. Cinder's `DurationField` is the same
   * control for a stored number of milliseconds; it commits a number when the field is left, and
   * this one writes the file's own `15m`, so the builder cannot use it.
   */
  import { Input, Select } from '@lostgradient/cinder';

  import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
  import { WAIT_UNITS, type WaitUnit } from './workflow-builder-model.ts';

  interface Props {
    /** The id of the number; the unit's is `unitId`. */
    amountId: string;
    unitId: string;
    /** The number as typed, or `''` while it is empty. */
    amount: string;
    unit: WaitUnit;
    /** The number's visible label, and its accessible name, which says which step it is in. */
    amountLabel: string;
    amountName: string;
    /** The unit's visible label, and its accessible name. */
    unitLabel: string;
    unitName: string;
    required?: boolean;
    /** The number's problem, when it has one. */
    error?: { error?: string };
    onChange: (amount: string, unit: WaitUnit) => void;
  }

  let {
    amountId,
    unitId,
    amount,
    unit,
    amountLabel,
    amountName,
    unitLabel,
    unitName,
    required = false,
    error = {},
    onChange,
  }: Props = $props();

  const unitOptions = WAIT_UNITS.map((candidate) => ({
    value: candidate,
    label: WORKFLOW_COPY.builder.units[candidate],
  }));
</script>

<div class="weft-duration-pair">
  <Input
    id={amountId}
    label={amountLabel}
    aria-label={amountName}
    type="number"
    min="0"
    size="sm"
    {required}
    {...error}
    value={amount}
    onValueChange={(next) => onChange(next, unit)}
  />
  <Select
    id={unitId}
    label={unitLabel}
    aria-label={unitName}
    size="sm"
    required
    value={unit}
    options={unitOptions}
    onValueChange={(next: WaitUnit) => onChange(amount, next)}
  />
</div>

<style>
  .weft-duration-pair {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
  }

  .weft-duration-pair > :global(*) {
    flex: 1 1 8rem;
    min-width: 0;
  }
</style>

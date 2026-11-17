<script lang="ts">
  import { MatrixChart } from './index.ts';

  // Eleven steps along each ramp, so every number from the faintest to the strongest cell is
  // checked against its own cell, and one cell with no value.
  const columns = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'];
  const sequential = [
    ...columns.map((column, index) => ({ row: 'Values', column, value: index * 10 })),
    ...columns.map((column, index) => ({
      row: 'With a gap',
      column,
      value: index === 5 ? null : index * 10,
    })),
  ];
  const diverging = columns.map((column, index) => ({
    row: 'Change',
    column,
    value: (index - 5) * 20,
  }));
</script>

<div class="matrix-chart-ramp">
  <div data-testid="sequential">
    <MatrixChart
      label="Sequential ramp"
      data={sequential}
      xField="column"
      yField="row"
      valueField="value"
      colorScale="sequential"
      height={180}
    />
  </div>
  <div data-testid="diverging">
    <MatrixChart
      label="Diverging ramp"
      data={diverging}
      xField="column"
      yField="row"
      valueField="value"
      colorScale="diverging"
      height={120}
    />
  </div>
</div>

<style>
  .matrix-chart-ramp {
    display: grid;
    gap: 1.5rem;
  }
</style>

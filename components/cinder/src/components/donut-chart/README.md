# DonutChart

`DonutChart` visualizes a small set of part-to-whole values. It exposes visible value labels, an optional center label, series activation, and a horizontal-scroll escape hatch for narrow containers.

Use a bar chart when precise comparison matters more than the part-to-whole relationship.

## Usage

```svelte
<script lang="ts">
  import { DonutChart } from '@lostgradient/cinder';

  const data = [
    { label: 'Build', value: 42 },
    { label: 'Review', value: 28 },
    { label: 'Test', value: 18 },
    { label: 'Docs', value: 12 },
  ];
</script>

<DonutChart label="Workload" {data} centerLabel="Tasks" valueLabels />
```

`label` is required because it names both the chart and its generated data table. `valueLabels` adds visible values; `centerLabel` is supplemental and should not be the only explanation of the total. Use `scrollable` when the legend or ring cannot fit the container, and provide `onSeriesClick` only when a series is actionable—otherwise keep the chart informational. The data table remains the non-visual fallback for comparison and screen-reader users.

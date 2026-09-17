<script lang="ts">
  import { DonutChart } from '@repo/cinder';

  const data = [
    { label: 'Build', value: 42 },
    { label: 'Review', value: 28 },
    { label: 'Test', value: 18 },
    { label: 'Docs', value: 12 },
  ];
</script>

<DonutChart label="Workload" {data} centerLabel="Tasks" valueLabels />

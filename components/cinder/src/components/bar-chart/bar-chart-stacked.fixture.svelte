<script lang="ts">
  import { BarChart } from './index.ts';

  // A stack whose top segment is zero in one category and whose values go below zero in another,
  // so the rounded end moves to the next visible segment and to the bottom of the negative stack.
  const data = [
    { week: 'Week 1', open: 12, pending: 8, closed: 20, reopened: 4 },
    { week: 'Week 2', open: 16, pending: 6, closed: 18, reopened: 0 },
    { week: 'Week 3', open: 10, pending: -5, closed: 22, reopened: -3 },
  ];
  const series = [
    { id: 'open', label: 'Open', valueKey: 'open' },
    { id: 'pending', label: 'Pending', valueKey: 'pending' },
    { id: 'closed', label: 'Closed', valueKey: 'closed' },
    { id: 'reopened', label: 'Reopened', valueKey: 'reopened' },
  ];
</script>

<div class="bar-chart-stacked">
  <div data-testid="vertical-stacked">
    <BarChart label="Tickets by week" {data} categoryKey="week" {series} mode="stacked" />
  </div>
  <div data-testid="horizontal-stacked">
    <BarChart
      label="Tickets by week, across"
      {data}
      categoryKey="week"
      {series}
      mode="stacked"
      orientation="horizontal"
    />
  </div>
  <div data-testid="vertical-grouped">
    <BarChart label="Tickets by week, side by side" {data} categoryKey="week" {series} />
  </div>
</div>

<style>
  .bar-chart-stacked {
    display: grid;
    gap: 1.5rem;
  }
</style>

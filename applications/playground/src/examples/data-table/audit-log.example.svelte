<script lang="ts" module>
  export const title = 'Audit log in a list and detail';
  export const description =
    'A table in the list slot of ListDetail. Rows group by day under a header that names the zone, the open row stays highlighted beside its detail, and the footer counts the rows. More rows load as the end scrolls into view, with no Load more button.';
</script>

<script lang="ts">
  import { DataTable, ListDetail } from '@lostgradient/cinder';

  type Event = { id: string; day: string; when: string; what: string; target: string };

  const zone = 'Central time';
  const days: Record<string, string> = {
    today: 'Today, Nov 2',
    yesterday: 'Yesterday, Sun Nov 1',
  };
  const earlier: Event[] = [
    {
      id: 'e1',
      day: 'today',
      when: '10:45 AM',
      what: 'Removed the Anthropic key',
      target: 'Anthropic provider',
    },
    {
      id: 'e2',
      day: 'today',
      when: '10:42 AM',
      what: 'Started a run',
      target: 'Chat › Refund order 4471',
    },
    {
      id: 'e3',
      day: 'today',
      when: '9:00 AM',
      what: 'Server started',
      target: 'Interborough 2.4.1',
    },
    { id: 'e4', day: 'yesterday', when: '4:12 PM', what: 'Deleted a chat', target: 'Scratch test' },
  ];

  let events = $state<Event[]>(earlier);
  const total = 1240;

  const columns = [
    { key: 'when' as const, label: 'When' },
    { key: 'what' as const, label: 'What' },
    { key: 'target' as const, label: 'Target' },
  ];

  function loadMore(): void {
    events = [
      ...events,
      {
        id: `e${events.length + 1}`,
        day: 'yesterday',
        when: '3:00 PM',
        what: 'Edited an agent',
        target: 'Tool runner',
      },
    ];
  }
</script>

<div class="audit">
  <ListDetail
    items={events}
    key={(event) => event.id}
    label="Audit events"
    selectionParameter="event"
  >
    {#snippet listBody(body)}
      <DataTable
        caption="Audit events"
        {columns}
        rows={body.items}
        getRowId={(row) => String(row['id'])}
        openRowId={body.selectedKey}
        onRowOpen={(row) => body.open(String(row['id']))}
        groupBy={(row) => ({
          key: String(row['day']),
          label: days[String(row['day'])] ?? '',
          detail: zone,
        })}
        onReachEnd={events.length < total ? loadMore : undefined}
      ></DataTable>
    {/snippet}
    {#snippet detail(event)}
      <h3>{event.what}</h3>
      <p>{event.target} · {event.when}</p>
    {/snippet}
  </ListDetail>
</div>

<style>
  .audit {
    block-size: 24rem;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    overflow: hidden;
  }
</style>

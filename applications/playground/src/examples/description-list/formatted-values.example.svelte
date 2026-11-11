<script lang="ts" module>
  export const title = 'Description list formatted values';
  export const description =
    'A shortened ID with a copy button, a timestamp with the exact time on hover, and read-only tags with an Add a tag action.';
</script>

<script lang="ts">
  import { DescriptionList } from '@lostgradient/cinder';
  import type { DescriptionListItem } from '@lostgradient/cinder';

  const items: DescriptionListItem[] = [
    {
      term: 'Run ID',
      definition: { type: 'identifier', value: '3f2b9c1a-7d4e-4a86-9b0c-1e5d6f7a8b90' },
    },
    { term: 'Started', definition: { type: 'timestamp', value: '2026-10-30T14:15:07Z' } },
    {
      term: 'Tags',
      definition: {
        type: 'tags',
        tags: ['billing', 'nightly'],
        systemTagCount: 3,
        onAddTag: () => {},
      },
    },
  ];
</script>

<DescriptionList {items} variant="two-column" />

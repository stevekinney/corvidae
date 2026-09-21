<script lang="ts">
  import { KeyboardShortcuts } from '@lostgradient/cinder';
  const groups = [
    {
      label: 'General',
      shortcuts: [
        { action: 'Open command palette', keys: ['⌘', 'K'] },
        { action: 'Search', keys: ['/'] },
        { action: 'Go back', keys: ['Esc'] },
      ],
    },
    {
      label: 'Editing',
      shortcuts: [
        { action: 'Save', keys: ['⌘', 'S'] },
        { action: 'Undo', keys: ['⌘', 'Z'] },
        { action: 'Redo', keys: ['⌘', 'Shift', 'Z'] },
      ],
    },
  ];
</script>

<KeyboardShortcuts heading="Keyboard Shortcuts" {groups} />

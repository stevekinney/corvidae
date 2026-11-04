<script lang="ts" module>
  export const title = 'A patch in the payload';
  export const description =
    'A unified patch goes through the diff viewer: line breaks stay, the first two changed lines show, the count sits beside the label and Show all opens the rest. A file path is set in monospace.';
</script>

<script lang="ts">
  import { PayloadInspector } from '@lostgradient/cinder';

  const patch = [
    '--- a/release-notes.md',
    '+++ b/release-notes.md',
    '@@ -12,3 +12,5 @@',
    ' # Release notes',
    '-Refunds are sent at once.',
    '+Refunds now ask for approval before money moves.',
    '+Large refunds go to a person.',
    '+Nothing is sent without a note.',
    ' Thanks for reading.',
    '',
  ].join('\n');
</script>

<PayloadInspector value={{ path: 'release-notes.md', patch }} label="Input" />

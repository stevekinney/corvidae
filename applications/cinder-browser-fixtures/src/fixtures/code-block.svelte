<script lang="ts">
  import { CodeBlock } from '@repo/cinder';
  const code = `function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

const message = greet('world');`;
</script>

<CodeBlock {code} />

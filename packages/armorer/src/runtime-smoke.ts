import { createTool, createToolCall, createToolbox } from './index.ts';

/** Exercises registration and execution of a portable Armorer tool. */
export async function runRuntimeSmoke(): Promise<void> {
  const tool = createTool({
    name: 'portable-smoke',
    description: 'Returns a fixed portable result.',
    execute: async () => 'portable',
  });
  const result = await createToolbox([tool]).execute(createToolCall(tool.name, {}), {
    ownerId: 'smoke',
  });
  if (result.error !== undefined) throw new Error(`Armorer tool failed: ${result.error.message}`);
}

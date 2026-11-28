/** One sequential component-metadata partition; exits if its parent closes standard input. */
import { join } from 'node:path';
import { z } from 'zod';
import { generateSchemaForComponent } from './generate-component-schema.ts';
import { generateVariablesForComponent } from './generate-component-variables.ts';

if (import.meta.main) {
  const components = z
    .array(z.object({ directory: z.string(), name: z.string() }))
    .parse(JSON.parse(process.argv[2] ?? ''));
  void (async () => {
    const reader = Bun.stdin.stream().getReader();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) continue;
    process.exit(1);
  })();
  const results = [];
  for (const { directory, name } of components) {
    const schema = generateSchemaForComponent({
      typesFilePath: join(directory, `${name}.types.ts`),
      componentName: name,
    });
    const variables = await generateVariablesForComponent({
      componentDirectory: directory,
      componentName: name,
    });
    results.push({ name, schema: schema.schema, variables: variables.variables });
  }
  await Bun.write(Bun.stdout, JSON.stringify(results));
  process.exit(0);
}

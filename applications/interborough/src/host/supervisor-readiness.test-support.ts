import { rename } from 'node:fs/promises';

export async function publishSupervisorReadiness(
  path: string,
  url: string,
  write: (path: string, value: string) => Promise<unknown> = Bun.write,
): Promise<void> {
  const temporary = `${path}.tmp`;
  await write(temporary, url);
  await rename(temporary, path);
}

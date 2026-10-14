/** Wait until `condition` holds, polling between tasks. Fails with `description` if it never does. */
export async function waitFor(
  condition: () => boolean,
  description: string,
  attempts = 900,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/** Let every pending promise continuation and zero-delay timer run. */
export function settle(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export type JsonlRecordPredicate = (record: unknown) => boolean;

export async function readFirstJsonlRecord(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: JsonlRecordPredicate,
): Promise<{ record: unknown; text: string }> {
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      buffered += decoder.decode();
      throw new Error('JSONL stream ended before the expected record');
    }
    buffered += decoder.decode(next.value, { stream: true });
    const newlineMatch = /\r?\n/.exec(buffered);
    if (newlineMatch === null || newlineMatch.index === undefined) continue;
    const text = buffered.slice(0, newlineMatch.index);
    buffered = buffered.slice(newlineMatch.index + newlineMatch[0].length);
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      throw new Error('JSONL stream emitted a malformed record');
    }
    if (!predicate(record)) throw new Error('JSONL stream emitted an unexpected record');
    return { record, text };
  }
}

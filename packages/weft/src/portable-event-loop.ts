/** Lets queued promise continuations settle without advancing application time. */
export async function flushPortableMicrotasks(turns = 3): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

/** Yields one portable event-loop turn, then drains the resulting microtasks. */
export async function yieldToPortableEventLoop(): Promise<void> {
  if (typeof MessageChannel !== 'undefined') {
    await new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(undefined);
    });
  } else {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  await flushPortableMicrotasks();
}

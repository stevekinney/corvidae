import { setImmediate } from 'node:timers/promises';

await setImmediate();

self.onmessage = (event: MessageEvent<unknown>) => {
  postMessage(event.data);
};

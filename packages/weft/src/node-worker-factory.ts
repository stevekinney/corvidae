import { Worker } from 'node:worker_threads';

import type { CreateWorker, WorkerLike } from './workers/pool.ts';

class NodeWorkerAdapter {
  readonly #worker: Worker;
  readonly #listeners = new Map<EventListenerOrEventListenerObject, (...args: unknown[]) => void>();

  constructor(url: string | URL) {
    this.#worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const scope = new EventTarget();
      let onmessage = null;
      Object.defineProperty(scope, 'onmessage', { get: () => onmessage, set: value => { onmessage = value; } });
      globalThis.self = scope;
      globalThis.postMessage = message => parentPort.postMessage(message);
      parentPort.on('message', data => {
        const event = new MessageEvent('message', { data });
        scope.dispatchEvent(event);
        onmessage?.(event);
      });
      import(workerData.entry);
    `, {
      eval: true,
      workerData: { entry: String(url) },
    });
  }

  postMessage(message: unknown): void { this.#worker.postMessage(message); }
  terminate(): Promise<number> { return this.#worker.terminate(); }

  addEventListener(type: 'message' | 'error' | 'messageerror' | 'close', listener: EventListenerOrEventListenerObject): void {
    const eventType = type === 'close' ? 'exit' : type;
    const wrapped = (...args: unknown[]) => {
      const event = type === 'message' ? new MessageEvent('message', { data: args[0] }) : new Event(type);
      typeof listener === 'function' ? listener(event) : listener.handleEvent(event);
    };
    this.#listeners.set(listener, wrapped);
    this.#worker.on(eventType, wrapped);
  }

  removeEventListener(_type: 'message' | 'error' | 'messageerror' | 'close', listener: EventListenerOrEventListenerObject): void {
    const wrapped = this.#listeners.get(listener);
    if (wrapped) this.#worker.off('message', wrapped);
  }
}

/** Creates a Node worker-thread behind the Web Worker contract used by Weft. */
export const nodeWorkerFactory: CreateWorker = (url) => new NodeWorkerAdapter(url) as unknown as WorkerLike;

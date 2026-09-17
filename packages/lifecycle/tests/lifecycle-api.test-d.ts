import { eventIterator } from '../src/event-iterator';
import { eventObservable } from '../src/event-observable';
import { HookRegistry } from '../src/hooks/hook-registry';
import { TypedEventTarget } from '../src/typed-event-target';

class MessageEvent extends Event {
  readonly message: string;

  constructor(message: string) {
    super('message');
    this.message = message;
  }
}

type MessageEvents = { message: MessageEvent };
type Hooks = { transform: (value: string) => string | Promise<string> };

const target = new TypedEventTarget<MessageEvents>();
const iterator = eventIterator(target, 'message');
const observable = eventObservable(target, 'message');

function acceptsMessage(_event: MessageEvent): void {}

void iterator.next().then((result) => {
  if (!result.done) acceptsMessage(result.value);
  return undefined;
});

observable.subscribe((event) => {
  const message: string = event.message;
  void message;
});

const registry = new HookRegistry<Hooks>();
void registry.run('transform', 'input').then((result) => {
  if (result !== undefined) {
    const output: string = result;
    void output;
  }
  return undefined;
});

// @ts-expect-error Hook names are restricted to the declared hook map.
void registry.run('missing', 'input');
// @ts-expect-error Hook arguments are restricted to the declared handler parameters.
void registry.run('transform', 42);

const nativeTarget = new EventTarget();
const nativeIterator = eventIterator(nativeTarget, 'message');
// @ts-expect-error Native EventTarget output is Event until a typed target map is supplied.
const typedIterator: AsyncIterableIterator<MessageEvent> = nativeIterator;

const nativeObservable = eventObservable(nativeTarget, 'message');
nativeObservable.subscribe((event) => {
  // @ts-expect-error Native EventTarget output does not promise MessageEvent fields.
  void event.message;
});

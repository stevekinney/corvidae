import type {
  Context,
  Exception,
  Link,
  Span,
  SpanAttributeValue,
  SpanAttributes,
  SpanKind,
  SpanOptions,
  SpanStatus,
  TimeInput,
  Tracer,
} from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';

export type RecordedEvent = {
  name: string;
  attributes?: SpanAttributes;
};

export class RecordingSpan implements Span {
  public readonly attributes: Record<string, SpanAttributeValue | undefined> = {};
  public readonly events: RecordedEvent[] = [];
  public readonly exceptions: Exception[] = [];
  public ended = false;
  /** How many times `end` was called; a real span is ended once. */
  public endCount = 0;
  /** The writes made after `end`, which a real span drops (COR-1627). */
  public readonly writesAfterEnd: string[] = [];
  public readonly kind: SpanKind | undefined;
  public readonly name: string;
  public readonly parentContext: Context | undefined;
  public status: SpanStatus = { code: SpanStatusCode.UNSET };

  public constructor(name: string, options?: SpanOptions, parentContext?: Context) {
    this.name = name;
    this.kind = options?.kind;
    this.parentContext = parentContext;
    this.setAttributes(options?.attributes ?? {});
  }

  public addEvent(
    name: string,
    attributesOrStartTime?: SpanAttributes | TimeInput,
    _startTime?: TimeInput,
  ): this {
    const attributes = this.isSpanAttributes(attributesOrStartTime)
      ? attributesOrStartTime
      : undefined;
    if (attributes === undefined) {
      this.events.push({ name });
    } else {
      this.events.push({ name, attributes });
    }
    return this;
  }

  public addLink(_link: Link): this {
    throw new Error('RecordingSpan.addLink is unsupported in this fixture');
  }

  public addLinks(_links: Link[]): this {
    throw new Error('RecordingSpan.addLinks is unsupported in this fixture');
  }

  public end(_endTime?: TimeInput): void {
    this.endCount += 1;
    this.ended = true;
  }

  public isRecording(): boolean {
    return !this.ended;
  }

  public recordException(exception: Exception, _time?: TimeInput): void {
    this.exceptions.push(exception);
  }

  public setAttribute(key: string, value: SpanAttributeValue): this {
    if (this.ended) {
      this.writesAfterEnd.push(key);
      return this;
    }
    this.attributes[key] = value;
    return this;
  }

  public setAttributes(attributes: SpanAttributes): this {
    for (const [key, value] of Object.entries(attributes)) {
      if (this.ended) {
        this.writesAfterEnd.push(key);
        continue;
      }
      this.attributes[key] = value;
    }
    return this;
  }

  public setStatus(status: SpanStatus): this {
    if (this.ended) {
      this.writesAfterEnd.push('status');
      return this;
    }
    this.status = status;
    return this;
  }

  public spanContext() {
    return {
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000001',
      traceFlags: 1,
    };
  }

  public updateName(_name: string): this {
    throw new Error('RecordingSpan.updateName is unsupported in this fixture');
  }

  private isSpanAttributes(value: SpanAttributes | TimeInput | undefined): value is SpanAttributes {
    return value !== undefined && typeof value === 'object' && !Array.isArray(value);
  }
}

export class RecordingTracer implements Tracer {
  public readonly spans: RecordingSpan[] = [];

  public startSpan(name: string, options?: SpanOptions, context?: Context): RecordingSpan {
    const span = new RecordingSpan(name, options, context);
    this.spans.push(span);
    return span;
  }

  public startActiveSpan<F extends (span: Span) => ReturnType<F>>(
    name: string,
    fn: F,
  ): ReturnType<F>;
  public startActiveSpan<F extends (span: Span) => ReturnType<F>>(
    name: string,
    options: SpanOptions,
    fn: F,
  ): ReturnType<F>;
  public startActiveSpan<F extends (span: Span) => ReturnType<F>>(
    name: string,
    options: SpanOptions,
    context: Context,
    fn: F,
  ): ReturnType<F>;
  public startActiveSpan<F extends (span: Span) => ReturnType<F>>(
    name: string,
    optionsOrFunction: SpanOptions | F,
    contextOrFunction?: Context | F,
    functionArgument?: F,
  ): ReturnType<F> {
    void name;
    void optionsOrFunction;
    void contextOrFunction;
    void functionArgument;
    throw new Error('RecordingTracer.startActiveSpan is unsupported in this fixture');
  }
}

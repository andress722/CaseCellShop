import {
  context,
  propagation,
  trace,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import {
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

const tracer = trace.getTracer("casecellshop");

class JsonSpanExporter implements SpanExporter {
  constructor(private readonly service: string) {}

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    for (const span of spans) {
      process.stdout.write(
        JSON.stringify({
          type: "otel.span",
          timestamp: new Date().toISOString(),
          service: this.service,
          name: span.name,
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
          parentSpanId: span.parentSpanContext?.spanId,
          durationMs: span.duration[0] * 1000 + span.duration[1] / 1_000_000,
          status: span.status.code,
        }) + "\n",
      );
    }
    done({ code: ExportResultCode.SUCCESS });
  }

  async shutdown(): Promise<void> {}
}

export function startTracing(service = "casecellshop-api") {
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(new JsonSpanExporter(service))],
  });
  provider.register({
    contextManager: new AsyncLocalStorageContextManager(),
    propagator: new W3CTraceContextPropagator(),
  });
  return provider;
}

export function startSpan(
  name: string,
  carrier?: Record<string, string>,
): Span {
  const parent = carrier
    ? propagation.extract(context.active(), carrier)
    : context.active();
  return tracer.startSpan(name, undefined, parent);
}

export async function withSpan<T>(
  name: string,
  action: () => Promise<T>,
  parent?: Context,
): Promise<T> {
  const span = tracer.startSpan(name, undefined, parent);
  try {
    return await context.with(
      trace.setSpan(parent ?? context.active(), span),
      action,
    );
  } catch (error) {
    span.recordException(error as Error);
    throw error;
  } finally {
    span.end();
  }
}

export function spanContext(span: Span): Context {
  return trace.setSpan(context.active(), span);
}

export function traceCarrier(parent?: Context): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(parent ?? context.active(), carrier);
  return carrier;
}

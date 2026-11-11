import type { ChatEvent } from '@/types/chat';

/**
 * A small SSE writer backed by a ReadableStream with an internal queue.
 *
 * TransformStream + writer.close() can lose buffered chunks when the consumer
 * attaches after the run has already completed (notably in tests and slow
 * clients). The controller queue here keeps those chunks until they are read.
 */
export function createSseStream() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
    },
  });

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      controller.close();
    } catch {
      // Already closed or cancelled.
    }
  };

  const writeEvent = async (event: ChatEvent) => {
    if (closed) return;
    try {
      const payload = `data: ${JSON.stringify(event)}\n\n`;
      controller.enqueue(encoder.encode(payload));
      if (event.type === 'complete' || event.type === 'error') {
        close();
      }
    } catch {
      // The client disconnected. The background run continues in runManager.
      closed = true;
    }
  };

  const response = new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });

  return { response, writeEvent, close };
}

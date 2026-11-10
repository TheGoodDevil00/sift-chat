import { NextRequest, NextResponse } from 'next/server';
import { runManager } from '@/lib/agent/run-manager';
import type { ChatEvent } from '@/types/chat';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const conversationId = searchParams.get('conversationId');

  if (!conversationId) {
    return NextResponse.json(
      { error: 'conversationId parameter is required', code: 'INVALID_REQUEST' },
      { status: 400 }
    );
  }

  const run = runManager.getRun(conversationId);

  if (!run || run.status === 'aborted') {
    return NextResponse.json(
      { error: 'No active run found for this conversation', active: false },
      { status: 404 }
    );
  }

  // Setup SSE stream
  const responseStream = new TransformStream();
  const writer = responseStream.writable.getWriter();
  const encoder = new TextEncoder();

  const writeEvent = async (event: ChatEvent) => {
    try {
      const payload = `data: ${JSON.stringify(event)}\n\n`;
      await writer.write(encoder.encode(payload));
      if (event.type === 'complete' || event.type === 'error') {
        await writer.close().catch(() => {});
      }
    } catch {
      // Client disconnected
    }
  };

  (async () => {
    // 1. Replay initial start event
    await writeEvent({
      type: 'start',
      conversationId: run.conversationId,
      userMessageId: run.userMessageId,
    });

    if (run.status === 'running') {
      // 2. Replay current active phase
      if (run.phase) {
        await writeEvent({
          type: 'status',
          phase: run.phase,
        });
      }

      // 3. Replay accumulated text generated so far
      if (run.accumulatedText) {
        await writeEvent({
          type: 'delta',
          text: run.accumulatedText,
        });
      }

      // 4. Subscribe to future events
      const unsubscribe = runManager.subscribe(conversationId, (event) => {
        writeEvent(event);
      });

      req.signal.addEventListener('abort', () => {
        unsubscribe();
        writer.close().catch(() => {});
      });
    } else if (run.status === 'completed') {
      // Run already finished recently: send full text and complete event
      if (run.accumulatedText) {
        await writeEvent({
          type: 'delta',
          text: run.accumulatedText,
        });
      }

      await writeEvent({
        type: 'complete',
        assistantMessageId: run.assistantMessageId,
        citations: run.finalResult?.citations || [],
        sources: run.finalResult?.sources || [],
        createdAt: run.completedAt || new Date().toISOString(),
        timezoneUsed: 'UTC',
      });
    } else if (run.status === 'failed') {
      await writeEvent({
        type: 'error',
        code: run.error?.code || 'MODEL_REQUEST_FAILED',
        message: run.error?.message || 'Task failed.',
        retryable: run.error?.retryable ?? true,
      });
    }
  })();

  return new Response(responseStream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

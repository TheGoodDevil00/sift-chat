import { runManager, type ActiveRun } from './run-manager';
import type { ChatEvent } from '@/types/chat';

/**
 * Replay a run to a newly connected client and, if it is still running,
 * subscribe it to future events. Returns an unsubscribe function.
 *
 * Used by both the background-stream endpoint and idempotent retries of POST
 * /api/chat so a duplicate request attaches to the original run instead of
 * starting a second model call.
 */
export async function replayRun(
  run: ActiveRun,
  writeEvent: (event: ChatEvent) => Promise<void>,
  signal?: AbortSignal
): Promise<() => void> {
  await writeEvent({
    type: 'start',
    conversationId: run.conversationId,
    userMessageId: run.userMessageId,
  });

  if (run.status === 'running') {
    if (run.phase) {
      await writeEvent({ type: 'status', phase: run.phase });
    }

    if (run.accumulatedText) {
      await writeEvent({ type: 'delta', text: run.accumulatedText });
    }

    const unsubscribe = runManager.subscribe(run.conversationId, (event) => {
      writeEvent(event);
    });

    if (signal) {
      signal.addEventListener('abort', unsubscribe, { once: true });
    }

    return unsubscribe;
  }

  if (run.status === 'completed') {
    await writeEvent({
      type: 'complete',
      assistantMessageId: run.assistantMessageId,
      citations: run.finalResult?.citations || [],
      sources: run.finalResult?.sources || [],
      createdAt: run.completedAt || new Date().toISOString(),
      timezoneUsed: run.timezone,
      thinking: null,
      text: run.accumulatedText,
    });
    return () => {};
  }

  if (run.status === 'failed') {
    await writeEvent({
      type: 'error',
      code: run.error?.code || 'MODEL_REQUEST_FAILED',
      message: run.error?.message || 'Task failed.',
      retryable: run.error?.retryable ?? true,
    });
    return () => {};
  }

  await writeEvent({
    type: 'error',
    code: 'USER_CANCELLED',
    message: 'Generation was stopped by user.',
    retryable: false,
  });
  return () => {};
}

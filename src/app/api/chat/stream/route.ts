import { NextRequest, NextResponse } from 'next/server';
import { runManager } from '@/lib/agent/run-manager';
import { replayRun } from '@/lib/agent/replay';
import { createSseStream } from '@/lib/agent/sse';

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

  const { response, writeEvent, close } = createSseStream();

  (async () => {
    const unsubscribe = await replayRun(run, writeEvent, req.signal);

    req.signal.addEventListener('abort', () => {
      unsubscribe();
      close();
    });
  })();

  return response;
}

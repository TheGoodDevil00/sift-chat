import { NextRequest, NextResponse } from 'next/server';
import { runManager } from '@/lib/agent/run-manager';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const CancelSchema = z.object({
  conversationId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const json = await req.json().catch(() => null);
    const parsed = CancelSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'conversationId is required', code: 'INVALID_REQUEST' },
        { status: 400 }
      );
    }

    const cancelled = runManager.cancelRun(parsed.data.conversationId);
    if (!cancelled) {
      return NextResponse.json(
        { error: 'No active run found for this conversation', code: 'RUN_NOT_FOUND', cancelled: false },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, cancelled: true });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to cancel run', code: 'INTERNAL_ERROR' },
      { status: 500 }
    );
  }
}

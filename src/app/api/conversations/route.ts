import { NextRequest, NextResponse } from 'next/server';
import { listConversations, createConversation } from '@/lib/db/repositories/conversations';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(Math.max(Number(searchParams.get('limit') || 50), 1), 100);
    const offset = Math.max(Number(searchParams.get('offset') || 0), 0);

    const conversations = listConversations(limit, offset);
    return NextResponse.json({ conversations });
  } catch (err: any) {
    console.error('Failed to list conversations:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve conversations' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'New Research';
    const timezone = typeof body.timezone === 'string' ? body.timezone : 'UTC';

    const conv = createConversation({ title, timezone });
    return NextResponse.json({ conversation: conv }, { status: 201 });
  } catch (err: any) {
    console.error('Failed to create conversation:', err);
    return NextResponse.json(
      { error: 'Failed to create conversation' },
      { status: 500 }
    );
  }
}

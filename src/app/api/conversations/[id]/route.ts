import { NextRequest, NextResponse } from 'next/server';
import { getConversation, deleteConversation } from '@/lib/db/repositories/conversations';
import { getConversationMessagesWithMeta } from '@/lib/db/repositories/messages';

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const conversation = getConversation(id);

    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found', code: 'CONVERSATION_NOT_FOUND' },
        { status: 404 }
      );
    }

    const messages = getConversationMessagesWithMeta(id);

    return NextResponse.json({
      conversation: {
        ...conversation,
        messages,
      },
    });
  } catch (err: any) {
    console.error('Failed to get conversation:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve conversation', code: 'INTERNAL_ERROR' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const deleted = deleteConversation(id, false);

    if (!deleted) {
      return NextResponse.json(
        { error: 'Conversation not found', code: 'CONVERSATION_NOT_FOUND' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, deletedId: id });
  } catch (err: any) {
    console.error('Failed to delete conversation:', err);
    return NextResponse.json(
      { error: 'Failed to delete conversation', code: 'INTERNAL_ERROR' },
      { status: 500 }
    );
  }
}

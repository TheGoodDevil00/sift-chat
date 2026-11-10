import { NextRequest, NextResponse } from 'next/server';
import { validateChatRequest } from '@/lib/validation';
import {
  createConversation,
  getConversation,
  touchConversation,
} from '@/lib/db/repositories/conversations';
import {
  insertMessage,
  getRecentMessages,
} from '@/lib/db/repositories/messages';
import { retrieveRelevantHistory } from '@/lib/history/retrieve';
import { classifyIntent } from '@/lib/agent/intent';
import { buildAgentInput } from '@/lib/agent/input-builder';
import { runManager } from '@/lib/agent/run-manager';
import { randomUUID } from 'crypto';
import type { ChatEvent } from '@/types/chat';

export const dynamic = 'force-dynamic';

function generateTitle(message: string): string {
  const clean = message.replace(/\s+/g, ' ').trim();
  if (clean.length <= 60) return clean;
  return clean.slice(0, 57) + '...';
}

export async function POST(req: NextRequest) {
  try {
    const json = await req.json().catch(() => null);
    const validation = validateChatRequest(json);

    if (!validation.success) {
      return NextResponse.json(
        { error: validation.error, code: 'INVALID_REQUEST' },
        { status: 400 }
      );
    }

    const { message, timezone, clientRequestId, providerConfig } = validation.data;
    let conversationId = validation.data.conversationId;

    // Resolve or create conversation
    let conv = conversationId ? getConversation(conversationId) : null;
    if (conversationId && !conv) {
      return NextResponse.json(
        { error: 'Conversation not found', code: 'CONVERSATION_NOT_FOUND' },
        { status: 404 }
      );
    }

    if (!conv) {
      const title = generateTitle(message);
      conv = createConversation({ title, timezone });
      conversationId = conv.id;
    } else {
      touchConversation(conv.id, { timezone });
    }

    // Persist user message immediately
    const userMsgResult = insertMessage({
      conversation_id: conv.id,
      role: 'user',
      content: message,
      client_request_id: clientRequestId,
    });
    const userMessage = userMsgResult.message;

    // Load recent messages (up to 10 previous messages in this conversation)
    const recentMessages = getRecentMessages(conv.id, 10).filter(
      (m) => m.id !== userMessage.id
    );

    // Retrieve relevant historical conversation evidence across all history
    const historyResult = retrieveRelevantHistory(
      message,
      timezone,
      conv.id,
      userMessage.id,
      new Date()
    );

    // Classify user intent
    const { intent: _intent, requiresSearch } = classifyIntent(
      message,
      historyResult.temporal.hasDate
    );

    // Build bounded agent input
    const preparedInput = buildAgentInput({
      userMessage: message,
      userTimezone: timezone,
      referenceDate: new Date(),
      recentMessages,
      historicalExcerpts: historyResult.excerpts,
      temporal: historyResult.temporal,
      requiresSearch,
    });

    const assistantMessageId = randomUUID();

    // Setup SSE Response stream
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
        // Client disconnected (e.g. page refreshed or switched thread)
        // Background run continues in runManager
      }
    };

    // Start background run managed by RunManager
    // This runs completely independently of the HTTP request, surviving page reloads
    // and allowing users to navigate between threads concurrently.
    const _run = runManager.startRun({
      conversationId: conv.id,
      userMessageId: userMessage.id,
      assistantMessageId,
      preparedInput,
      providerConfig,
      timezone,
      initialSubscriber: (event) => {
        writeEvent(event);
      },
    });

    // When client disconnects or aborts the HTTP request, clean up only the listener
    req.signal.addEventListener('abort', () => {
      writer.close().catch(() => {});
    });

    return new Response(responseStream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (err: any) {
    console.error('Fatal error in POST /api/chat:', err);
    return NextResponse.json(
      { error: 'An unexpected internal error occurred', code: 'INTERNAL_ERROR' },
      { status: 500 }
    );
  }
}

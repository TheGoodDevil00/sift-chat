import { NextRequest, NextResponse } from 'next/server';
import { validateChatRequest } from '@/lib/validation';
import {
  createConversation,
  getConversation,
  touchConversation,
} from '@/lib/db/repositories/conversations';
import {
  insertMessage,
  getMessageByClientRequestId,
  getMessageCitations,
  getMessageSources,
  getRecentMessages,
} from '@/lib/db/repositories/messages';
import { retrieveRelevantHistory } from '@/lib/history/retrieve';
import { classifyIntent } from '@/lib/agent/intent';
import { buildAgentInput } from '@/lib/agent/input-builder';
import { runManager } from '@/lib/agent/run-manager';
import { replayRun } from '@/lib/agent/replay';
import { createSseStream } from '@/lib/agent/sse';
import { randomUUID } from 'crypto';
import type { Conversation, Message } from '@/types/chat';

export const dynamic = 'force-dynamic';

function generateTitle(message: string): string {
  const clean = message.replace(/\s+/g, ' ').trim();
  if (clean.length <= 60) return clean;
  return clean.slice(0, 57) + '...';
}

async function replayExistingReply(
  conv: Conversation,
  userMessage: Message,
  clientRequestId: string,
  req: NextRequest
): Promise<Response | null> {
  const assistantRequestId = `${clientRequestId}:assistant`;
  const existingReply = getMessageByClientRequestId(assistantRequestId);
  if (!existingReply) return null;

  const activeRun = runManager.getRun(conv.id);
  if (
    activeRun &&
    activeRun.assistantMessageId === existingReply.id &&
    activeRun.status === 'running'
  ) {
    const { response, writeEvent, close } = createSseStream();
    (async () => {
      const unsubscribe = await replayRun(activeRun, writeEvent, req.signal);
      req.signal.addEventListener('abort', () => {
        unsubscribe();
        close();
      });
    })();
    return response;
  }

  if (existingReply.status !== 'complete') {
    // A failed/interrupted row is a retryable attempt, not a terminal answer.
    // The caller will reuse this assistant id and start a fresh run for it.
    return null;
  }

  const { response, writeEvent } = createSseStream();
  await writeEvent({
    type: 'start',
    conversationId: conv.id,
    userMessageId: userMessage.id,
  });
  await writeEvent({
    type: 'complete',
    assistantMessageId: existingReply.id,
    citations: getMessageCitations(existingReply.id),
    sources: getMessageSources(existingReply.id),
    createdAt: existingReply.created_at,
    timezoneUsed: conv.timezone || 'UTC',
    thinking: null,
    text: existingReply.content,
  });
  return response;
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
    const requestedConversationId = validation.data.conversationId;

    let conv: Conversation;
    let userMessage: Message;
    let retryAssistantId: string | undefined;

    // Check idempotency before creating anything, so a retry does not leave an
    // empty conversation behind.
    const existingUser = getMessageByClientRequestId(clientRequestId);
    if (existingUser) {
      if (requestedConversationId && requestedConversationId !== existingUser.conversation_id) {
        return NextResponse.json(
          {
            error: 'This clientRequestId belongs to a different conversation.',
            code: 'REQUEST_ID_CONFLICT',
          },
          { status: 409 }
        );
      }

      if (existingUser.content !== message) {
        return NextResponse.json(
          {
            error: 'This clientRequestId was already used with different message content.',
            code: 'REQUEST_ID_CONFLICT',
          },
          { status: 409 }
        );
      }

      const existingConversation = getConversation(existingUser.conversation_id);
      if (!existingConversation) {
        return NextResponse.json(
          { error: 'Conversation not found for existing request', code: 'CONVERSATION_NOT_FOUND' },
          { status: 404 }
        );
      }

      conv = existingConversation;
      userMessage = existingUser;
      touchConversation(conv.id, { timezone });

      const replayed = await replayExistingReply(conv, userMessage, clientRequestId, req);
      if (replayed) return replayed;

      // A failed/interrupted assistant row is reused so the retry does not
      // create a second assistant message for the same user turn.
      const retryReply = getMessageByClientRequestId(`${clientRequestId}:assistant`);
      if (retryReply && retryReply.status !== 'complete') {
        retryAssistantId = retryReply.id;
      }

      // The user turn exists but no assistant row does (for example a crash
      // between the two inserts). Recover by running the existing turn once.
      const competingRun = runManager.getRun(conv.id);
      if (
        competingRun &&
        (competingRun.userMessageId !== userMessage.id ||
          (retryAssistantId && competingRun.assistantMessageId !== retryAssistantId))
      ) {
        return NextResponse.json(
          {
            error: 'Another response is already being generated for this conversation.',
            code: 'CONVERSATION_BUSY',
          },
          { status: 409 }
        );
      }
    } else {
      const found = requestedConversationId ? getConversation(requestedConversationId) : null;
      if (requestedConversationId && !found) {
        return NextResponse.json(
          { error: 'Conversation not found', code: 'CONVERSATION_NOT_FOUND' },
          { status: 404 }
        );
      }

      conv = found || createConversation({ title: generateTitle(message), timezone });
      if (found) touchConversation(conv.id, { timezone });

      const userMsgResult = insertMessage({
        conversation_id: conv.id,
        role: 'user',
        content: message,
        client_request_id: clientRequestId,
      });
      userMessage = userMsgResult.message;

      // Extremely unlikely within a single process, but guard against a race
      // between two identical requests passing the lookup above.
      if (userMsgResult.isExisting) {
        const replayed = await replayExistingReply(conv, userMessage, clientRequestId, req);
        if (replayed) return replayed;
        const retryReply = getMessageByClientRequestId(`${clientRequestId}:assistant`);
        if (retryReply && retryReply.status !== 'complete') {
          retryAssistantId = retryReply.id;
        }
      }
    }

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
      confidence: historyResult.confidence,
      missingTopicExplanation: historyResult.missingTopicExplanation,
      dayTruncated: historyResult.dayTruncated,
      truncationNote: historyResult.truncationNote,
      intent: _intent,
    });

    const assistantMessageId = retryAssistantId || randomUUID();
    const { response, writeEvent, close } = createSseStream();

    // Start background run managed by RunManager.
    // This runs completely independently of the HTTP request, surviving page reloads
    // and allowing users to navigate between threads concurrently.
    runManager.startRun({
      conversationId: conv.id,
      userMessageId: userMessage.id,
      assistantMessageId,
      preparedInput,
      providerConfig,
      timezone,
      clientRequestId,
      reuseAssistantMessage: Boolean(retryAssistantId),
      initialSubscriber: (event) => {
        writeEvent(event);
      },
    });

    // When the client disconnects or aborts the HTTP request, clean up only the listener.
    req.signal.addEventListener('abort', () => {
      close();
    });

    return response;
  } catch (err: any) {
    console.error('Fatal error in POST /api/chat:', err);
    return NextResponse.json(
      { error: 'An unexpected internal error occurred', code: 'INTERNAL_ERROR' },
      { status: 500 }
    );
  }
}

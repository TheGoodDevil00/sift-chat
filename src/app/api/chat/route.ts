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
  insertCitations,
  insertSources,
} from '@/lib/db/repositories/messages';
import { retrieveRelevantHistory } from '@/lib/history/retrieve';
import { classifyIntent } from '@/lib/agent/intent';
import { buildAgentInput } from '@/lib/agent/input-builder';
import { runAgent } from '@/lib/agent/run';
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
    const { intent, requiresSearch } = classifyIntent(
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

    // Setup SSE Response
    const responseStream = new TransformStream();
    const writer = responseStream.writable.getWriter();
    const encoder = new TextEncoder();

    const sendEvent = async (event: ChatEvent) => {
      const payload = `data: ${JSON.stringify(event)}\n\n`;
      await writer.write(encoder.encode(payload));
    };

    // Run agent asynchronously in background stream
    (async () => {
      try {
        // Event 1: Start
        await sendEvent({
          type: 'start',
          conversationId: conv.id,
          userMessageId: userMessage.id,
        });

        // Event 2: Status retrieving_history
        await sendEvent({
          type: 'status',
          phase: 'retrieving_history',
        });

        // Run agent with single tool web_search
        const agentResult = await runAgent(
          preparedInput,
          assistantMessageId,
          {
            onStatus: async (phase) => {
              await sendEvent({ type: 'status', phase });
            },
            onDelta: async (text) => {
              await sendEvent({ type: 'delta', text });
            },
          },
          req.signal,
          providerConfig
        );

        if (!agentResult.success || !agentResult.normalized) {
          await sendEvent({
            type: 'error',
            code: agentResult.errorCode || 'MODEL_REQUEST_FAILED',
            message: agentResult.errorMessage || 'Failed to generate agent response.',
            retryable: agentResult.retryable ?? true,
          });
          return;
        }

        const normalized = agentResult.normalized;
        const nowIso = new Date().toISOString();

        // Persist assistant message
        insertMessage({
          id: assistantMessageId,
          conversation_id: conv.id,
          role: 'assistant',
          content: normalized.text,
          status: 'complete',
          model: normalized.model || null,
          provider_response_id: normalized.responseId || null,
        });

        // Persist citations
        const savedCitations = insertCitations(normalized.citations);

        // Persist complete consulted sources list
        const savedSources = insertSources(normalized.sources);

        // Touch conversation updated_at
        touchConversation(conv.id);

        // Terminal complete event
        await sendEvent({
          type: 'complete',
          assistantMessageId,
          citations: savedCitations,
          sources: savedSources,
          createdAt: nowIso,
          timezoneUsed: timezone,
        });
      } catch (streamErr: any) {
        console.error('Streaming error in chat route:', streamErr);
        await sendEvent({
          type: 'error',
          code: 'INTERNAL_ERROR',
          message: streamErr?.message || 'Internal server error while processing turn.',
          retryable: true,
        });
      } finally {
        await writer.close().catch(() => {});
      }
    })();

    return new Response(responseStream.readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (err: any) {
    console.error('Fatal error in POST /api/chat:', err);
    return NextResponse.json(
      { error: err?.message || 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 }
    );
  }
}

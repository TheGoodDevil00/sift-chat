import { randomUUID } from 'crypto';
import { runAgent, type AgentRunResult } from './run';
import type { PreparedAgentMessages } from './input-builder';
import type {
  ChatEvent,
  ChatPhase,
  ClientProviderConfig,
  Citation,
  Source,
} from '@/types/chat';
import {
  insertMessage,
  updateMessage,
  insertCitations,
  insertSources,
} from '@/lib/db/repositories/messages';
import { touchConversation } from '@/lib/db/repositories/conversations';

export interface ActiveRun {
  runId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  phase: ChatPhase | null;
  accumulatedText: string;
  error?: { code: string; message: string; retryable: boolean };
  startedAt: string;
  completedAt?: string;
  abortController: AbortController;
  listeners: Set<(event: ChatEvent) => void>;
  finalResult?: {
    citations: Citation[];
    sources: Source[];
  };
}

class RunManager {
  private runs = new Map<string, ActiveRun>();

  /**
   * Look up the active or latest run for a given conversation.
   */
  public getRun(conversationId: string): ActiveRun | undefined {
    return this.runs.get(conversationId);
  }

  /**
   * Return a summary map of all currently running tasks.
   */
  public getAllActiveRuns(): Record<
    string,
    {
      conversationId: string;
      status: 'running';
      phase: ChatPhase | null;
      startedAt: string;
      accumulatedText: string;
    }
  > {
    const activeMap: Record<string, any> = {};
    for (const [convId, run] of this.runs.entries()) {
      if (run.status === 'running') {
        activeMap[convId] = {
          conversationId: convId,
          status: 'running',
          phase: run.phase,
          startedAt: run.startedAt,
          accumulatedText: run.accumulatedText,
        };
      }
    }
    return activeMap;
  }

  /**
   * Subscribe a listener function to events for a specific conversation run.
   * Returns an unsubscribe function.
   */
  public subscribe(
    conversationId: string,
    listener: (event: ChatEvent) => void
  ): () => void {
    const run = this.runs.get(conversationId);
    if (!run) return () => {};

    run.listeners.add(listener);
    return () => {
      run.listeners.delete(listener);
    };
  }

  /**
   * Start a new agent background run for a conversation.
   * Runs independently of any individual HTTP request, allowing page reloads
   * and thread switching without dropping the generation task.
   */
  public startRun(options: {
    conversationId: string;
    userMessageId: string;
    assistantMessageId: string;
    preparedInput: PreparedAgentMessages;
    providerConfig?: ClientProviderConfig;
    timezone: string;
    initialSubscriber?: (event: ChatEvent) => void;
  }): ActiveRun {
    const {
      conversationId,
      userMessageId,
      assistantMessageId,
      preparedInput,
      providerConfig,
      timezone,
      initialSubscriber,
    } = options;

    // If an existing run is currently running for this conversation, cancel it first
    const existing = this.runs.get(conversationId);
    if (existing && existing.status === 'running') {
      existing.abortController.abort();
      existing.status = 'aborted';
    }

    const abortController = new AbortController();
    const listeners = new Set<(event: ChatEvent) => void>();
    if (initialSubscriber) {
      listeners.add(initialSubscriber);
    }

    const run: ActiveRun = {
      runId: randomUUID(),
      conversationId,
      userMessageId,
      assistantMessageId,
      status: 'running',
      phase: 'retrieving_history',
      accumulatedText: '',
      startedAt: new Date().toISOString(),
      abortController,
      listeners,
    };

    this.runs.set(conversationId, run);

    // Persist placeholder assistant message in SQLite with 'interrupted' status
    // so if the server crashes unexpectedly, state matches specification constraints
    try {
      insertMessage({
        id: assistantMessageId,
        conversation_id: conversationId,
        role: 'assistant',
        content: '',
        status: 'interrupted',
      });
    } catch (err) {
      console.warn('Could not insert placeholder assistant message:', err);
    }

    // Helper to broadcast events to all registered listeners
    const broadcast = (event: ChatEvent) => {
      for (const listener of run.listeners) {
        try {
          listener(event);
        } catch (err) {
          console.warn('Listener error in runManager broadcast:', err);
        }
      }
    };

    // Execute background worker
    (async () => {
      try {
        // Emit initial start event
        broadcast({
          type: 'start',
          conversationId,
          userMessageId,
        });

        // Emit initial status
        broadcast({
          type: 'status',
          phase: 'retrieving_history',
        });

        const agentResult: AgentRunResult = await runAgent(
          preparedInput,
          assistantMessageId,
          {
            onStatus: (phase) => {
              if (run.status !== 'running') return;
              run.phase = phase;
              broadcast({ type: 'status', phase });
            },
            onDelta: (text) => {
              if (run.status !== 'running') return;
              run.accumulatedText += text;
              broadcast({ type: 'delta', text });
            },
          },
          abortController.signal,
          providerConfig
        );

        if (abortController.signal.aborted) {
          run.status = 'aborted';
          updateMessage(assistantMessageId, {
            content: run.accumulatedText,
            status: 'interrupted',
          });
          return;
        }

        if (!agentResult.success || !agentResult.normalized) {
          run.status = 'failed';
          run.error = {
            code: agentResult.errorCode || 'MODEL_REQUEST_FAILED',
            message: agentResult.errorMessage || 'Failed to generate agent response.',
            retryable: agentResult.retryable ?? true,
          };

          updateMessage(assistantMessageId, {
            content: run.accumulatedText,
            status: 'failed',
          });

          broadcast({
            type: 'error',
            code: run.error.code,
            message: run.error.message,
            retryable: run.error.retryable,
          });
          return;
        }

        const normalized = agentResult.normalized;
        const nowIso = new Date().toISOString();

        // Persist final assistant response to SQLite
        updateMessage(assistantMessageId, {
          content: normalized.text,
          status: 'complete',
          model: normalized.model || null,
          provider_response_id: normalized.responseId || null,
        });

        const savedCitations = insertCitations(normalized.citations);
        const savedSources = insertSources(normalized.sources);
        touchConversation(conversationId, { timezone });

        run.status = 'completed';
        run.completedAt = nowIso;
        run.accumulatedText = normalized.text;
        run.finalResult = {
          citations: savedCitations,
          sources: savedSources,
        };

        broadcast({
          type: 'complete',
          assistantMessageId,
          citations: savedCitations,
          sources: savedSources,
          createdAt: nowIso,
          timezoneUsed: timezone,
        });
      } catch (err: any) {
        if (abortController.signal.aborted) {
          run.status = 'aborted';
          return;
        }

        run.status = 'failed';
        run.error = {
          code: 'UNEXPECTED_ERROR',
          message: err.message || 'An unexpected error occurred during execution.',
          retryable: true,
        };

        updateMessage(assistantMessageId, {
          content: run.accumulatedText,
          status: 'failed',
        });

        broadcast({
          type: 'error',
          code: run.error.code,
          message: run.error.message,
          retryable: true,
        });
      } finally {
        // Retain run state in memory for 3 minutes for reconnecting clients, then clean up
        setTimeout(() => {
          if (this.runs.get(conversationId)?.runId === run.runId) {
            this.runs.delete(conversationId);
          }
        }, 180000);
      }
    })();

    return run;
  }

  /**
   * Cancel an ongoing run for a conversation.
   */
  public cancelRun(conversationId: string): boolean {
    const run = this.runs.get(conversationId);
    if (!run || run.status !== 'running') return false;

    run.abortController.abort();
    run.status = 'aborted';
    try {
      updateMessage(run.assistantMessageId, {
        content: run.accumulatedText,
        status: 'interrupted',
      });
    } catch {}

    for (const listener of run.listeners) {
      try {
        listener({
          type: 'error',
          code: 'USER_CANCELLED',
          message: 'Generation was stopped by user.',
          retryable: false,
        });
      } catch {}
    }

    return true;
  }
}

// Global singleton instance
const globalForRunManager = globalThis as unknown as { runManager?: RunManager };
export const runManager = globalForRunManager.runManager || new RunManager();
if (process.env.NODE_ENV !== 'production') {
  globalForRunManager.runManager = runManager;
}

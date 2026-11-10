# Sift — Architecture & Design Document

## 1. System Architecture

Sift is a conversational research assistant built with Node.js, TypeScript, and Next.js. It connects a user's local conversation history with live web evidence, strictly bounded by the **one-tool rule**: the only tool exposed to the model is `web_search`.

```
User (Browser UI)
      │  (POST /api/chat with clientRequestId, timezone, conversationId)
      ▼
Server API Route (/api/chat)
  ├── 1. Request Validation (Zod, IANA timezone check)
  ├── 2. Conversation & Message Idempotency Storage (SQLite)
  ├── 3. Temporal Resolution (chrono-node + timezone day-boundary calculator)
  ├── 4. History Retrieval (Hybrid SQLite exact-date range + FTS5 BM25 topic search)
  ├── 5. Intent Classifier (Determines search policy: required vs no-search)
  ├── 6. Bounded Input Builder (Formats ISO context + untrusted historical quotes)
  ├── 7. Agent Runtime (OpenAI Responses API with tools: [{ type: "web_search" }])
  ├── 8. Citation & Source Normalizer (Deduplicates URLs, sanitizes schemes, maps offsets)
  └── 9. Event Stream (SSE: start, status, delta, complete, error)
```

## 2. Design Rationale

### 2.1 The One-Tool Rule
The challenge specifies that the agent has exactly one tool: **web search**. Reading past conversations, date calculation, citation extraction, and storage are deterministic application responsibilities executed before and after model invocation. By keeping history retrieval server-side, we:
- Guarantee zero hallucination of nonexistent conversations.
- Prevent model confusion between internal memory tools and external web queries.
- Mark all retrieved historical messages explicitly as untrusted quoted data, defending against indirect prompt injection.

### 2.2 SQLite + FTS5 over Vector Databases
User research queries typically contain explicit temporal cues ("on 3 November", "last Tuesday", "since Monday") and concrete product names ("Postgres hosting", "five CRM tools").
- **Date-indexed B-Tree:** Delivers instant (<5ms) sub-range filtering for exact calendar days in the user's local timezone.
- **SQLite FTS5 with BM25:** Provides transparent lexical matching for domain nouns without the overhead, non-determinism, or operational surface area of embeddings and vector stores.

### 2.3 Deterministic Temporal Boundary Mapping
Naive UTC conversions fail across timezones and Daylight Saving transitions (e.g., converting "Tuesday, 3 November" in Asia/Kolkata or America/New_York). Sift computes exact start-of-day (`00:00:00.000`) and end-of-day (`23:59:59.999`) in the client's declared IANA timezone, then translates them into UTC ISO query bounds before probing the database.

### 2.4 Three Timelines & Honest Verification
For any fact-checking or change-monitoring query, Sift separates:
1. **Conversation Timestamp:** When the user asked or assistant previously responded.
2. **Source Stated Date:** When an official vendor page published or modified an announcement.
3. **Retrieval Timestamp:** When Sift retrieved current web evidence.

If today's pricing page lists a different number than the prior conversation, Sift states that today's page differs from the previous answer—refusing to invent an unverified change date unless dated vendor proof exists.

## 3. Alternatives Considered

| Approach Considered | Why Rejected |
|---|---|
| **Exposing `search_history` as a model tool** | Violates the single-tool constraint; adds latency and risks the model guessing dates or skipping history retrieval. |
| **Vector embeddings (pgvector / Chroma)** | High operational complexity for single-user research archives; semantic similarity often conflates unrelated dates and misranks exact entity names. |
| **Silent fallback search providers (Tavily / Serper)** | Hides failure modes and introduces vendor sprawl. If the primary search fails, Sift informs the user and offers a retry. |
| **Client-side LLM calls** | Leaks secret API keys to the browser bundle and prevents transactional persistence of provenance. |

## 4. What Another Week Would Improve

1. **Explicit Historical Observation Ledger:** Store parsed product/pricing triples `(entity, attribute, value, effective_date, source_id)` extracted during the initial answer to enable automated, structural diffing against future scrapes.
2. **Deterministic Web Diffing & Snapshot Archival:** Cache raw scraped pricing page text alongside consulted URLs to prove exact historical DOM state rather than relying solely on the assistant's previous textual summary.
3. **Multi-User Isolation & Auth:** Add session authentication (e.g. Auth.js) with `owner_id` scoping across all tables and rate-limiting tiers.
4. **Adaptive Context Compaction:** Automatically summarize earlier turns in very long (>50 message) research threads while preserving verbatim excerpts for referenced dates.

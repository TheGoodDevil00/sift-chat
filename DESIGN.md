# Sift Architecture & Design

## 1. How It Works

Sift is a temporal research assistant that answers questions against real conversation history and verifies current state against the live web. It connects local conversation archives with live web evidence under a strict **one-tool constraint**: the only tool exposed to the model is `web_search`.

```
User Query + Timezone
      │  (POST /api/chat with clientRequestId, timezone, conversationId)
      ▼
Server API Route (/api/chat)
  ├── 1. Request Validation (Zod schema, IANA timezone verification)
  ├── 2. Deterministic Temporal Resolution (chrono-node + calendar boundary calculator)
  ├── 3. Bounded History Retrieval (SQLite B-Tree date index + FTS5 BM25 lexical ranking)
  ├── 4. Search Policy & Intent Router (change_monitoring | freshness_check | entity_research | general_chat)
  ├── 5. Bounded Input Builder (Prompt injection defense; <= 1,200 token history budget)
  ├── 6. Single-Tool ReAct Runtime (Multi-provider LLM + web_search with deep scraping fallback)
  ├── 7. Canonical Citation Normalizer (Strict URL grounding against consulted evidence)
  └── 8. SSE Event Stream (Phased status indicators, delta streaming, and provenance metadata)
```

1. **Temporal Resolution:** The server parses temporal cues ("Monday", "3 November", "last Tuesday") in the client's declared IANA timezone, calculating exact start-of-day (`00:00:00.000`) and end-of-day (`23:59:59.999`) UTC timestamps. Point-in-time recall queries resolve strictly to that day; interval expansion is reserved for ongoing time ranges.
2. **Two-Tier History Retrieval:** Sift queries local SQLite using bounded B-Tree date filtering and FTS5 BM25 lexical ranking. For pure recall queries (e.g. *"What did I ask on 3 November?"* where terms are calendar meta-words), FTS is bypassed to prevent unrelated messages from poisoning the candidate set. For topic queries, a relevance floor scoped to the window drops noise chatter while preserving matched turns and paired Q&A context within a strict 1,200-token cap.
3. **Intent-Driven ReAct Execution:** Queries marked as volatile (e.g. tool pricing, software releases) require live verification. The runner exposes only `web_search`, cascading from neural semantic search (Exa) to headless Chromium JS extraction (Firecrawl) down to keyless DuckDuckGo with deep plain-fetch scraping.
4. **Strict Grounding & Streaming:** Citations are extracted from markdown links and bare URLs, deduplicated by canonical form, and verified against URLs actually consulted during tool calls. If no memory exists, an honest fallback notice is injected rather than confabulating.

---

## 2. Why I Built It This Way

- **The One-Tool Constraint as an Architectural Principle:** History retrieval, calendar math, and citation validation are deterministic systems-engineering tasks, not LLM tool calls. Keeping them server-side eliminates tool-selection latency, prevents the model from confabulating nonexistent history, and marks historical messages as untrusted data to defend against prompt injection.
- **Deterministic B-Tree + BM25 over Dense Vectors:** Research queries hinge on exact calendar boundaries ("on Monday") and concrete product names ("Postgres hosting", "HubSpot"). Dense embeddings frequently conflate distinct dates and misrank exact nouns. SQLite B-Tree date range queries (<5ms) combined with BM25 lexical matching provide instant, transparent, and reproducible recall with zero external vector infrastructure.
- **Relevance Floor Scoped to the Temporal Window:** In real-world chat archives, a user might have 25 unrelated messages on a single day. A naive date lookup grabs the first N chronological turns and truncates the rest, hiding the actual shortlist. Sift scopes the relevance floor to the window: topic-relevant messages survive, noise chatter is dropped, and adjacent Q&A pairs (containing baseline answers) are preserved.
- **Enforced Search & Bounded Context:** A prompt instruction is not an architecture. When volatile state is detected, the runner buffers the initial model output; if the model attempts to answer without calling `web_search`, a corrective turn forces retrieval before any token reaches the user. Context is capped at 1,200 history tokens and 800 characters per excerpt to prevent latency degradation.

---

## 3. What was Considered and Rejected

| Approach Considered | Why Rejected |
|---|---|
| **Exposing `search_history` as an LLM tool** | Violates the single-tool constraint; adds unnecessary round-trips and invites the model to guess dates or skip history retrieval entirely. |
| **Vector database (pgvector / Chroma / Pinecone)** | High operational complexity for a local desktop archive. Dense vector cosine similarity performs poorly for exact point-in-time date filtering and often retrieves semantically similar chatter from the wrong week. |
| **Unbounded date intervals ("since Monday" = 7 days)** | Expanding point-in-time queries into multi-day intervals floods the prompt with noise chatter, pushing out the actual decision turn under realistic conversation loads. |
| **Domain-level citation matching** | Accepting `supabase.com` when only `supabase.com/pricing` was consulted allows the model to hallucinate unverified URLs. Sift enforces canonical URL matching against pages actually retrieved. |
| **Client-side LLM calls** | Exposes private API keys in browser network traffic and prevents transactional persistence of query provenance on the server. |

---

## 4. What I'd Do with Another Week

1. **Structured Observation Ledger:** Parse and persist structured entity-attribute-value triples `(entity, attribute, value, effective_date, source_url)` during each response. Future change-monitoring turns could perform deterministic AST/JSON diffs against new scrapes rather than relying solely on LLM prose comparison.
2. **Deterministic DOM Snapshotting & Visual Diffs:** Archive the raw markdown/HTML snapshots of consulted pricing pages with content-hash fingerprints, allowing Sift to display an interactive, side-by-side visual diff of pricing changes over time.
3. **Multi-User Isolation & Auth:** Add session-based authentication (Auth.js) with `user_id` foreign-key scoping across all SQLite tables and hardware-encrypted client key vaults.
4. **Hierarchical Context Compaction:** Implement recursive background summarization for research threads exceeding 50 turns while retaining verbatim quotes for timestamped decision turns.

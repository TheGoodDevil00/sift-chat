# Sift — Architecture

Sift is a Next.js chat agent with a deliberately small model surface: the model
gets exactly one tool, `web_search`. Everything that has to be exact — calendar
math, history lookup, search enforcement, citation grounding, persistence — is
deterministic server code.

## 1. System context

```mermaid
flowchart LR
    subgraph Browser
        UI["Chat UI<br/>Next.js client components"]
        Vault["Provider key vault<br/>AES-GCM in localStorage"]
    end

    subgraph Server["Node.js / Next.js server"]
        ChatAPI["POST /api/chat"]
        StreamAPI["GET /api/chat/stream<br/>GET /api/runs<br/>POST /api/chat/cancel"]
        Runs["Run manager<br/>in-process background runs"]
        Memory["Temporal resolver +<br/>history retrieval"]
        Runner["Agent runner<br/>one tool: web_search"]
        Cite["Citation and source<br/>normalizer"]
        DB[("SQLite (WAL)<br/>messages, conversations,<br/>sources, citations, FTS5")]
    end

    subgraph External["External services"]
        Model["Model provider<br/>OpenAI, Anthropic, Gemini,<br/>Cohere, Groq, DeepSeek, xAI,<br/>OpenRouter, Ollama, LM Studio"]
        Search["Search cascade<br/>Exa → Firecrawl → Tavily →<br/>DuckDuckGo keyless"]
        Scrape["Deep scrape<br/>Firecrawl or guarded fetch"]
    end

    UI -->|"message, timezone,<br/>clientRequestId, providerConfig"| ChatAPI
    Vault -.->|"key for this turn only"| ChatAPI
    ChatAPI --> Memory
    Memory --> DB
    ChatAPI --> Runs
    Runs --> Runner
    Runner --> Model
    Runner -->|"web_search tool call"| Search
    Search --> Scrape
    Runner --> Cite
    Cite --> DB
    Runs -->|"SSE: start, status,<br/>delta, complete, error"| UI
    UI -->|"reconnect / poll"| StreamAPI
    StreamAPI --> Runs
```

Keys entered in the browser are encrypted at rest and sent only inside the
request that needs them. Server-side `.env` keys are never combined with a
client-supplied base URL.

## 2. Request lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant A as /api/chat
    participant D as SQLite
    participant M as Temporal + history
    participant R as Agent runner
    participant P as Model provider
    participant S as Search tool

    B->>A: POST message + clientRequestId + timezone
    A->>A: Zod validation, IANA timezone check
    A->>D: look up clientRequestId
    alt duplicate request
        A->>D: load stored assistant turn
        A-->>B: replay start + complete (no model call)
    else new request
        A->>D: insert user turn
        A->>M: resolve date reference + retrieve history
        M->>D: date bounds, FTS5 BM25, pair turns
        M-->>A: excerpts, confidence, missing-topic note
        A->>R: start background run
        A-->>B: SSE start + status
        R->>P: system prompt + history + user turn + web_search schema
        P-->>R: tool_call web_search
        R->>S: execute query (cascade)
        S-->>R: evidence with URLs, snippets, timestamps
        R->>P: tool result
        P-->>R: answer text
        R->>R: enforce search policy, ground citations
        R->>D: persist assistant + sources + citations
        R-->>B: delta stream + complete
    end

    Note over B,R: A reload can GET /api/chat/stream and replay the<br/>still-running run instead of starting a second one.
```

Search enforcement is part of the runner, not just the prompt:

- If the turn is volatile and no `web_search` call happened, the first answer is
  buffered, the model gets one corrective turn, and a second refusal returns an
  explicit verification failure.
- A search that returns no evidence appends a visible caveat instead of letting
  an unverified answer look sourced.

## 3. History retrieval

A resolved date is the primary constraint. Topic terms rank evidence inside that
window; they do not get to veto it.

```mermaid
flowchart TD
    Q["User query"] --> T["Resolve temporal reference<br/>(chrono-node + calendar/rolling rules)"]
    T -->|"explicit date or range"| W["Date-window candidates<br/>(timezone-correct UTC bounds)"]
    T -->|"no date"| F["FTS5 BM25 candidates<br/>+ adjacent turns"]

    W --> H{"Any topic hit<br/>inside the window?"}
    H -->|"yes"| K["Keep matching turns and their<br/>paired question/answer;<br/>drop unrelated same-day chatter"]
    H -->|"no"| A["Keep the whole window<br/>confidence: medium"]

    F --> G{"Any topic hit<br/>in the archive?"}
    G -->|"yes"| S["Keep hits + paired context"]
    G -->|"no"| N["No evidence"]

    K --> P["Rank, deduplicate,<br/>pack into <=1200 tokens"]
    A --> P
    S --> P
    N --> P
```

Why the floor is window-scoped: users paraphrase. A Tuesday conversation may
only say “Neon and Supabase”, so “Postgres hosting” must not delete Tuesday just
because the word `Postgres` appears in a September chat. Conversely, when the
window *does* contain a lexical anchor, same-day noise is still filtered.

Pairs are registered even when the neighbour is already a candidate, so the
assistant turn holding the baseline price survives the floor alongside its
question.

## 4. Search and scraping

```mermaid
flowchart LR
    Q["web_search query"] --> E{"EXA_API_KEY?"}
    E -->|"yes"| Exa["Exa searchAndContents<br/>neural search + highlights"]
    E -->|"no"| FC{"FIRECRAWL_API_KEY?"}
    Exa -->|"empty"| FC
    FC -->|"yes"| Fire["Firecrawl /v1/search<br/>rendered markdown"]
    FC -->|"no"| TV{"TAVILY_API_KEY?"}
    Fire -->|"empty"| TV
    TV -->|"yes"| Tav["Tavily advanced search"]
    TV -->|"no"| DDG["DuckDuckGo HTML<br/>keyless fallback"]
    Tav -->|"empty"| DDG

    Exa --> Ev["Evidence<br/>title, URL, snippet, dates"]
    Fire --> Ev
    Tav --> Ev
    DDG --> Ev
    Ev --> DS["Deep scrape top result<br/>if content is thin"]
    DS --> Guard["isSafeRemoteUrlResolved<br/>+ manual redirects"]
```

Search works without search-provider keys. It does not work without one model
provider — cloud key, Ollama, or an LM Studio-compatible endpoint.

## 5. Security boundaries

```mermaid
flowchart TD
    U["URL from search result<br/>or model tool call"] --> V{"HTTP(S), no credentials,<br/>public host literal?"}
    V -->|"no"| X["Reject: no fetch,<br/>no evidence, no citation"]
    V -->|"yes"| DNS{"DNS resolves only<br/>public addresses?"}
    DNS -->|"no"| X
    DNS -->|"yes"| FETCH["Fetch with redirect: manual"]
    FETCH --> R3{"3xx?"}
    R3 -->|"yes, <=3 hops"| V
    R3 -->|"no"| BODY["Extract content"]
```

- Loopback, private, CGNAT, link-local, multicast, metadata hosts, `.internal`,
  `.local`, and IPv4-mapped IPv6 forms are rejected before any connection.
- Redirects are followed manually so each hop is re-validated; `fetch` never
  follows a public URL into the host's own network.
- Custom provider base URLs are separate: remote endpoints must be HTTPS and
  public, local providers may only use loopback, and a custom base URL requires
  the caller to supply its own key so a server key is never exfiltrated.

## 6. Data model and streaming

```mermaid
erDiagram
    CONVERSATIONS ||--o{ MESSAGES : contains
    MESSAGES ||--o{ MESSAGE_SOURCES : cites
    MESSAGES ||--o{ MESSAGE_CITATIONS : annotates
    MESSAGES ||--|| MESSAGES_FTS : indexes

    CONVERSATIONS {
        text id PK
        text title
        text timezone
        text created_at
        text updated_at
        text deleted_at
    }
    MESSAGES {
        text id PK
        text conversation_id FK
        text role
        text content
        text client_request_id UK
        text status
        text model
        text created_at
    }
    MESSAGE_SOURCES {
        text id PK
        text message_id FK
        text url
        text canonical_url
        text title
        text retrieved_at
        text source_metadata_json
    }
    MESSAGE_CITATIONS {
        text id PK
        text message_id FK
        text url
        text canonical_url
        int start_index
        int end_index
    }
```

The SSE contract is `start`, `status`, `delta`, `complete`, `error`. Runs live in
the process; a browser that reloads reconnects to `GET /api/chat/stream`, which
replays buffered events and continues streaming. `POST /api/chat/cancel` aborts
the active run for a conversation. Only one run per conversation is allowed.

## 7. What is deliberately not here

- No embeddings or vector database. Retrieval is lexical plus date bounds:
  deterministic, fast, and debuggable for the temporal questions this agent is
  built for.
- No model-side memory tool. History is retrieved before the model runs, so the
  model cannot invent a conversation or a date.
- No multi-user auth. The app is a single-user local workspace; adding owner
  scoping is a deployment concern, not part of the agent design.

# Sift — Conversational Web Research Agent with Temporal Memory

> **Sift remembers the context, checks the present, and shows its evidence.**

Sift is a research assistant for questions whose answers depend on both **what was said before** and **what is true now**. 

Built for the **minimi hiring challenge**, Sift operates under a strict architecture: **the model is equipped with exactly one tool: live web search**. Context retrieval, calendar calculations, and citation tracking are deterministic application responsibilities.

Diagrams of the request lifecycle, retrieval decision tree, search cascade, security boundaries, and data model live in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Key Features

1. **Deterministic Temporal Memory:**
   Resolves conversational references like *"last Tuesday"*, *"on 3 November"*, *"since Monday"*, *"last week"*, and *"in the last two weeks"* using `chrono-node` plus explicit interval rules and the user's browser IANA timezone, calculating exact UTC boundaries without guessing. Calendar phrases (`last week`) and rolling windows (`last two weeks`) are deliberately different.
2. **Relevance-First History Retrieval:**
   Combines calendar day-boundary queries with SQLite FTS5 BM25 topic search. The relevance floor is scoped to the resolved date window: unrelated chatter is filtered, but the day the user named is never deleted just because its wording differs from the query. Packed into a hard context token budget (<=1200 tokens).
3. **Background Runs, Reconnect, and Cancel:**
   A turn runs in a server-side run manager, so navigating away or reloading does not kill it. `GET /api/chat/stream` replays buffered events and continues the live stream; `GET /api/runs` lists active work for the sidebar; `POST /api/chat/cancel` aborts it. Only one run per conversation is allowed.
4. **Multi-Provider Architecture & Live Model Discovery:**
   Supports major providers with live `/models` discovery and function-calling web search:
   - **OpenAI**: `gpt-4o` (default), `gpt-4o-mini`, `o1`, `o3-mini` (Chat Completions tool calling + reasoning effort support)
   - **Anthropic**: `claude-3-5-sonnet-latest`, `claude-3-5-haiku-latest`, `claude-3-opus-latest`
   - **Google Gemini**: `gemini-2.0-flash`, `gemini-1.5-pro` (function declaration tool calling)
   - **Groq**: `llama-3.3-70b-versatile`, `mixtral-8x7b-32768`
   - **DeepSeek**: `deepseek-chat`, `deepseek-reasoner`
   - **xAI (Grok)**: `grok-2-latest`, `grok-beta`
   - **Cohere**: `command-r-plus`, `command-r`
   - **Ollama / Local**: `llama3.2`, `mistral`, etc. (tested with strict 4096 context budget)
   - **OpenRouter**: multi-model gateway with free and paid tiers
5. **Keyless-Ready Search Cascade:**
   Exa neural search → Firecrawl deep DOM extraction → Tavily → DuckDuckGo HTML keyless fallback. Search works without search-provider keys; you still need one model provider (cloud key or a local Ollama/LM Studio endpoint).
6. **Client-Side Key Privacy & Soft Prompt:**
   - Detects whether any keys are configured in the server environment on page load.
   - If no keys exist, displays a non-intrusive soft prompt allowing instant provider and key selection in the dashboard.
   - Keys configured in the dashboard are encrypted in browser storage (AES-GCM) and used only in-memory per request turn. They are never saved to server disk, database, or logs.
7. **Freshness & Change Verification:**
   Differentiates confirmed vendor changes, differences from earlier assistant answers, and "no change found" (without claiming the absence of evidence proves no change occurred).
8. **Clickable Provenance & Citations:**
   Preserves inline annotations and stores the complete ledger of consulted source URLs for every assistant turn.
9. **Enforced Search Policy:**
   The intent classifier does more than add prompt text. When a turn is classified as volatile, the runner refuses to return a model-memory answer: it gives the model one corrective turn to call `web_search`, and if the model still refuses, it returns an explicit verification failure instead of a confident stale answer.
10. **Strict Citation Grounding:**
   Inline citation URLs are accepted only when they match a URL the agent actually retrieved during that turn. Plausible-looking URLs invented by the model, or a different page on a consulted domain, are dropped rather than rendered as evidence.

---

## Architecture Overview

```text
POST /api/chat
  1. Validate request (Zod, IANA timezone)
  2. Check clientRequestId idempotency, persist the user turn (SQLite WAL)
  3. Resolve the date reference into timezone-correct UTC bounds
  4. Retrieve history (date bounds + FTS5 BM25, window-scoped relevance floor)
  5. Classify intent and decide whether search is mandatory
  6. Assemble a bounded prompt (untrusted historical quotes + runtime context)
  7. Run the model with exactly one tool, web_search, enforcing search policy
  8. Ground citations against evidence actually retrieved this turn
  9. Persist the assistant turn, sources, and citations; stream over SSE
```

Full diagrams: [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Getting Started

### Prerequisites

- **Node.js**: v22+ (v26+ supported)
- **npm**: v10+

### 1. Installation

```bash
git clone <repository-url>
cd sift-minimi-task
npm install
```

### 2. Environment Configuration (Optional)

You can provide keys in `.env` OR configure them directly in the browser UI at runtime:

```bash
cp .env.example .env
```

The file is authoritative; the short version:

```dotenv
# Model provider: at least one of these (or a local Ollama / LM Studio endpoint)
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
DEEPSEEK_API_KEY=
XAI_API_KEY=
COHERE_API_KEY=
GROQ_API_KEY=
OPENROUTER_API_KEY=

# Optional search providers; the agent falls back to a keyless DuckDuckGo path
EXA_API_KEY=
FIRECRAWL_API_KEY=
TAVILY_API_KEY=

DATABASE_PATH=./data/sift.sqlite
```

> **Dashboard keys:** If no server key is configured, a soft prompt lets you pick a provider and paste a key in the browser. Keys are encrypted at rest with AES-GCM-256 in `localStorage` and sent only for the request that uses them — never written to the server database or logs.

### 3. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) or [http://localhost:3000/chat-rsc](http://localhost:3000/chat-rsc).

---

## Security & Correctness Invariants

- **Server keys never go to a client-chosen endpoint.** A custom base URL requires the caller to supply its own provider key. This is checked before the server resolves any `.env` key.
- **Endpoint validation:** remote custom endpoints must use HTTPS and may not target loopback, private, link-local, or metadata addresses. Local providers (`ollama`, `local`) may only use a loopback endpoint.
- **Search is enforced, not requested.** See feature 9 above.
- **Citations are grounded, not merely well-formed.** See feature 10 above.
- **Outbound fetches are restricted to public hosts.** Search results and deep-scrape URLs must be HTTP(S) and resolve to a non-loopback, non-private, non-link-local host; redirects are followed manually and each hop is validated, so a public URL cannot bounce the server to an internal address.
- **Idempotent retries:** duplicate `clientRequestId` submissions replay the stored assistant reply (or attach to the still-running background run) instead of starting a second model call.
- **Hidden reasoning is not a product surface.** Model reasoning tokens may influence the answer, but they are not streamed to the browser or stored in the database.

---

## Commands

| Command | Description |
|---|---|
| `npm run dev` | Start development server on port 3000 |
| `npm test` | Run the hermetic unit and integration test suite via Vitest |
| `npm run eval` | Run the deterministic memory/intent evaluation cases |
| `npm run eval:e2e` | Run live agent-output evals (requires `OPENAI_API_KEY`) |
| `npm run typecheck` | Run TypeScript type checking (`tsc --noEmit`) |
| `npm run lint` | Run ESLint check |
| `npm run build` | Build optimized production bundle |
| `npm start` | Start production server |

Live provider tests are opt-in: set `RUN_LIVE_TESTS=1` for the live search test and `OLLAMA_LIVE=1` (plus a running Ollama instance) for the local-model test.

---

## Known Limitations

- Retrieval is lexical (FTS5 + date bounds), not embedding-based. It is fast and deterministic; when a named date window shares no vocabulary with the query, the whole window is returned and confidence is reported as `medium` rather than pretending a lexical match exists.
- Active runs live in the server process. A restart loses in-flight generations, though persisted turns and citations are unaffected.
- The verification report is model-produced and validated structurally (status vocabulary, HTTP(S) sources, table escaping), not fact-checked by a second model in the request path.
- The app is single-user with no authentication or multi-tenant isolation. It is built to run locally, not as a public multi-tenant service.
- Deep scraping is best-effort: a page that blocks fetches or returns only client-rendered HTML may yield a thinner excerpt, and search snippets remain the fallback.
- The live E2E judge is a smoke test for answer quality; the deterministic suite primarily tests memory, intent, grounding, idempotency, and security invariants.

---

## License

MIT

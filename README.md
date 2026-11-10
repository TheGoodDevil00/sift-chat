# Sift — Conversational Web Research Agent with Temporal Memory

> **Sift remembers the context, checks the present, and shows its evidence.**

Sift is a research assistant for questions whose answers depend on both **what was said before** and **what is true now**. 

Built for the **minimi hiring challenge**, Sift operates under a strict architecture: **the model is equipped with exactly one tool: live web search**. Context retrieval, calendar calculations, and citation tracking are deterministic application responsibilities.

---

## Key Features

1. **Deterministic Temporal Memory:**
   Resolves conversational references like *"last Tuesday"*, *"on 3 November"*, or *"since Monday"* using `chrono-node` and the user's browser IANA timezone, calculating exact UTC day boundaries without guessing.
2. **Hybrid History Retrieval:**
   Combines calendar-range queries with SQLite FTS5 BM25 full-text keyword search across prior conversation turns.
3. **Multi-Provider & Latest 2026 Models:**
   First-class support across 8 major providers:
   - **OpenAI**: `gpt-6-astra` (default), `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` (Responses API with built-in search)
   - **Anthropic**: `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`, `claude-fable-5-2`
   - **Google Gemini**: `gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro-preview` (native Google Search grounding)
   - **DeepSeek**: `deepseek-flash` (V4.1 Flash), `deepseek-v4-pro`, `deepseek-chat`, `deepseek-reasoner` (`api.deepseek.com`)
   - **xAI (Grok)**: `grok-4.7`, `grok-4.7-latest`, `grok-3` (`api.x.ai/v1`)
   - **Cohere**: `command-a-plus-05-2026`, `command-a-03-2025`, `command-r7b-12-2024` (`cohere-ai` v2)
   - **Groq**: `llama-3.3-70b-versatile`, `mixtral-8x7b-32768`
   - **OpenRouter**: multi-model gateway (`openai/gpt-5.6-sol`, `anthropic/claude-sonnet-5-5`, etc.)
4. **Client-Side Key Privacy & Soft Prompt:**
   - Detects whether any keys are configured in the server environment on page load.
   - If no keys exist, displays a non-intrusive soft prompt allowing instant provider and key selection in the dashboard.
   - Keys configured in the dashboard are saved **strictly client-side in browser `localStorage`** and used only in-memory per request turn. They are never saved to server disk, database, or logs.
5. **Freshness & Change Verification:**
   Differentiates confirmed vendor changes, differences from earlier assistant answers, and "no change found" (without claiming the absence of evidence proves no change occurred).
6. **Clickable Provenance & Citations:**
   Preserves inline annotations and stores the complete ledger of consulted source URLs for every assistant turn.

---

## Architecture Overview

```
Client (Next.js / chat-rsc Monospace UI)
      │  LocalStorage: Client Keys (Optional)
      ▼  POST /api/chat { conversationId, message, timezone, clientRequestId, providerConfig }
API Route (/api/chat)
  ├── 1. Request Validation (Zod, IANA timezone verification)
  ├── 2. Persistence & Idempotency Key Check (SQLite WAL)
  ├── 3. Temporal Resolution (chrono-node + timezone day boundaries)
  ├── 4. History Retrieval (SQLite date bounds + FTS5 BM25 search)
  ├── 5. Intent Classifier (Determines search policy: required vs no-search)
  ├── 6. Bounded Prompt Assembly (Untrusted historical quotes + runtime context)
  ├── 7. Multi-Provider Agent Runtime (OpenAI, Anthropic, Gemini, DeepSeek, xAI, Cohere, Groq, OpenRouter)
  ├── 8. Citation & Source Normalization (Deduplication, scheme sanitation)
  └── 9. SSE Streaming (start, status, delta, complete, error)
```

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

```dotenv
# Configure any of your preferred providers:
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
DEEPSEEK_API_KEY=
XAI_API_KEY=
COHERE_API_KEY=
GROQ_API_KEY=
OPENROUTER_API_KEY=

DATABASE_PATH=./data/sift.sqlite
```

> **Client-Side Dashboard Keys:** When you open Sift, if no keys are in `.env`, a soft prompt appears where you can select your provider and enter your API key. Keys entered in the UI are stored strictly in `localStorage` on your machine.

### 3. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) or [http://localhost:3000/chat-rsc](http://localhost:3000/chat-rsc).

---

## Commands

| Command | Description |
|---|---|
| `npm run dev` | Start development server on port 3000 |
| `npm test` | Run complete unit and integration test suite via Vitest |
| `npm run eval` | Run the challenge evaluation runner on core scenarios |
| `npm run typecheck` | Run TypeScript type checking (`tsc --noEmit`) |
| `npm run lint` | Run ESLint check |
| `npm run build` | Build optimized production bundle |
| `npm start` | Start production server |

---

## License

MIT

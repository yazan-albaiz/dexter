# Dexter

Financial AI agent CLI for deep equity research. Bun + TypeScript + LangChain + pi-tui.

## Quick Start

```bash
bun install
bun run dev          # CLI with hot reload
bun run start        # CLI
bun run gateway      # WhatsApp gateway (tsx)
bun run login        # ChatGPT OAuth login
bun run typecheck    # tsc --noEmit
bun test             # Run tests
```

## Architecture

### Entry Flow

`src/index.tsx` (dotenv + login subcommand) -> `src/cli.ts` (`runCli()` TUI) -> `AgentRunnerController` -> `Agent.create()` -> ReAct loop via `agent.run()` async generator.

### Provider System (`src/providers.ts`)

Single `PROVIDERS` array of `ProviderDef`. Nine providers: openai, anthropic, google, xai, moonshot, deepseek, openrouter, chatgpt (OAuth), ollama. `resolveProvider(modelName)` does prefix matching. Default model: `gpt-5.4`.

### LLM Dispatch (`src/model/llm.ts`)

- All non-ChatGPT providers: `getChatModel()` -> LangChain factory -> `callLlm()` with 3-retry exponential backoff
- ChatGPT OAuth: `callLlmResponses()` in `src/model/responses-api.ts` -> SSE to `chatgpt.com/backend-api/codex/responses`
- Anthropic calls set `cache_control: ephemeral` on system prompt for prompt caching
- `CallLlmOptions`: `{ model, systemPrompt, outputSchema, tools, toolChoice?: 'auto' | 'required', signal }`

### Tool System (`src/tools/registry.ts`)

`getToolRegistry(model)` assembles tools conditionally:

**Always:** `financial_search`, `financial_metrics`, `read_filings`, `web_fetch`, `browser`, `read_file`, `write_file`, `edit_file`, `heartbeat`, `memory_search`, `memory_get`, `memory_update`

**Conditional:** `web_search` (Exa > Perplexity > Tavily > ChatGPT OAuth fallback), `x_search` (needs X_BEARER_TOKEN), `skill` (if SKILL.md files found)

### Finance Data (`src/tools/finance/`)

Two-path dispatch based on `FINANCIAL_DATASETS_API_KEY`:
- **Set:** financialdatasets.ai paid API (`src/tools/finance/api.ts`)
- **Unset:** Yahoo Finance (`yahoo-api.ts`) + SEC EDGAR (`edgar-api.ts`)

Three meta-tools route to sub-tools via LLM with `toolChoice: 'required'`:
- `financial_search` — stock prices, news, insider trades, segments, crypto
- `financial_metrics` — fundamentals, key ratios, estimates
- `read_filings` — SEC filing metadata + content

Parallel sub-tool execution capped at 5 concurrent (`parallelLimit`).

### Agent Core (`src/agent/`)

- `Agent` — ReAct loop as AsyncGenerator<AgentEvent>. Calls LLM with tools, executes tool calls, rebuilds prompt with results, handles context overflow
- `Scratchpad` — append-only JSONL in `.dexter/scratchpad/`. In-memory context clearing without modifying file
- `AgentToolExecutor` — tool approval (`write_file`/`edit_file`), progress channels, result recording
- `buildSystemPrompt()` — injects SOUL.md, channel profile, tool descriptions, memory context, skill metadata

### Memory (`src/memory/`)

SQLite-backed (better-sqlite3) hybrid search: vector similarity (0.7 weight) + BM25 FTS (0.3). Files in `.dexter/memory/`. Embedding auto-detection: OpenAI > Gemini > Ollama. Pre-compaction flush saves research context via `runMemoryFlush()`.

### Skills (`src/skills/`)

SKILL.md files with YAML frontmatter. Discovered from `src/skills/` (builtin) and `.dexter/skills/` (user). Built-in: `dcf` (DCF valuation), `x-research` (X/Twitter research).

### WhatsApp Gateway (`src/gateway/`)

Separate process via tsx. Baileys for WhatsApp protocol. Multi-account, session-based agent runners, group chat mention detection, heartbeat scheduler, outbound allowlist.

## Key Conventions

- **Runtime:** Bun (not Node). Use `bun run`, `bun test`, `bun install`
- **Module:** ESNext ESM with bundler resolution. Path alias `@/*` -> `./src/*`
- **JSX:** react-jsx (for pi-tui terminal components in .tsx files)
- **Schema:** Zod v4 (not v3). Zod v4 internals differ: `_def.type` not `typeName`, `_def.entries` for enums, `_def.innerType` for optional/default
- **Runtime data:** All in `.dexter/` (gitignored). Settings, memory, scratchpads, OAuth tokens, logs
- **Version scheme:** CalVer (e.g., `2026.3.8`)

## Important Gotchas

- **yahoo-finance2 v3 is a class:** `new YahooFinance()`, not default export. All calls need `validateResult: false` (Yahoo returns partial data for many symbols)
- **`zod-to-json-schema` broken with Zod v4:** Use custom `zodV4ToJsonSchema` in `responses-api.ts`
- **`quoteSummary` financial statements deprecated** (no data since Nov 2024): Use `fundamentalsTimeSeries` for income/balance/cashflow. Key ratios + estimates still on `quoteSummary`
- **Responses API format:** `input: [{role, content}]` list, `instructions` top-level (not system message), `stream: true` required, SSE with `response.completed` event
- **ChatGPT OAuth endpoint** is `chatgpt.com/backend-api/codex/responses`, NOT `api.openai.com`. Required headers: `OpenAI-Beta: responses=experimental`, `originator: codex_cli_rs`, `chatgpt-account-id`
- **`toolChoice: 'required'`** is mandatory on router meta-tools or the LLM returns text instead of calling sub-tools
- **Don't auto-inject tools** into Responses API calls. Register explicitly only where needed

## Testing

```bash
bun test                    # All tests
bun test --watch            # Watch mode
bun test <path>             # Specific file
```

Tests use Bun's built-in test runner. Test files live alongside source as `*.test.ts`.

## Environment Variables

See `env.example`. At minimum need one LLM provider key. For free tier: `bun run login` for ChatGPT OAuth (no API key needed).

Finance: `FINANCIAL_DATASETS_API_KEY` for paid data, or leave unset for Yahoo Finance + SEC EDGAR free path.

Search priority: `EXASEARCH_API_KEY` > `PERPLEXITY_API_KEY` > `TAVILY_API_KEY` > ChatGPT OAuth fallback.

# PinLLM — Open-Source LLM Response & Async Artifact Pinning

**PinLLM** is a local-first, zero-dependency open-source tool and library that lets users **pin full LLM responses inside chats** while **asynchronously extracting, indexing, and searching structured artifacts** (code blocks, Mermaid diagrams, Markdown tables, CLI commands, checklists, and architectural decisions).

## Key Features

1. **Instant Full-Response Pinning (`< 5ms`)**:
   - Clicking the **Pin icon** immediately saves the complete, unmodified LLM response Markdown, the user prompt that triggered it, thread URL, and message anchor—zero UI latency.
2. **Two-Stage Asynchronous Artifact Extraction**:
   - **Stage 1 (Deterministic AST Extractor)**: Immediately parses fenced code blocks (with smart filename/symbol inference), Mermaid diagrams, Markdown comparison tables, shell commands, JSON/YAML configs, and action checklists.
   - **Stage 2 (Async Agentic Enrichment)**: Runs non-blocking in the background using either the built-in offline heuristic agent or a connected LLM (`Ollama`, `OpenAI`) to generate a concise title, 1-sentence TL;DR summary, semantic tags, and **implicit prose artifacts** (architectural decisions, callouts, and trade-offs).
3. **Hybrid Dual-Granularity Search (`SQLite FTS5` + `BM25`)**:
   - Search across **Full LLM Responses**, **User Prompts**, and **Individual Extracted Artifacts** simultaneously, with `<mark>` snippet highlighting and facet filtering (`All`, `Full Responses`, `Artifacts Only`, artifact type, language, and platform).
4. **Interactive Web Playground + Cross-Browser Extension**:
   - Includes a full interactive web app (`apps/web`) and an unpacked Manifest V3 browser extension (`apps/extension`) for ChatGPT, Claude, and Gemini.

---

## Quick Start

Requires **Node.js 22.5+ / 24+ / 26+** (uses native TypeScript execution and built-in `node:sqlite` with `FTS5`—zero `npm install` needed!).

```bash
# Run the test suite
npm test

# Start the interactive Web Playground & local SQLite server
npm start
```

Then open **http://localhost:4173** in your browser.

---

## Repository Structure

- `packages/core/` — Core library (`@pinllm/core`)
  - `types.ts` — Data models for `PinnedResponse`, `ExtractedArtifact`, `SearchQuery`, and lifecycle events
  - `extractor.ts` — Stage 1 AST parser & Stage 2 Async Agentic extractor
  - `search.ts` — Hybrid BM25 + snippet highlighting search engine across full responses and artifacts
  - `engine.ts` — `PinEngine` orchestrating synchronous pinning, async background queue, and event subscriptions
  - `sqlite-store.ts` — Persistent `node:sqlite` + `FTS5` full-text index driver
- `apps/web/` — Interactive Web App, Chat Simulator, Live Async Worker Monitor & Search Vault (`server.ts`, `public/`)
- `apps/extension/` — Manifest V3 Browser Extension for ChatGPT, Claude, and Gemini (`manifest.json`, `background.js`, `content.js`)
- `tests/core.test.ts` — Automated test suite

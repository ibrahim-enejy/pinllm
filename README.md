# PinLLM — Open-Source LLM Response & Async Artifact Pinning

**PinLLM** is a free, local-first, open-source browser extension and web tool that lets anyone **pin full LLM responses inside chats** (ChatGPT, Claude, Gemini, DeepSeek, Perplexity) while **asynchronously extracting, indexing, and searching structured artifacts** (code blocks, Mermaid diagrams, Markdown tables, CLI commands, checklists, and architectural decisions).

---

## Install the Free Browser Extension (Chrome, Brave, Edge, Arc, Firefox)

No account, API key, or backend server is required—everything runs locally in your browser.

1. Download **`pinllm-extension.zip`** (from the live web playground, GitHub Releases, or by cloning this repo and selecting `apps/extension`).
2. Open **`chrome://extensions`** (or `brave://extensions` / `edge://extensions`).
3. Toggle **Developer mode** ON in the top-right corner.
4. Click **Load unpacked** and select the **`apps/extension`** folder (or drag-and-drop the unzipped folder).
5. Open **ChatGPT**, **Claude**, **Gemini**, or **DeepSeek**:
   - Every LLM response now has a **📌 Pin Response** button.
   - Click it to save the **full response** immediately while the background worker asynchronously extracts code, Mermaid diagrams, tables, checklists, and key decisions.
   - Press **`Cmd+Shift+P`** (Mac) or **`Ctrl+Shift+P`** (Windows/Linux) — or click the floating **📌 PinLLM** button — to search across all your full responses and extracted artifacts!

---

## Key Features

1. **Instant Full-Response Pinning (`< 5ms`)**:
   - Clicking the **Pin icon** immediately saves the complete, unmodified LLM response Markdown, the user prompt that triggered it, thread URL, and message anchor—zero UI latency.
2. **Two-Stage Asynchronous Artifact Extraction**:
   - **Stage 1 (Deterministic AST Extractor)**: Immediately parses fenced code blocks (with smart filename/symbol inference), Mermaid diagrams, Markdown comparison tables, shell commands, JSON/YAML configs, and action checklists.
   - **Stage 2 (Async Agentic Enrichment)**: Runs non-blocking in the background using either the built-in offline heuristic agent or a connected LLM (`Ollama`, `OpenAI`) to generate a concise title, 1-sentence TL;DR summary, semantic tags, and **implicit prose artifacts** (architectural decisions, callouts, and trade-offs).
3. **Hybrid Dual-Granularity Search (`SQLite FTS5` + `BM25`)**:
   - Search across **Full LLM Responses**, **User Prompts**, and **Individual Extracted Artifacts** simultaneously, with `<mark>` snippet highlighting and facet filtering (`All`, `Full Responses`, `Artifacts Only`, artifact type, language, and platform).

---

## Local Web Playground & SQLite Server

```bash
# Run the automated test suite
npm test

# Package the browser extension zip
npm run package:extension

# Start the interactive Web Playground & local SQLite FTS5 server
npm start
```

Then open **http://localhost:4173** in your browser.

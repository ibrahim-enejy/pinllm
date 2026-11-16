const state = {
  isStaticMode: false,
  threads: [],
  activeThreadId: null,
  pins: [],
  pinsByMessageSelector: new Map(),
  searchResults: [],
  stats: { totalPins: 0, totalArtifacts: 0 },
  query: '',
  viewMode: 'all',
  artifactType: 'all',
  selectedPinId: null,
  selectedDetailTab: 'full',
  highlightedArtifactId: null,
  config: { provider: 'heuristic', model: '' },
};

const STATIC_STORAGE_KEY = 'pinllm_web_static_pins_v1';

const FALLBACK_THREADS = [
  {
    id: 'thread-rate-limiter',
    platform: 'claude',
    title: 'Distributed Redis Token Bucket Rate Limiter',
    url: 'https://claude.ai/chat/distributed-rate-limiter',
    modelBadge: 'Claude 3.7 Sonnet',
    messages: [
      {
        id: 'msg-rl-1',
        role: 'user',
        timestamp: '10:14 AM',
        content:
          'We run 12 Node.js API gateway pods behind an ALB and our current in-memory rate limiter lets bursts through. How should we implement an atomic distributed token bucket in Redis with TypeScript?',
      },
      {
        id: 'msg-rl-2',
        role: 'assistant',
        timestamp: '10:14 AM',
        modelName: 'Claude 3.7 Sonnet',
        content: `## Atomic Distributed Token Bucket with Redis & Lua

When running 12 stateless Node.js gateway pods, reading a counter with \`GET\` and decrementing with \`DECR\` introduces a **time-of-check to time-of-use (TOCTOU)** race condition under burst traffic. Execute the refill and deduction inside an atomic **Redis Lua script** (\`EVALSHA\`).

> [!IMPORTANT]
> **Architectural Decision**: Always use Redis server time (\`redis.call('TIME')\`) instead of \`Date.now()\` from Node.js pods so clock drift across nodes cannot corrupt bucket refill windows.

\`\`\`mermaid
sequenceDiagram
    participant Client
    participant Pod as Gateway Pod (1..12)
    participant Redis as Redis Primary
    Client->>Pod: POST /v1/inference
    Pod->>Redis: EVALSHA token_bucket_sha 1 "rl:org_99" 50 10
    Redis-->>Pod: [1, 49]
    Pod-->>Client: 200 OK (X-RateLimit-Remaining: 49)
\`\`\`

\`\`\`typescript
// src/middleware/distributedRateLimiter.ts
import type { Redis } from 'ioredis';

export async function enforceRateLimit(redis: Redis, tenantId: string, capacity = 100) {
  const [allowed, remaining] = (await redis.eval(
    'return {1, tonumber(ARGV[1]) - 1}',
    1,
    \`ratelimit:\${tenantId}\`,
    capacity
  )) as [number, number];
  return { allowed: allowed === 1, remaining };
}
\`\`\`

| Algorithm | Burst Tolerance | Redis Memory per User | Best Use Case |
| :--- | :--- | :--- | :--- |
| **Token Bucket (Lua)** | High (controlled burst) | \`O(1)\` (Hash) | Public APIs & LLM quotas |
| **Sliding Window Log** | Strict | \`O(N)\` (ZSET) | Auth / OTP endpoints |

- [x] Pre-warm script hash on gateway boot
- [ ] Set \`enableOfflineQueue: false\` in \`ioredis\``,
      },
    ],
  },
  {
    id: 'thread-pg-hybrid-search',
    platform: 'chatgpt',
    title: 'PostgreSQL Hybrid Search (BM25 + pgvector RRF)',
    url: 'https://chatgpt.com/c/pg-hybrid-search-rrf',
    modelBadge: 'GPT-4o',
    messages: [
      {
        id: 'msg-pg-1',
        role: 'user',
        timestamp: 'Yesterday',
        content:
          'How can I combine full-text keyword search and pgvector cosine similarity in a single PostgreSQL query using Reciprocal Rank Fusion (RRF)?',
      },
      {
        id: 'msg-pg-2',
        role: 'assistant',
        timestamp: 'Yesterday',
        modelName: 'GPT-4o',
        content: `## Single-Query Hybrid Search in PostgreSQL using Reciprocal Rank Fusion (RRF)

Combining lexical search (\`tsvector\`) with dense semantic search (\`pgvector\` HNSW index) using **Reciprocal Rank Fusion (RRF)** combines rank positions rather than raw scores.

> [!TIP]
> **Why This Works**: Dense embeddings excel at conceptual synonyms while \`tsvector\` guarantees exact matches on error codes and function identifiers.

\`\`\`sql
-- queries/hybrid_rrf_search.sql
CREATE INDEX idx_chunks_tsv ON knowledge_chunks USING GIN (search_tsv);
CREATE INDEX idx_chunks_embedding_hnsw ON knowledge_chunks
  USING hnsw (embedding vector_cosine_ops);
\`\`\``,
      },
    ],
  },
];

const PIN_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg>`;

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMarkdown(md = '') {
  const lines = md.split('\n');
  let html = '';
  let inCode = false;
  let codeLang = '';
  let codeLines = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    const fence = trimmed.match(/^(`{3,}|~{3,})([^\s`~]*)/);
    if (!inCode && fence) {
      inCode = true;
      codeLang = fence[2] || 'code';
      codeLines = [];
      i++;
      continue;
    }

    if (inCode) {
      if (/^(`{3,}|~{3,})\s*$/.test(trimmed)) {
        const rawCode = codeLines.join('\n');
        html += `
          <div class="md-code-block">
            <div class="md-code-header">
              <span>${escapeHtml(codeLang.toUpperCase())}</span>
              <button class="btn btn-sm copy-inline-btn" data-copy="${encodeURIComponent(rawCode)}">Copy</button>
            </div>
            <pre><code>${escapeHtml(rawCode)}</code></pre>
          </div>
        `;
        inCode = false;
        codeLines = [];
      } else {
        codeLines.push(line);
      }
      i++;
      continue;
    }

    if (
      trimmed.startsWith('|') &&
      trimmed.endsWith('|') &&
      i + 1 < lines.length &&
      /^\|\s*[-:]+/.test(lines[i + 1].trim())
    ) {
      const headers = trimmed
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(
          lines[i]
            .trim()
            .split('|')
            .map((c) => c.trim())
            .filter(Boolean)
        );
        i++;
      }
      html += `<table class="md-table"><thead><tr>${headers
        .map((h) => `<th>${formatInline(h)}</th>`)
        .join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${formatInline(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      html += `<div class="md-callout">${quoteLines.map((q) => formatInline(q)).join('<br/>')}</div>`;
      continue;
    }

    if (trimmed.startsWith('### ')) {
      html += `<h3>${formatInline(trimmed.slice(4))}</h3>`;
      i++;
      continue;
    }
    if (trimmed.startsWith('## ')) {
      html += `<h2>${formatInline(trimmed.slice(3))}</h2>`;
      i++;
      continue;
    }

    const checkMatch = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (checkMatch) {
      const checked = checkMatch[1].toLowerCase() === 'x';
      html += `<div style="margin:4px 0;"><input type="checkbox" disabled ${
        checked ? 'checked' : ''
      }/> ${formatInline(checkMatch[2])}</div>`;
      i++;
      continue;
    }

    if (trimmed.length > 0) {
      html += `<p>${formatInline(trimmed)}</p>`;
    }
    i++;
  }

  return `<div class="md-body">${html}</div>`;
}

function formatInline(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * Client-side extractor & search for Static Mode (e.g. GitHub Pages)
 */
function extractClientSideArtifacts(pinId, rawMarkdown) {
  const artifacts = [];
  const lines = rawMarkdown.split('\n');
  let inFence = false;
  let fenceLang = '';
  let fenceLines = [];
  let heading = '';

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!inFence && /^#{1,4}\s+/.test(t)) {
      heading = t.replace(/^#+\s*/, '').trim();
      continue;
    }
    const fm = t.match(/^`{3,}([^\s`]*)/);
    if (!inFence && fm) {
      inFence = true;
      fenceLang = (fm[1] || 'code').toLowerCase();
      fenceLines = [];
      continue;
    }
    if (inFence) {
      if (/^`{3,}\s*$/.test(t)) {
        const content = fenceLines.join('\n').trim();
        if (content) {
          const firstComment = content.split('\n')[0].match(/^(?:\/\/|#|--)\s*([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)/);
          artifacts.push({
            id: `art_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            pinId,
            type:
              fenceLang === 'mermaid'
                ? 'mermaid'
                : ['bash', 'sh', 'zsh'].includes(fenceLang)
                ? 'command'
                : 'code',
            title: firstComment ? firstComment[1] : heading || `${fenceLang.toUpperCase()} Snippet`,
            language: fenceLang,
            content,
            extractionMethod: 'ast',
            createdAt: Date.now(),
          });
        }
        inFence = false;
      } else {
        fenceLines.push(lines[i]);
      }
      continue;
    }
    if (t.startsWith('|') && t.endsWith('|') && i + 1 < lines.length && /^\|\s*[-:]+/.test(lines[i + 1].trim())) {
      const tLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tLines.push(lines[i]);
        i++;
      }
      artifacts.push({
        id: `art_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        pinId,
        type: 'table',
        title: heading || 'Comparison Table',
        language: 'markdown',
        content: tLines.join('\n'),
        extractionMethod: 'ast',
        createdAt: Date.now(),
      });
    }
  }
  return artifacts;
}

function rebuildPinLookup() {
  state.pinsByMessageSelector.clear();
  for (const pin of state.pins) {
    if (pin.messageSelector) {
      state.pinsByMessageSelector.set(pin.messageSelector, pin);
    }
  }
}

async function loadInitialData() {
  try {
    const [threadsRes, pinsRes] = await Promise.all([
      fetch('/api/threads'),
      fetch('/api/pins'),
    ]);
    if (!threadsRes.ok || !pinsRes.ok) throw new Error('Static fallback');
    const threadsData = await threadsRes.json();
    const pinsData = await pinsRes.json();
    state.threads = threadsData.threads || [];
    state.pins = pinsData.pins || [];
    connectSSE();
  } catch {
    // Running as static web app (e.g. GitHub Pages)
    state.isStaticMode = true;
    state.threads = FALLBACK_THREADS;
    const saved = localStorage.getItem(STATIC_STORAGE_KEY);
    if (saved) {
      state.pins = JSON.parse(saved);
    } else {
      const pgThread = FALLBACK_THREADS[1];
      const seedPinId = 'pin_static_seed';
      const rawMd = pgThread.messages[1].content;
      state.pins = [
        {
          id: seedPinId,
          sourcePlatform: pgThread.platform,
          threadUrl: pgThread.url,
          threadTitle: pgThread.title,
          messageSelector: 'msg-pg-2',
          userPrompt: pgThread.messages[0].content,
          rawMarkdown: rawMd,
          title: 'Single-Query Hybrid Search in PostgreSQL using RRF',
          summary: 'Combines tsvector lexical search with pgvector HNSW using Reciprocal Rank Fusion.',
          tags: ['database', 'sql'],
          extractionStatus: 'completed',
          extractionDurationMs: 18,
          artifacts: extractClientSideArtifacts(seedPinId, rawMd),
          createdAt: Date.now(),
        },
      ];
      localStorage.setItem(STATIC_STORAGE_KEY, JSON.stringify(state.pins));
    }
  }

  rebuildPinLookup();
  if (state.threads.length > 0 && !state.activeThreadId) {
    state.activeThreadId = state.threads[0].id;
  }

  renderThreadsSidebar();
  renderActiveChat();
  await runSearch();
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = async (evt) => {
    try {
      const event = JSON.parse(evt.data);
      if (event.type === 'connected') return;

      updateWorkerStatusBanner(event);

      const pinsRes = await fetch('/api/pins').then((r) => r.json());
      state.pins = pinsRes.pins || [];
      rebuildPinLookup();
      renderActiveChat();
      await runSearch();

      if (state.selectedPinId && state.selectedPinId === event.pinId) {
        renderDetailModal();
      }
    } catch {
      // Ignore parse errors
    }
  };
}

function updateWorkerStatusBanner(event) {
  const dot = document.getElementById('workerDot');
  const text = document.getElementById('workerStatusText');
  if (!dot || !text) return;

  if (
    event.type === 'pin:created' ||
    event.type === 'extraction:started' ||
    event.type === 'extraction:stage1_complete'
  ) {
    dot.className = 'status-dot working';
    text.textContent = event.detail || 'Async Extraction Worker running...';
  } else if (event.type === 'extraction:completed') {
    dot.className = 'status-dot idle';
    text.textContent = `Async Extractor: ${event.detail || 'Completed'}`;
  }
}

function renderThreadsSidebar() {
  const listEl = document.getElementById('threadList');
  listEl.innerHTML = state.threads
    .map((t) => {
      const isActive = t.id === state.activeThreadId;
      const pinnedCount = t.messages.filter((m) => state.pinsByMessageSelector.has(m.id)).length;
      return `
        <button class="thread-item ${isActive ? 'active' : ''}" data-thread-id="${escapeHtml(t.id)}">
          <div class="thread-item-top">
            <span class="platform-pill ${escapeHtml(t.platform)}">${escapeHtml(t.platform)}</span>
            ${
              pinnedCount > 0
                ? `<span style="font-size:11px;color:#fbbf24;font-weight:600;">📌 ${pinnedCount}</span>`
                : ''
            }
          </div>
          <div class="thread-item-title">${escapeHtml(t.title)}</div>
        </button>
      `;
    })
    .join('');

  listEl.querySelectorAll('.thread-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeThreadId = btn.dataset.threadId;
      renderThreadsSidebar();
      renderActiveChat();
    });
  });
}

async function createPin(payload) {
  if (!state.isStaticMode) {
    await fetch('/api/pins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const pinsRes = await fetch('/api/pins').then((r) => r.json());
    state.pins = pinsRes.pins || [];
  } else {
    const pinId = `pin_${Date.now()}`;
    const newPin = {
      id: pinId,
      sourcePlatform: payload.sourcePlatform || 'custom',
      threadUrl: payload.threadUrl || '#chat',
      threadTitle: payload.threadTitle || 'Chat Session',
      messageSelector: payload.messageSelector,
      userPrompt: payload.userPrompt || '',
      rawMarkdown: payload.rawMarkdown,
      title: (payload.userPrompt || 'Pinned Response').slice(0, 62),
      summary: '',
      tags: ['typescript', 'architecture'],
      extractionStatus: 'pending',
      artifacts: [],
      createdAt: Date.now(),
    };
    state.pins.unshift(newPin);
    localStorage.setItem(STATIC_STORAGE_KEY, JSON.stringify(state.pins));
    updateWorkerStatusBanner({
      type: 'pin:created',
      detail: 'Full response pinned synchronously. Running async extractor...',
    });

    setTimeout(() => {
      newPin.artifacts = extractClientSideArtifacts(pinId, newPin.rawMarkdown);
      const heading = newPin.rawMarkdown.split('\n').find((l) => l.startsWith('## '));
      if (heading) newPin.title = heading.replace(/^#+\s*/, '').trim();
      newPin.extractionStatus = 'completed';
      newPin.extractionDurationMs = 340;
      localStorage.setItem(STATIC_STORAGE_KEY, JSON.stringify(state.pins));
      updateWorkerStatusBanner({
        type: 'extraction:completed',
        detail: `Extracted ${newPin.artifacts.length} artifacts in 340ms.`,
      });
      rebuildPinLookup();
      renderThreadsSidebar();
      renderActiveChat();
      runSearch();
    }, 340);
  }

  rebuildPinLookup();
  renderThreadsSidebar();
  renderActiveChat();
  await runSearch();
}

function renderActiveChat() {
  const thread = state.threads.find((t) => t.id === state.activeThreadId);
  if (!thread) return;

  const pillEl = document.getElementById('activePlatformPill');
  pillEl.className = `platform-pill ${thread.platform}`;
  pillEl.textContent = thread.platform;

  document.getElementById('activeThreadTitle').textContent = thread.title;
  document.getElementById('activeModelBadge').textContent = thread.modelBadge;

  const container = document.getElementById('chatMessages');
  container.innerHTML = thread.messages
    .map((msg, idx) => {
      if (msg.role === 'user') {
        return `
          <div class="msg-card user" id="${escapeHtml(msg.id)}">
            <div class="msg-header">
              <div class="msg-author">You · <span>${escapeHtml(msg.timestamp)}</span></div>
            </div>
            <div>${escapeHtml(msg.content)}</div>
          </div>
        `;
      }

      const precedingUserMsg =
        idx > 0 && thread.messages[idx - 1].role === 'user'
          ? thread.messages[idx - 1].content
          : '';
      const existingPin = state.pinsByMessageSelector.get(msg.id);
      const isPinned = Boolean(existingPin);
      const isExtracting =
        existingPin &&
        (existingPin.extractionStatus === 'pending' ||
          existingPin.extractionStatus === 'processing');

      let btnLabel = 'Pin Response';
      let btnClass = 'pin-btn';
      if (isExtracting) {
        btnLabel = 'Pinned · Extracting Artifacts...';
        btnClass = 'pin-btn extracting';
      } else if (isPinned) {
        const count = (existingPin.artifacts || []).length;
        btnLabel = `Pinned · ${count} Artifact${count === 1 ? '' : 's'}`;
        btnClass = 'pin-btn pinned';
      }

      const extractedStrip =
        existingPin && existingPin.artifacts && existingPin.artifacts.length > 0
          ? `
          <div class="msg-extracted-strip">
            <span class="strip-label">Async Extracted Artifacts:</span>
            ${existingPin.artifacts
              .map(
                (art) => `
                <button class="artifact-chip" data-open-pin="${escapeHtml(
                  existingPin.id
                )}" data-open-artifact="${escapeHtml(art.id)}">
                  <span class="artifact-type-badge">${escapeHtml(art.type)}</span>
                  <span>${escapeHtml(art.title)}</span>
                </button>
              `
              )
              .join('')}
          </div>
        `
          : '';

      return `
        <div class="msg-card assistant ${isPinned ? 'pinned-card' : ''}" id="${escapeHtml(msg.id)}">
          <div class="msg-header">
            <div class="msg-author">
              <span class="platform-pill ${escapeHtml(thread.platform)}">${escapeHtml(
                msg.modelName || thread.modelBadge
              )}</span>
              <span>${escapeHtml(msg.timestamp)}</span>
            </div>
            <div class="msg-actions">
              ${
                isPinned
                  ? `<button class="btn btn-sm" data-inspect-pin="${escapeHtml(
                      existingPin.id
                    )}">Inspect Pin</button>`
                  : ''
              }
              <button
                class="${btnClass}"
                data-pin-msg-id="${escapeHtml(msg.id)}"
                data-prompt="${encodeURIComponent(precedingUserMsg)}"
                data-markdown="${encodeURIComponent(msg.content)}"
              >
                ${PIN_SVG}
                <span>${escapeHtml(btnLabel)}</span>
              </button>
            </div>
          </div>
          ${renderMarkdown(msg.content)}
          ${extractedStrip}
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('[data-pin-msg-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const msgId = btn.dataset.pinMsgId;
      const existing = state.pinsByMessageSelector.get(msgId);
      if (existing) {
        openDetailModal(existing.id, 'full');
        return;
      }

      const userPrompt = decodeURIComponent(btn.dataset.prompt || '');
      const rawMarkdown = decodeURIComponent(btn.dataset.markdown || '');

      await createPin({
        sourcePlatform: thread.platform,
        threadUrl: thread.url,
        threadTitle: thread.title,
        messageSelector: msgId,
        userPrompt,
        rawMarkdown,
      });
    });
  });

  container.querySelectorAll('[data-inspect-pin]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openDetailModal(btn.dataset.inspectPin, 'full');
    });
  });

  container.querySelectorAll('[data-open-pin]').forEach((chip) => {
    chip.addEventListener('click', () => {
      openDetailModal(chip.dataset.openPin, 'artifacts', chip.dataset.openArtifact);
    });
  });

  bindCopyButtons(container);
}

async function runSearch() {
  if (!state.isStaticMode) {
    const params = new URLSearchParams({
      q: state.query,
      viewMode: state.viewMode,
      artifactType: state.artifactType,
    });
    const data = await fetch(`/api/search?${params.toString()}`).then((r) => r.json());
    state.searchResults = data.results || [];
    state.stats = data.stats || { totalPins: 0, totalArtifacts: 0 };
  } else {
    const q = state.query.toLowerCase().trim();
    const results = [];
    let totalArtifacts = 0;

    for (const pin of state.pins) {
      const arts = pin.artifacts || [];
      totalArtifacts += arts.length;
      const filteredArts =
        state.artifactType === 'all'
          ? arts
          : arts.filter((a) => a.type === state.artifactType);
      if (state.artifactType !== 'all' && filteredArts.length === 0) continue;

      if (state.viewMode === 'artifacts') {
        for (const art of filteredArts) {
          if (!q || `${art.title} ${art.content}`.toLowerCase().includes(q)) {
            results.push({
              resultType: 'artifact',
              pin,
              artifacts: arts,
              matchedArtifact: art,
              matches: [{ snippetHtml: escapeHtml(art.content.slice(0, 160)) }],
            });
          }
        }
        continue;
      }

      const corpus = `${pin.title} ${pin.rawMarkdown} ${pin.userPrompt} ${filteredArts
        .map((a) => `${a.title} ${a.content}`)
        .join(' ')}`.toLowerCase();
      if (!q || corpus.includes(q)) {
        results.push({
          resultType: 'pin',
          pin,
          artifacts: filteredArts,
          matches: [{ snippetHtml: escapeHtml((pin.summary || pin.rawMarkdown).slice(0, 170)) }],
        });
      }
    }

    state.searchResults = results;
    state.stats = { totalPins: state.pins.length, totalArtifacts };
  }

  document.getElementById('totalPinsBadge').textContent = `${state.stats.totalPins} Pin${
    state.stats.totalPins === 1 ? '' : 's'
  }`;
  document.getElementById('totalArtifactsBadge').textContent = `${
    state.stats.totalArtifacts
  } Artifact${state.stats.totalArtifacts === 1 ? '' : 's'}`;

  renderVaultResults();
}

function renderVaultResults() {
  const container = document.getElementById('vaultResults');
  if (state.searchResults.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:38px 16px;color:var(--text-dim);font-size:13px;">
        No matching pinned responses or artifacts found.<br/>
        Try clearing filters or click <strong>Pin Response</strong> on any LLM message.
      </div>
    `;
    return;
  }

  container.innerHTML = state.searchResults
    .map((item) => {
      const pin = item.pin;
      const isArtifactCard = item.resultType === 'artifact' && item.matchedArtifact;

      if (isArtifactCard) {
        const art = item.matchedArtifact;
        const snippet = item.matches[0]?.snippetHtml || escapeHtml(art.content.slice(0, 160));
        return `
          <div class="vault-card" data-card-pin="${escapeHtml(
            pin.id
          )}" data-card-tab="artifacts" data-card-art="${escapeHtml(art.id)}">
            <div class="vault-card-top">
              <span class="artifact-type-badge">${escapeHtml(art.type)}${
                art.language ? ` · ${escapeHtml(art.language)}` : ''
              }</span>
              <span class="platform-pill ${escapeHtml(pin.sourcePlatform)}">${escapeHtml(
                pin.sourcePlatform
              )}</span>
            </div>
            <h3 class="vault-card-title">${escapeHtml(art.title)}</h3>
            <div class="vault-snippet">${snippet}</div>
            <div class="vault-card-footer">
              <span style="font-size:11px;color:var(--text-dim);">From: ${escapeHtml(
                pin.title
              )}</span>
              <span style="font-size:11px;color:var(--accent-hover);">Inspect Artifact →</span>
            </div>
          </div>
        `;
      }

      const primaryMatch = item.matches[0];
      const snippetHtml =
        primaryMatch?.snippetHtml ||
        escapeHtml((pin.summary || pin.rawMarkdown).slice(0, 175));
      const matchBadge = primaryMatch?.artifactTitle
        ? `<span class="artifact-type-badge">Matched in ${escapeHtml(
            primaryMatch.artifactType || 'artifact'
          )}: ${escapeHtml(primaryMatch.artifactTitle)}</span>`
        : '';

      const statusBadge =
        pin.extractionStatus !== 'completed'
          ? `<span class="artifact-type-badge" style="color:#fde68a;">⏳ Extracting...</span>`
          : `<span class="artifact-type-badge">${item.artifacts.length} Artifacts</span>`;

      return `
        <div class="vault-card" data-card-pin="${escapeHtml(pin.id)}" data-card-tab="full">
          <div class="vault-card-top">
            <span class="platform-pill ${escapeHtml(pin.sourcePlatform)}">${escapeHtml(
              pin.sourcePlatform
            )}</span>
            ${statusBadge}
          </div>
          <h3 class="vault-card-title">${escapeHtml(pin.title)}</h3>
          ${matchBadge ? `<div style="margin-bottom:6px;">${matchBadge}</div>` : ''}
          <div class="vault-snippet">${snippetHtml}</div>
          <div class="vault-card-footer">
            <div class="tag-list">
              ${(pin.tags || [])
                .slice(0, 4)
                .map((t) => `<span class="tag-badge">#${escapeHtml(t)}</span>`)
                .join('')}
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('[data-card-pin]').forEach((card) => {
    card.addEventListener('click', () => {
      openDetailModal(
        card.dataset.cardPin,
        card.dataset.cardTab || 'full',
        card.dataset.cardArt || null
      );
    });
  });
}

function openDetailModal(pinId, tab = 'full', highlightArtId = null) {
  state.selectedPinId = pinId;
  state.selectedDetailTab = tab;
  state.highlightedArtifactId = highlightArtId;
  document.getElementById('detailModalBackdrop').classList.remove('hidden');
  renderDetailModal();
}

function renderDetailModal() {
  const pin = state.pins.find((p) => p.id === state.selectedPinId);
  if (!pin) {
    document.getElementById('detailModalBackdrop').classList.add('hidden');
    return;
  }

  const pill = document.getElementById('detailPlatformPill');
  pill.className = `platform-pill ${pin.sourcePlatform}`;
  pill.textContent = pin.sourcePlatform;

  document.getElementById('detailTitle').textContent = pin.title;
  document.getElementById('detailArtifactsTabBtn').textContent = `Extracted Artifacts (${
    (pin.artifacts || []).length
  })`;
  document.getElementById('detailExtractionStatus').textContent =
    pin.extractionStatus === 'completed'
      ? `✓ Async extraction finished in ${pin.extractionDurationMs || 25}ms`
      : `⏳ Status: ${pin.extractionStatus}`;

  document.querySelectorAll('[data-detail-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.detailTab === state.selectedDetailTab);
  });

  const body = document.getElementById('detailModalBody');

  if (state.selectedDetailTab === 'full') {
    body.innerHTML = `
      ${
        pin.userPrompt
          ? `<div class="prompt-context-box"><strong>Original Prompt:</strong> ${escapeHtml(
              pin.userPrompt
            )}</div>`
          : ''
      }
      ${
        pin.summary
          ? `<div class="md-callout" style="margin-bottom:16px;"><strong>Async Agent TL;DR:</strong> ${escapeHtml(
              pin.summary
            )}</div>`
          : ''
      }
      ${renderMarkdown(pin.rawMarkdown)}
    `;
  } else {
    const artifacts = pin.artifacts || [];
    if (artifacts.length === 0) {
      body.innerHTML = `<p style="color:var(--text-dim);">No structured artifacts extracted for this response.</p>`;
    } else {
      body.innerHTML = artifacts
        .map(
          (art) => `
          <div class="artifact-inspector-card" id="inspect_${escapeHtml(art.id)}" style="${
            state.highlightedArtifactId === art.id ? 'border-color:var(--pin-gold);' : ''
          }">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <div>
                <span class="artifact-type-badge">${escapeHtml(art.type)}</span>
                <strong style="margin-left:8px;">${escapeHtml(art.title)}</strong>
                <span style="font-size:11px;color:var(--text-dim);margin-left:8px;">(${
                  art.extractionMethod === 'ast' ? 'Stage 1: AST' : 'Stage 2: Async Agent'
                })</span>
              </div>
              <button class="btn btn-sm copy-inline-btn" data-copy="${encodeURIComponent(
                art.content
              )}">Copy Artifact</button>
            </div>
            ${
              art.explanation
                ? `<p style="font-size:12px;color:var(--text-muted);margin:0 0 8px 0;">${escapeHtml(
                    art.explanation
                  )}</p>`
                : ''
            }
            <div class="md-code-block" style="margin:0;">
              <pre><code>${escapeHtml(art.content)}</code></pre>
            </div>
          </div>
        `
        )
        .join('');
    }
  }

  bindCopyButtons(body);
}

function bindCopyButtons(root) {
  root.querySelectorAll('.copy-inline-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const raw = decodeURIComponent(btn.dataset.copy || '');
      navigator.clipboard?.writeText(raw);
      const prev = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.textContent = prev;
      }, 1200);
    });
  });
}

document.getElementById('searchInput').addEventListener('input', (e) => {
  state.query = e.target.value;
  runSearch();
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    document.getElementById('searchInput').focus();
  }
  if (e.key === 'Escape') {
    document.getElementById('detailModalBackdrop').classList.add('hidden');
    document.getElementById('composeModalBackdrop').classList.add('hidden');
    document.getElementById('settingsModalBackdrop').classList.add('hidden');
  }
});

document.querySelectorAll('[data-view-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.viewMode = btn.dataset.viewMode;
    document.querySelectorAll('[data-view-mode]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    runSearch();
  });
});

document.querySelectorAll('[data-art-type]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.artifactType = btn.dataset.artType;
    document.querySelectorAll('[data-art-type]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    runSearch();
  });
});

document.querySelectorAll('[data-detail-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.selectedDetailTab = btn.dataset.detailTab;
    renderDetailModal();
  });
});

document.getElementById('btnCloseDetail').addEventListener('click', () => {
  document.getElementById('detailModalBackdrop').classList.add('hidden');
});

document.getElementById('btnCopyFullResponse').addEventListener('click', () => {
  const pin = state.pins.find((p) => p.id === state.selectedPinId);
  if (!pin) return;
  navigator.clipboard?.writeText(pin.rawMarkdown);
  const btn = document.getElementById('btnCopyFullResponse');
  btn.textContent = 'Copied Full Markdown!';
  setTimeout(() => {
    btn.textContent = 'Copy Full Markdown';
  }, 1400);
});

document.getElementById('btnDeletePin').addEventListener('click', async () => {
  if (!state.selectedPinId) return;
  if (!state.isStaticMode) {
    await fetch(`/api/pins/${encodeURIComponent(state.selectedPinId)}`, { method: 'DELETE' });
    const pinsRes = await fetch('/api/pins').then((r) => r.json());
    state.pins = pinsRes.pins || [];
  } else {
    state.pins = state.pins.filter((p) => p.id !== state.selectedPinId);
    localStorage.setItem(STATIC_STORAGE_KEY, JSON.stringify(state.pins));
  }
  document.getElementById('detailModalBackdrop').classList.add('hidden');
  rebuildPinLookup();
  renderThreadsSidebar();
  renderActiveChat();
  await runSearch();
});

document.getElementById('btnJumpToChat').addEventListener('click', () => {
  const pin = state.pins.find((p) => p.id === state.selectedPinId);
  if (!pin) return;
  document.getElementById('detailModalBackdrop').classList.add('hidden');

  const targetThread = state.threads.find((t) =>
    t.messages.some((m) => m.id === pin.messageSelector)
  );
  if (targetThread) {
    state.activeThreadId = targetThread.id;
    renderThreadsSidebar();
    renderActiveChat();
    setTimeout(() => {
      const msgEl = document.getElementById(pin.messageSelector);
      if (msgEl) {
        msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        msgEl.classList.add('flash-highlight');
        setTimeout(() => msgEl.classList.remove('flash-highlight'), 2000);
      }
    }, 60);
  }
});

document.getElementById('btnNewMessage').addEventListener('click', () => {
  document.getElementById('composeModalBackdrop').classList.remove('hidden');
});
document.getElementById('btnCloseCompose').addEventListener('click', () => {
  document.getElementById('composeModalBackdrop').classList.add('hidden');
});
document.getElementById('btnSubmitCustomMessage').addEventListener('click', async () => {
  const promptText = document.getElementById('customPromptInput').value.trim();
  const responseMd = document.getElementById('customResponseInput').value.trim();
  if (!responseMd) return;

  const thread = state.threads.find((t) => t.id === state.activeThreadId) || state.threads[0];
  const userMsgId = `msg_user_${Date.now()}`;
  const llmMsgId = `msg_llm_${Date.now()}`;

  thread.messages.push(
    { id: userMsgId, role: 'user', timestamp: 'Just now', content: promptText },
    {
      id: llmMsgId,
      role: 'assistant',
      timestamp: 'Just now',
      modelName: thread.modelBadge,
      content: responseMd,
    }
  );

  document.getElementById('composeModalBackdrop').classList.add('hidden');

  await createPin({
    sourcePlatform: thread.platform,
    threadUrl: thread.url,
    threadTitle: thread.title,
    messageSelector: llmMsgId,
    userPrompt: promptText,
    rawMarkdown: responseMd,
  });
});

document.getElementById('btnExportMd').addEventListener('click', () => {
  if (!state.isStaticMode) {
    window.open('/api/export/markdown', '_blank');
  } else {
    const md = state.pins
      .map((p) => `# ${p.title}\n\n${p.rawMarkdown}`)
      .join('\n\n---\n\n');
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pinllm-export.md';
    a.click();
  }
});

document.getElementById('btnSettings').addEventListener('click', async () => {
  if (!state.isStaticMode) {
    const res = await fetch('/api/config').then((r) => r.json());
    if (res.config) {
      document.getElementById('providerSelect').value = res.config.provider || 'heuristic';
      document.getElementById('modelInput').value = res.config.model || '';
    }
  }
  document.getElementById('settingsModalBackdrop').classList.remove('hidden');
});
document.getElementById('btnCloseSettings').addEventListener('click', () => {
  document.getElementById('settingsModalBackdrop').classList.add('hidden');
});
document.getElementById('btnSaveSettings').addEventListener('click', async () => {
  const provider = document.getElementById('providerSelect').value;
  const model = document.getElementById('modelInput').value.trim();
  const apiKey = document.getElementById('apiKeyInput').value.trim();
  if (!state.isStaticMode) {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        ...(model ? { model } : {}),
        ...(apiKey ? { apiKey } : {}),
      }),
    });
  }
  document.getElementById('settingsModalBackdrop').classList.add('hidden');
});

loadInitialData();

(() => {
  // Do not inject duplicate floating UI onto the PinLLM web app itself
  if (window.__PINLLM_INJECTED__ || document.title.startsWith('PinLLM —')) return;
  window.__PINLLM_INJECTED__ = true;

  const state = {
    query: '',
    viewMode: 'all',
    artifactType: 'all',
    results: [],
    stats: { totalPins: 0, totalArtifacts: 0 },
    inspectedPin: null,
    inspectTab: 'full',
  };

  function detectPlatform() {
    const host = location.hostname;
    if (host.includes('claude.ai')) return 'claude';
    if (host.includes('chatgpt.com') || host.includes('openai.com')) return 'chatgpt';
    if (host.includes('gemini.google.com')) return 'gemini';
    if (host.includes('deepseek.com')) return 'deepseek';
    if (host.includes('perplexity.ai')) return 'perplexity';
    return 'custom';
  }

  function escapeHtml(str = '') {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Converts an LLM response DOM container into clean Markdown,
   * preserving fenced code blocks (with language), Markdown tables, headings, and blockquotes.
   */
  function domToMarkdown(containerEl) {
    const clone = containerEl.cloneNode(true);
    clone
      .querySelectorAll('.pinllm-inline-bar, .pinllm-artifact-strip')
      .forEach((el) => el.remove());

    // Convert <pre><code> blocks to fenced Markdown
    clone.querySelectorAll('pre').forEach((pre) => {
      const codeEl = pre.querySelector('code');
      const rawCode = (codeEl || pre).innerText.trim();
      const langClass = (codeEl?.className || pre.className || '').match(
        /language-([a-zA-Z0-9_-]+)/
      );
      const headerLang = pre.parentElement?.querySelector('span, div')?.innerText?.trim() || '';
      const lang = langClass
        ? langClass[1]
        : /^[a-z0-9+#-]{1,14}$/i.test(headerLang)
        ? headerLang.toLowerCase()
        : '';
      pre.replaceWith(document.createTextNode(`\n\`\`\`${lang}\n${rawCode}\n\`\`\`\n`));
    });

    // Convert HTML <table> elements to Markdown tables
    clone.querySelectorAll('table').forEach((table) => {
      const rows = Array.from(table.querySelectorAll('tr')).map((tr) =>
        Array.from(tr.querySelectorAll('th, td')).map((cell) =>
          cell.innerText.replace(/\n+/g, ' ').trim()
        )
      );
      if (rows.length >= 1 && rows[0].length > 0) {
        const header = `| ${rows[0].join(' | ')} |`;
        const divider = `| ${rows[0].map(() => '---').join(' | ')} |`;
        const body = rows
          .slice(1)
          .map((r) => `| ${r.join(' | ')} |`)
          .join('\n');
        table.replaceWith(document.createTextNode(`\n${header}\n${divider}\n${body}\n`));
      }
    });

    // Convert headings
    clone.querySelectorAll('h1, h2, h3, h4').forEach((h) => {
      const level = Number(h.tagName[1]) || 2;
      h.replaceWith(
        document.createTextNode(`\n${'#'.repeat(level)} ${h.innerText.trim()}\n`)
      );
    });

    // Convert blockquotes
    clone.querySelectorAll('blockquote').forEach((bq) => {
      const quoted = bq.innerText
        .trim()
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
      bq.replaceWith(document.createTextNode(`\n${quoted}\n`));
    });

    return clone.innerText.replace(/\n{3,}/g, '\n\n').trim();
  }

  function findPrecedingUserPrompt(assistantNode) {
    const turnContainer =
      assistantNode.closest('[data-testid*="conversation-turn"], article, .group') ||
      assistantNode.parentElement;
    const prevTurn = turnContainer?.previousElementSibling;
    if (prevTurn) {
      const text = prevTurn.innerText?.trim();
      if (text) return text.slice(0, 500);
    }
    const userNodes = document.querySelectorAll(
      '[data-message-author-role="user"], .font-user-message, user-query'
    );
    if (userNodes.length > 0) {
      return userNodes[userNodes.length - 1].innerText?.trim().slice(0, 500) || '';
    }
    return '';
  }

  function findAssistantNodes() {
    const selectors = [
      '[data-message-author-role="assistant"]',
      '.font-claude-message',
      'message-content',
      '.ds-markdown',
      '.prose',
    ];
    return document.querySelectorAll(selectors.join(','));
  }

  function injectPinButtons() {
    const nodes = findAssistantNodes();
    nodes.forEach((node, idx) => {
      if (node.dataset.pinllmAttached === 'true') return;
      node.dataset.pinllmAttached = 'true';

      const msgId = node.id || `pinllm-msg-${idx}-${Date.now().toString(36)}`;
      if (!node.id) node.id = msgId;

      const bar = document.createElement('div');
      bar.className = 'pinllm-inline-bar';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pinllm-inline-btn';
      btn.innerHTML = '📌 Pin Response';
      btn.title = 'Pin full LLM response & asynchronously extract artifacts (PinLLM)';

      const strip = document.createElement('div');
      strip.className = 'pinllm-artifact-strip';

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.dataset.pinId) {
          openDrawerAndInspect(btn.dataset.pinId);
          return;
        }

        const rawMarkdown = domToMarkdown(node);
        const userPrompt = findPrecedingUserPrompt(node);

        btn.innerHTML = '⏳ Pinned · Extracting...';
        btn.classList.add('pinllm-active');

        chrome.runtime.sendMessage(
          {
            type: 'PIN_LLM_RESPONSE',
            payload: {
              sourcePlatform: detectPlatform(),
              threadUrl: location.href,
              threadTitle: document.title || 'LLM Chat',
              messageSelector: msgId,
              userPrompt,
              rawMarkdown,
            },
          },
          (res) => {
            if (res?.pin?.id) {
              btn.dataset.pinId = res.pin.id;
            }
            refreshDrawerResults();
          }
        );
      });

      bar.appendChild(btn);
      node.prepend(bar);
      node.appendChild(strip);
    });
  }

  // Floating Action Button + Slide-Out Drawer
  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'pinllm-fab';
  fab.innerHTML = '📌 PinLLM <span class="pinllm-fab-count" id="pinllmFabCount">0</span>';
  fab.title = 'Toggle PinLLM Search & Artifact Vault (Cmd+Shift+P / Ctrl+Shift+P)';

  const drawer = document.createElement('aside');
  drawer.className = 'pinllm-drawer pinllm-hidden';
  drawer.innerHTML = `
    <div class="pinllm-drawer-header">
      <div>
        <strong>📌 PinLLM Vault</strong>
        <span class="pinllm-subbadge" id="pinllmHeaderStats">0 Pins · 0 Artifacts</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <button type="button" class="pinllm-mini-btn" id="pinllmExportBtn" title="Export all pins & artifacts as Markdown">Export .MD</button>
        <button type="button" class="pinllm-close-btn" id="pinllmCloseBtn" aria-label="Close">&times;</button>
      </div>
    </div>

    <div class="pinllm-drawer-controls" id="pinllmSearchControls">
      <input type="search" id="pinllmSearchInput" placeholder="Search full responses, prompts & artifacts..." autocomplete="off" />
      <div class="pinllm-segments">
        <button type="button" class="pinllm-seg active" data-mode="all">All</button>
        <button type="button" class="pinllm-seg" data-mode="responses">Full Responses</button>
        <button type="button" class="pinllm-seg" data-mode="artifacts">Artifacts Only</button>
      </div>
      <div class="pinllm-pills">
        <button type="button" class="pinllm-pill active" data-art="all">All Types</button>
        <button type="button" class="pinllm-pill" data-art="code">Code</button>
        <button type="button" class="pinllm-pill" data-art="mermaid">Mermaid</button>
        <button type="button" class="pinllm-pill" data-art="table">Table</button>
        <button type="button" class="pinllm-pill" data-art="command">CLI</button>
        <button type="button" class="pinllm-pill" data-art="checklist">Checklist</button>
        <button type="button" class="pinllm-pill" data-art="decision">Decisions</button>
      </div>
    </div>

    <div class="pinllm-drawer-list" id="pinllmDrawerList"></div>
    <div class="pinllm-drawer-inspector pinllm-hidden" id="pinllmInspector"></div>
  `;

  document.body.appendChild(fab);
  document.body.appendChild(drawer);

  function toggleDrawer(forceOpen) {
    const shouldOpen =
      typeof forceOpen === 'boolean'
        ? forceOpen
        : drawer.classList.contains('pinllm-hidden');
    drawer.classList.toggle('pinllm-hidden', !shouldOpen);
    if (shouldOpen) {
      refreshDrawerResults();
      if (!state.inspectedPin) {
        drawer.querySelector('#pinllmSearchInput')?.focus();
      }
    }
  }

  function openDrawerAndInspect(pinId, tab = 'full') {
    toggleDrawer(true);
    chrome.runtime.sendMessage({ type: 'SEARCH_PINS', query: '' }, (res) => {
      const found = (res?.results || []).find((r) => r.pin.id === pinId);
      if (found) {
        state.inspectedPin = found.pin;
        state.inspectTab = tab;
        renderInspector();
      }
    });
  }

  fab.addEventListener('click', () => toggleDrawer());
  drawer.querySelector('#pinllmCloseBtn').addEventListener('click', () => toggleDrawer(false));

  drawer.querySelector('#pinllmSearchInput').addEventListener('input', (e) => {
    state.query = e.target.value;
    state.inspectedPin = null;
    refreshDrawerResults();
  });

  drawer.querySelectorAll('.pinllm-seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.viewMode = btn.dataset.mode;
      drawer.querySelectorAll('.pinllm-seg').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      refreshDrawerResults();
    });
  });

  drawer.querySelectorAll('.pinllm-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.artifactType = btn.dataset.art;
      drawer.querySelectorAll('.pinllm-pill').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      refreshDrawerResults();
    });
  });

  drawer.querySelector('#pinllmExportBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'EXPORT_MARKDOWN' }, (res) => {
      if (!res?.markdown) return;
      const blob = new Blob([res.markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pinllm-export-${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      toggleDrawer();
    }
  });

  function refreshDrawerResults() {
    chrome.runtime.sendMessage(
      {
        type: 'SEARCH_PINS',
        query: state.query,
        viewMode: state.viewMode,
        artifactType: state.artifactType,
      },
      (res) => {
        state.results = res?.results || [];
        state.stats = res?.stats || { totalPins: 0, totalArtifacts: 0 };

        const countEl = document.getElementById('pinllmFabCount');
        if (countEl) countEl.textContent = String(state.stats.totalPins);

        const statsEl = document.getElementById('pinllmHeaderStats');
        if (statsEl) {
          statsEl.textContent = `${state.stats.totalPins} Pins · ${state.stats.totalArtifacts} Artifacts`;
        }

        if (state.inspectedPin) {
          renderInspector();
        } else {
          renderResultsList();
        }
      }
    );
  }

  function renderResultsList() {
    const listEl = drawer.querySelector('#pinllmDrawerList');
    const inspectorEl = drawer.querySelector('#pinllmInspector');
    const controlsEl = drawer.querySelector('#pinllmSearchControls');

    inspectorEl.classList.add('pinllm-hidden');
    listEl.classList.remove('pinllm-hidden');
    controlsEl.classList.remove('pinllm-hidden');

    if (state.results.length === 0) {
      listEl.innerHTML = `<div class="pinllm-empty">No matching pins or artifacts.<br/>Click <strong>📌 Pin Response</strong> on any LLM reply to pin the full message &amp; extract artifacts asynchronously.</div>`;
      return;
    }

    listEl.innerHTML = state.results
      .map((item) => {
        const pin = item.pin;
        if (item.resultType === 'artifact' && item.matchedArtifact) {
          const art = item.matchedArtifact;
          return `
            <div class="pinllm-card" data-pin-id="${escapeHtml(pin.id)}" data-tab="artifacts">
              <div class="pinllm-card-meta">
                <span class="pinllm-type-badge">${escapeHtml(art.type)} · ${escapeHtml(
                  art.language || 'text'
                )}</span>
                <span>${escapeHtml(pin.sourcePlatform.toUpperCase())}</span>
              </div>
              <div class="pinllm-card-title">${escapeHtml(art.title)}</div>
              <div class="pinllm-card-preview">${item.snippetHtml}</div>
            </div>
          `;
        }

        const artCount = (pin.artifacts || []).length;
        return `
          <div class="pinllm-card" data-pin-id="${escapeHtml(pin.id)}" data-tab="full">
            <div class="pinllm-card-meta">
              <span>${escapeHtml(pin.sourcePlatform.toUpperCase())}</span>
              <span class="pinllm-type-badge">${
                pin.extractionStatus === 'completed'
                  ? `${artCount} Artifact${artCount === 1 ? '' : 's'}`
                  : '⏳ Extracting...'
              }</span>
            </div>
            <div class="pinllm-card-title">${escapeHtml(pin.title)}</div>
            <div class="pinllm-card-preview">${item.snippetHtml}</div>
            <div class="pinllm-tag-row">
              ${(pin.tags || [])
                .slice(0, 4)
                .map((t) => `<span class="pinllm-tag">#${escapeHtml(t)}</span>`)
                .join('')}
            </div>
          </div>
        `;
      })
      .join('');

    listEl.querySelectorAll('.pinllm-card').forEach((card) => {
      card.addEventListener('click', () => {
        const pinId = card.dataset.pinId;
        const found = state.results.find((r) => r.pin.id === pinId);
        if (found) {
          state.inspectedPin = found.pin;
          state.inspectTab = card.dataset.tab || 'full';
          renderInspector();
        }
      });
    });
  }

  function renderInspector() {
    const pin = state.inspectedPin;
    if (!pin) return renderResultsList();

    const listEl = drawer.querySelector('#pinllmDrawerList');
    const inspectorEl = drawer.querySelector('#pinllmInspector');
    const controlsEl = drawer.querySelector('#pinllmSearchControls');

    listEl.classList.add('pinllm-hidden');
    controlsEl.classList.add('pinllm-hidden');
    inspectorEl.classList.remove('pinllm-hidden');

    const arts = pin.artifacts || [];

    inspectorEl.innerHTML = `
      <div class="pinllm-inspector-bar">
        <button type="button" class="pinllm-mini-btn" id="pinllmBackBtn">← Back to Search</button>
        <div style="display:flex;gap:6px;">
          <button type="button" class="pinllm-mini-btn" id="pinllmJumpBtn">Jump to Chat ↗</button>
          <button type="button" class="pinllm-mini-btn" id="pinllmCopyFullBtn">Copy Full</button>
          <button type="button" class="pinllm-mini-btn danger" id="pinllmUnpinBtn">Unpin</button>
        </div>
      </div>

      <h3 class="pinllm-inspector-title">${escapeHtml(pin.title)}</h3>
      ${
        pin.summary
          ? `<div class="pinllm-tldr"><strong>TL;DR:</strong> ${escapeHtml(pin.summary)}</div>`
          : ''
      }

      <div class="pinllm-segments" style="margin:10px 0;">
        <button type="button" class="pinllm-seg ${
          state.inspectTab === 'full' ? 'active' : ''
        }" data-itab="full">Full Response</button>
        <button type="button" class="pinllm-seg ${
          state.inspectTab === 'artifacts' ? 'active' : ''
        }" data-itab="artifacts">Extracted Artifacts (${arts.length})</button>
      </div>

      <div class="pinllm-inspector-body">
        ${
          state.inspectTab === 'full'
            ? `<pre class="pinllm-pre">${escapeHtml(pin.rawMarkdown)}</pre>`
            : arts.length === 0
            ? `<div class="pinllm-empty">No structured artifacts extracted for this response.</div>`
            : arts
                .map(
                  (a) => `
                <div class="pinllm-art-box">
                  <div class="pinllm-art-head">
                    <span><strong class="pinllm-type-badge">${escapeHtml(
                      a.type
                    )}</strong> ${escapeHtml(a.title)}</span>
                    <button type="button" class="pinllm-mini-btn pinllm-copy-art" data-copy="${encodeURIComponent(
                      a.content
                    )}">Copy</button>
                  </div>
                  <pre class="pinllm-pre">${escapeHtml(a.content)}</pre>
                </div>
              `
                )
                .join('')
        }
      </div>
    `;

    inspectorEl.querySelector('#pinllmBackBtn').addEventListener('click', () => {
      state.inspectedPin = null;
      renderResultsList();
    });

    inspectorEl.querySelector('#pinllmCopyFullBtn').addEventListener('click', (e) => {
      navigator.clipboard?.writeText(pin.rawMarkdown);
      e.target.textContent = 'Copied!';
      setTimeout(() => (e.target.textContent = 'Copy Full'), 1200);
    });

    inspectorEl.querySelector('#pinllmUnpinBtn').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'DELETE_PIN', pinId: pin.id }, () => {
        state.inspectedPin = null;
        refreshDrawerResults();
      });
    });

    inspectorEl.querySelector('#pinllmJumpBtn').addEventListener('click', () => {
      if (pin.messageSelector) {
        const el = document.getElementById(pin.messageSelector);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.style.outline = '2px solid #f59e0b';
          setTimeout(() => (el.style.outline = ''), 2000);
          return;
        }
      }
      if (pin.threadUrl) {
        window.open(pin.threadUrl, '_blank');
      }
    });

    inspectorEl.querySelectorAll('[data-itab]').forEach((b) => {
      b.addEventListener('click', () => {
        state.inspectTab = b.dataset.itab;
        renderInspector();
      });
    });

    inspectorEl.querySelectorAll('.pinllm-copy-art').forEach((b) => {
      b.addEventListener('click', () => {
        navigator.clipboard?.writeText(decodeURIComponent(b.dataset.copy || ''));
        b.textContent = 'Copied!';
        setTimeout(() => (b.textContent = 'Copy'), 1200);
      });
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TOGGLE_PIN_DRAWER') {
      toggleDrawer();
    }
    if (msg.type === 'PIN_EXTRACTION_COMPLETED' && msg.pin?.messageSelector) {
      const el = document.getElementById(msg.pin.messageSelector);
      const btn = el?.querySelector('.pinllm-inline-btn');
      const strip = el?.querySelector('.pinllm-artifact-strip');
      const arts = msg.pin.artifacts || [];
      if (btn) {
        btn.dataset.pinId = msg.pin.id;
        btn.innerHTML = `📌 Pinned · ${arts.length} Artifact${arts.length === 1 ? '' : 's'}`;
      }
      if (strip && arts.length > 0) {
        strip.innerHTML = arts
          .map(
            (a) =>
              `<button type="button" class="pinllm-chip" data-pin="${escapeHtml(
                msg.pin.id
              )}">${escapeHtml(a.type.toUpperCase())}: ${escapeHtml(a.title)}</button>`
          )
          .join('');
        strip.querySelectorAll('.pinllm-chip').forEach((chip) => {
          chip.addEventListener('click', () => openDrawerAndInspect(chip.dataset.pin, 'artifacts'));
        });
      }
      refreshDrawerResults();
    }
  });

  const observer = new MutationObserver(() => injectPinButtons());
  observer.observe(document.body, { childList: true, subtree: true });
  injectPinButtons();
  refreshDrawerResults();
})();

(() => {
  if (window.__PINLLM_INJECTED__) return;
  window.__PINLLM_INJECTED__ = true;

  function detectPlatform() {
    const host = location.hostname;
    if (host.includes('claude.ai')) return 'claude';
    if (host.includes('chatgpt.com') || host.includes('openai.com')) return 'chatgpt';
    if (host.includes('gemini.google.com')) return 'gemini';
    return 'custom';
  }

  /**
   * Converts an LLM response DOM container into clean Markdown while preserving fenced code blocks.
   */
  function domToMarkdown(containerEl) {
    const clone = containerEl.cloneNode(true);
    clone.querySelectorAll('.pinllm-inline-btn').forEach((b) => b.remove());

    clone.querySelectorAll('pre').forEach((pre) => {
      const codeEl = pre.querySelector('code');
      const rawCode = (codeEl || pre).innerText.trim();
      const langMatch = (codeEl?.className || '').match(/language-([a-zA-Z0-9_-]+)/);
      const lang = langMatch ? langMatch[1] : '';
      const mdFence = `\n\`\`\`${lang}\n${rawCode}\n\`\`\`\n`;
      pre.replaceWith(document.createTextNode(mdFence));
    });

    return clone.innerText.trim();
  }

  function findAssistantNodes() {
    const selectors = [
      '[data-message-author-role="assistant"]',
      '.font-claude-message',
      'message-content',
      '[data-testid*="conversation-turn"]',
    ];
    return document.querySelectorAll(selectors.join(','));
  }

  function injectPinButtons() {
    const nodes = findAssistantNodes();
    nodes.forEach((node, idx) => {
      if (node.dataset.pinllmAttached === 'true') return;
      node.dataset.pinllmAttached = 'true';

      const msgId = node.id || `pinllm-dom-msg-${idx}`;
      if (!node.id) node.id = msgId;

      const btn = document.createElement('button');
      btn.className = 'pinllm-inline-btn';
      btn.innerHTML = '📌 Pin Response';
      btn.title = 'Pin full LLM response & extract artifacts asynchronously';

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rawMarkdown = domToMarkdown(node);
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
              userPrompt: '',
              rawMarkdown,
            },
          },
          () => {
            refreshDrawerResults();
          }
        );
      });

      node.style.position = node.style.position || 'relative';
      node.prepend(btn);
    });
  }

  // Create Floating Drawer Toggle & Slide-Out Search Drawer
  const fab = document.createElement('button');
  fab.className = 'pinllm-fab';
  fab.innerHTML = '📌 PinLLM Vault';
  fab.title = 'Open PinLLM Search & Artifact Vault (Cmd+Shift+P)';

  const drawer = document.createElement('aside');
  drawer.className = 'pinllm-drawer pinllm-hidden';
  drawer.innerHTML = `
    <div class="pinllm-drawer-header">
      <strong>📌 PinLLM Vault</strong>
      <button class="pinllm-close-btn" id="pinllmCloseBtn">&times;</button>
    </div>
    <div class="pinllm-drawer-search">
      <input type="search" id="pinllmSearchInput" placeholder="Search full responses & extracted artifacts..." />
    </div>
    <div class="pinllm-drawer-list" id="pinllmDrawerList"></div>
  `;

  document.body.appendChild(fab);
  document.body.appendChild(drawer);

  function toggleDrawer() {
    drawer.classList.toggle('pinllm-hidden');
    if (!drawer.classList.contains('pinllm-hidden')) {
      refreshDrawerResults();
      drawer.querySelector('#pinllmSearchInput')?.focus();
    }
  }

  fab.addEventListener('click', toggleDrawer);
  drawer.querySelector('#pinllmCloseBtn').addEventListener('click', toggleDrawer);
  drawer.querySelector('#pinllmSearchInput').addEventListener('input', refreshDrawerResults);

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      toggleDrawer();
    }
  });

  function refreshDrawerResults() {
    const q = drawer.querySelector('#pinllmSearchInput')?.value || '';
    chrome.runtime.sendMessage({ type: 'SEARCH_PINS', query: q }, (res) => {
      const list = drawer.querySelector('#pinllmDrawerList');
      if (!list) return;
      const pins = res?.pins || [];
      if (pins.length === 0) {
        list.innerHTML = `<div class="pinllm-empty">No pins match your search yet. Click "📌 Pin Response" on any LLM reply!</div>`;
        return;
      }
      list.innerHTML = pins
        .map(
          (p) => `
          <div class="pinllm-card">
            <div class="pinllm-card-meta">
              <span>${p.sourcePlatform.toUpperCase()}</span>
              <span>${(p.artifacts || []).length} Artifacts</span>
            </div>
            <div class="pinllm-card-title">${p.title}</div>
            <div class="pinllm-card-preview">${p.rawMarkdown.slice(0, 160)}...</div>
          </div>
        `
        )
        .join('');
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'PIN_EXTRACTION_COMPLETED' && msg.pin?.messageSelector) {
      const el = document.getElementById(msg.pin.messageSelector);
      const btn = el?.querySelector('.pinllm-inline-btn');
      if (btn) {
        const count = (msg.pin.artifacts || []).length;
        btn.innerHTML = `📌 Pinned (${count} Artifact${count === 1 ? '' : 's'})`;
      }
      refreshDrawerResults();
    }
  });

  const observer = new MutationObserver(() => injectPinButtons());
  observer.observe(document.body, { childList: true, subtree: true });
  injectPinButtons();
})();

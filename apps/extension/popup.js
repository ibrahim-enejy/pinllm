const popupState = {
  query: '',
  viewMode: 'all',
};

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadPopupResults() {
  chrome.runtime.sendMessage(
    {
      type: 'SEARCH_PINS',
      query: popupState.query,
      viewMode: popupState.viewMode,
    },
    (res) => {
      const results = res?.results || [];
      const stats = res?.stats || { totalPins: 0, totalArtifacts: 0 };

      document.getElementById('popupStats').textContent = `${stats.totalPins} Pins · ${stats.totalArtifacts} Artifacts`;

      const listEl = document.getElementById('popupList');
      if (results.length === 0) {
        listEl.innerHTML = `<div class="pinllm-empty">No matching pins yet.<br/>Open ChatGPT, Claude, or Gemini and click <strong>📌 Pin Response</strong> on any reply!</div>`;
        return;
      }

      listEl.innerHTML = results
        .map((item) => {
          const pin = item.pin;
          const isArt = item.resultType === 'artifact' && item.matchedArtifact;
          const title = isArt ? item.matchedArtifact.title : pin.title;
          const copyText = isArt ? item.matchedArtifact.content : pin.rawMarkdown;
          const badge = isArt
            ? `${item.matchedArtifact.type} · ${item.matchedArtifact.language || 'text'}`
            : `${(pin.artifacts || []).length} Artifacts`;

          return `
            <div class="pinllm-card">
              <div class="pinllm-card-meta">
                <span>${escapeHtml(pin.sourcePlatform.toUpperCase())}</span>
                <span class="pinllm-type-badge">${escapeHtml(badge)}</span>
              </div>
              <div class="pinllm-card-title">${escapeHtml(title)}</div>
              <div class="pinllm-card-preview">${item.snippetHtml}</div>
              <div style="display:flex;justify-content:space-between;margin-top:8px;">
                <button class="pinllm-mini-btn copy-btn" data-copy="${encodeURIComponent(
                  copyText
                )}">Copy</button>
                ${
                  pin.threadUrl
                    ? `<a href="${escapeHtml(
                        pin.threadUrl
                      )}" target="_blank" class="pinllm-mini-btn" style="text-decoration:none;">Open Chat ↗</a>`
                    : ''
                }
              </div>
            </div>
          `;
        })
        .join('');

      listEl.querySelectorAll('.copy-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          navigator.clipboard?.writeText(decodeURIComponent(btn.dataset.copy || ''));
          btn.textContent = 'Copied!';
          setTimeout(() => (btn.textContent = 'Copy'), 1200);
        });
      });
    }
  );
}

document.getElementById('popupSearchInput').addEventListener('input', (e) => {
  popupState.query = e.target.value;
  loadPopupResults();
});

document.querySelectorAll('.pinllm-seg').forEach((btn) => {
  btn.addEventListener('click', () => {
    popupState.viewMode = btn.dataset.mode;
    document.querySelectorAll('.pinllm-seg').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    loadPopupResults();
  });
});

document.getElementById('popupExportBtn').addEventListener('click', () => {
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

loadPopupResults();

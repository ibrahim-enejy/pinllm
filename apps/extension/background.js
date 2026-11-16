const STORAGE_KEY = 'pinllm_vault_v1';
const LOCAL_SERVER_URL = 'http://localhost:4173';

function genId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

async function getVault() {
  const res = await chrome.storage.local.get(STORAGE_KEY);
  return res[STORAGE_KEY] || { pins: [] };
}

async function saveVault(vault) {
  await chrome.storage.local.set({ [STORAGE_KEY]: vault });
}

/**
 * Asynchronous Background Extraction in Service Worker (Stage 1 AST + Stage 2 Heuristic/Agent)
 */
function extractArtifactsFromMarkdown(pinId, rawMarkdown) {
  const artifacts = [];
  const lines = rawMarkdown.split('\n');
  let inFence = false;
  let fenceLang = '';
  let fenceLines = [];
  let currentHeading = '';

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!inFence && /^#{1,4}\s+/.test(trimmed)) {
      currentHeading = trimmed.replace(/^#+\s*/, '').trim();
      continue;
    }

    const fenceMatch = trimmed.match(/^`{3,}([^\s`]*)/);
    if (!inFence && fenceMatch) {
      inFence = true;
      fenceLang = (fenceMatch[1] || 'code').toLowerCase();
      fenceLines = [];
      continue;
    }
    if (inFence) {
      if (/^`{3,}\s*$/.test(trimmed)) {
        const content = fenceLines.join('\n').trim();
        if (content) {
          const type =
            fenceLang === 'mermaid'
              ? 'mermaid'
              : ['bash', 'sh', 'zsh', 'shell'].includes(fenceLang)
              ? 'command'
              : 'code';
          artifacts.push({
            id: genId('art'),
            pinId,
            type,
            title: currentHeading || `${fenceLang.toUpperCase()} Snippet`,
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
    }
  }

  return artifacts;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PIN_LLM_RESPONSE') {
    (async () => {
      const vault = await getVault();
      const now = Date.now();
      const pinId = genId('pin');

      const newPin = {
        id: pinId,
        sourcePlatform: message.payload.sourcePlatform || 'custom',
        threadUrl: message.payload.threadUrl || '',
        threadTitle: message.payload.threadTitle || 'Chat Thread',
        messageSelector: message.payload.messageSelector,
        userPrompt: message.payload.userPrompt || '',
        rawMarkdown: message.payload.rawMarkdown || '',
        title:
          (message.payload.userPrompt || message.payload.threadTitle || 'Pinned Response').slice(
            0,
            64
          ),
        tags: [],
        extractionStatus: 'pending',
        artifacts: [],
        createdAt: now,
        updatedAt: now,
      };

      // 1. Instant synchronous save of the full LLM response
      vault.pins.unshift(newPin);
      await saveVault(vault);
      sendResponse({ ok: true, pin: newPin });

      // 2. Asynchronous extraction of artifacts & sync with local server if available
      setTimeout(async () => {
        const currentVault = await getVault();
        const target = currentVault.pins.find((p) => p.id === pinId);
        if (!target) return;

        target.artifacts = extractArtifactsFromMarkdown(pinId, target.rawMarkdown);
        target.extractionStatus = 'completed';
        target.updatedAt = Date.now();
        await saveVault(currentVault);

        // Optional sync to local PinLLM SQLite server if running
        try {
          await fetch(`${LOCAL_SERVER_URL}/api/pins`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message.payload),
          });
        } catch {
          // Local desktop server not running; extension storage is primary
        }

        if (sender.tab?.id) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'PIN_EXTRACTION_COMPLETED',
            pin: target,
          });
        }
      }, 120);
    })();
    return true;
  }

  if (message.type === 'SEARCH_PINS') {
    (async () => {
      const vault = await getVault();
      const q = (message.query || '').toLowerCase().trim();
      const viewMode = message.viewMode || 'all';

      const filtered = vault.pins.filter((pin) => {
        if (!q) return true;
        const inResponse =
          pin.title.toLowerCase().includes(q) ||
          pin.rawMarkdown.toLowerCase().includes(q) ||
          pin.userPrompt.toLowerCase().includes(q);
        const inArtifacts = (pin.artifacts || []).some(
          (a) => a.title.toLowerCase().includes(q) || a.content.toLowerCase().includes(q)
        );
        return viewMode === 'responses' ? inResponse : inResponse || inArtifacts;
      });

      sendResponse({ ok: true, pins: filtered });
    })();
    return true;
  }
});

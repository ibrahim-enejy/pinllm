const STORAGE_KEY = 'pinllm_vault_v1';
const CONFIG_KEY = 'pinllm_config_v1';
const LOCAL_SERVER_URL = 'http://localhost:4173';

const SHELL_LANGS = new Set(['sh', 'bash', 'zsh', 'shell', 'console', 'terminal', 'powershell']);
const CONFIG_LANGS = new Set(['json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'env']);

const TECH_TAG_PATTERNS = [
  { pattern: /\b(typescript|ts|tsx)\b/i, tag: 'typescript' },
  { pattern: /\b(javascript|nodejs|node\.js)\b/i, tag: 'javascript' },
  { pattern: /\b(python|fastapi|pydantic|pytest)\b/i, tag: 'python' },
  { pattern: /\b(rust|cargo|tokio)\b/i, tag: 'rust' },
  { pattern: /\b(postgres|postgresql|pgvector|sqlite|sql)\b/i, tag: 'database' },
  { pattern: /\b(redis|cache|caching|rate[- ]?limit\w*)\b/i, tag: 'caching' },
  { pattern: /\b(docker|dockerfile|kubernetes|k8s)\b/i, tag: 'devops' },
  { pattern: /\b(jwt|oauth|auth\w*|session|token)\b/i, tag: 'security' },
  { pattern: /\b(react|nextjs|tailwind|css|html)\b/i, tag: 'frontend' },
  { pattern: /\b(mermaid|flowchart|sequenceDiagram|architecture)\b/i, tag: 'architecture' },
];

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

async function getConfig() {
  const res = await chrome.storage.local.get(CONFIG_KEY);
  return res[CONFIG_KEY] || { provider: 'heuristic', model: '', apiKey: '' };
}

async function saveConfig(cfg) {
  await chrome.storage.local.set({ [CONFIG_KEY]: cfg });
  return cfg;
}

function inferTitleFromCode(code, lang, fallbackHeading) {
  const lines = code.trim().split('\n');
  const firstLine = (lines[0] || '').trim();
  const fileMatch = firstLine.match(
    /^(?:\/\/|#|\/\*|--|<!--)\s*(?:file:\s*)?([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)\s*(?:\*\/|-->)?$/i
  );
  if (fileMatch) return fileMatch[1];
  if (fallbackHeading && fallbackHeading.length <= 65) return fallbackHeading;

  for (const line of lines.slice(0, 10)) {
    const fnMatch = line.match(
      /(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|def|fn|struct)\s+([a-zA-Z0-9_]+)/
    );
    if (fnMatch) return `${fnMatch[1]} (${lang || 'code'})`;
    const sqlMatch = line.match(
      /CREATE\s+(?:VIRTUAL\s+)?(?:TABLE|INDEX|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/i
    );
    if (sqlMatch) return `SQL: ${sqlMatch[1]}`;
  }

  if (lang === 'mermaid') return 'Architecture Diagram (Mermaid)';
  if (SHELL_LANGS.has(lang)) {
    const cmd = (lines.find((l) => l.trim() && !l.trim().startsWith('#')) || firstLine)
      .replace(/^\$\s*/, '')
      .slice(0, 40);
    return cmd ? `CLI: ${cmd}` : 'Shell Command';
  }
  return fallbackHeading || `${(lang || 'Code').toUpperCase()} Snippet`;
}

/**
 * Stage 1: Deterministic AST extraction of code, Mermaid, tables, CLI commands, configs, and checklists.
 */
function extractStage1Artifacts(pinId, rawMarkdown) {
  const artifacts = [];
  const lines = rawMarkdown.split('\n');
  let currentHeading = '';
  let lastParagraph = '';
  let inFence = false;
  let fenceChar = '`';
  let fenceLang = '';
  let fenceLines = [];
  let fenceHeading = '';
  let fenceExplanation = '';

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})([^\s`~]*)/);
    if (!inFence && fenceMatch) {
      inFence = true;
      fenceChar = fenceMatch[1][0];
      fenceLang = (fenceMatch[2] || '').toLowerCase();
      fenceLines = [];
      fenceHeading = currentHeading;
      fenceExplanation = lastParagraph;
      i++;
      continue;
    }

    if (inFence) {
      const closeRegex = new RegExp(`^${fenceChar}{3,}\\s*$`);
      if (closeRegex.test(trimmed)) {
        const content = fenceLines.join('\n').trimEnd();
        if (content.trim()) {
          let type = 'code';
          if (fenceLang === 'mermaid') type = 'mermaid';
          else if (SHELL_LANGS.has(fenceLang)) type = 'command';
          else if (CONFIG_LANGS.has(fenceLang)) type = 'json';

          artifacts.push({
            id: genId('art'),
            pinId,
            type,
            title: inferTitleFromCode(content, fenceLang, fenceHeading),
            language: fenceLang || (type === 'command' ? 'bash' : 'text'),
            content,
            explanation: fenceExplanation || undefined,
            extractionMethod: 'ast',
            createdAt: Date.now(),
          });
        }
        inFence = false;
        fenceLines = [];
      } else {
        fenceLines.push(line);
      }
      i++;
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      currentHeading = trimmed.replace(/^#+\s*/, '').replace(/[*`]/g, '').trim();
      lastParagraph = '';
      i++;
      continue;
    }

    // Markdown Table
    if (
      trimmed.startsWith('|') &&
      trimmed.endsWith('|') &&
      i + 1 < lines.length &&
      /^\|\s*[-:]+/.test(lines[i + 1].trim())
    ) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      artifacts.push({
        id: genId('art'),
        pinId,
        type: 'table',
        title: currentHeading || 'Comparison Table',
        language: 'markdown',
        content: tableLines.join('\n'),
        explanation: lastParagraph || undefined,
        extractionMethod: 'ast',
        createdAt: Date.now(),
      });
      continue;
    }

    // Checklists
    if (/^[-*]\s+\[[ xX]\]\s+/.test(trimmed)) {
      const listLines = [];
      while (i < lines.length && /^(\s*[-*]\s+\[[ xX]\]\s+|\s{2,}\S+)/.test(lines[i])) {
        listLines.push(lines[i]);
        i++;
      }
      if (listLines.length >= 2) {
        artifacts.push({
          id: genId('art'),
          pinId,
          type: 'checklist',
          title: currentHeading || 'Implementation Checklist',
          language: 'markdown',
          content: listLines.join('\n'),
          explanation: lastParagraph || undefined,
          extractionMethod: 'ast',
          createdAt: Date.now(),
        });
      }
      continue;
    }

    if (trimmed.length > 0 && !trimmed.startsWith('>')) {
      lastParagraph = trimmed.replace(/\*\*/g, '').slice(0, 200);
    }
    i++;
  }

  return artifacts;
}

/**
 * Stage 2: Async Agentic Enrichment (Title, TL;DR Summary, Semantic Tags, Implicit Prose Decisions)
 */
async function runStage2Enrichment(pin, stage1Artifacts, config) {
  const rawLines = pin.rawMarkdown.split('\n');
  const nonEmpty = rawLines.map((l) => l.trim()).filter(Boolean);

  let title = pin.title;
  const heading = nonEmpty.find((l) => /^#{1,3}\s+/.test(l));
  if (heading) {
    title = heading.replace(/^#+\s*/, '').replace(/[*`]/g, '').trim();
  } else if (pin.userPrompt && pin.userPrompt.trim()) {
    title = pin.userPrompt.trim().slice(0, 66);
  }

  // Extract 1-sentence TL;DR from first prose paragraph
  let inCode = false;
  let summary = '';
  for (const l of rawLines) {
    const t = l.trim();
    if (/^(`{3,}|~{3,})/.test(t)) {
      inCode = !inCode;
      continue;
    }
    if (inCode || !t || /^#{1,6}\s+/.test(t) || t.startsWith('|')) continue;
    const clean = t.replace(/^>\s*(\[![A-Z]+\]\s*)?/, '').replace(/[*`]/g, '').trim();
    if (clean.length >= 35) {
      summary = clean.slice(0, 210);
      break;
    }
  }

  // Infer tags
  const combined = `${pin.userPrompt}\n${pin.rawMarkdown}`;
  const tagSet = new Set(pin.tags || []);
  for (const { pattern, tag } of TECH_TAG_PATTERNS) {
    if (pattern.test(combined)) tagSet.add(tag);
  }
  for (const art of stage1Artifacts) {
    if (art.language && !['text', 'markdown'].includes(art.language)) {
      tagSet.add(art.language.toLowerCase());
    }
  }

  // Extract implicit prose decisions / callouts
  const implicitArtifacts = [];
  let idx = 0;
  while (idx < rawLines.length) {
    const line = rawLines[idx].trim();
    if (line.startsWith('>')) {
      const qLines = [];
      while (idx < rawLines.length && rawLines[idx].trim().startsWith('>')) {
        qLines.push(rawLines[idx].trim().replace(/^>\s?/, ''));
        idx++;
      }
      const joined = qLines.join('\n').trim();
      if (
        /\[!(IMPORTANT|WARNING|TIP|CAUTION|NOTE)\]/i.test(joined) ||
        /\b(decision|trade-?off|takeaway|recommendation|root cause):/i.test(joined)
      ) {
        implicitArtifacts.push({
          id: genId('art'),
          pinId: pin.id,
          type: 'decision',
          title: 'Key Decision / Callout',
          language: 'markdown',
          content: joined.replace(/^\[![A-Z]+\]\s*/i, ''),
          explanation: 'Extracted asynchronously from prose callout.',
          extractionMethod: 'agent',
          createdAt: Date.now(),
        });
      }
      continue;
    }
    idx++;
  }

  // Optional live LLM enrichment via Ollama or OpenAI if configured
  if (config?.provider === 'ollama' || (config?.provider === 'openai' && config?.apiKey)) {
    try {
      const sys =
        'Return JSON: {"title": string, "summary": string, "tags": string[]} for this pinned LLM response.';
      if (config.provider === 'ollama') {
        const res = await fetch('http://localhost:11434/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config.model || 'llama3.2',
            format: 'json',
            stream: false,
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: combined.slice(0, 4000) },
            ],
          }),
        });
        if (res.ok) {
          const data = await res.json();
          const parsed = JSON.parse(data.message.content);
          if (parsed.title) title = parsed.title;
          if (parsed.summary) summary = parsed.summary;
          if (Array.isArray(parsed.tags)) parsed.tags.forEach((t) => tagSet.add(t));
        }
      }
    } catch {
      // Fallback to local heuristic results
    }
  }

  return {
    title,
    summary: summary || `Pinned full response with ${stage1Artifacts.length} extracted artifact(s).`,
    tags: Array.from(tagSet).slice(0, 6),
    implicitArtifacts,
  };
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSnippet(text = '', tokens = [], maxLen = 170) {
  if (!text) return '';
  const lower = text.toLowerCase();
  let firstIdx = -1;
  for (const t of tokens) {
    const idx = lower.indexOf(t);
    if (idx !== -1 && (firstIdx === -1 || idx < firstIdx)) firstIdx = idx;
  }
  const start = firstIdx > 35 ? firstIdx - 30 : 0;
  const end = Math.min(text.length, start + maxLen);
  let slice = escapeHtml(text.slice(start, end).replace(/\n+/g, ' ↵ '));

  if (tokens.length > 0) {
    const pattern = tokens
      .slice()
      .sort((a, b) => b.length - a.length)
      .map((t) => escapeRegExp(escapeHtml(t)))
      .join('|');
    if (pattern) {
      slice = slice.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
    }
  }
  return `${start > 0 ? '...' : ''}${slice}${end < text.length ? '...' : ''}`;
}

/**
 * Searches across full PinnedResponses and their ExtractedArtifacts with viewMode & artifactType filters.
 */
function searchVaultPins(pins, { query = '', viewMode = 'all', artifactType = 'all' } = {}) {
  const tokens = query
    .toLowerCase()
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);

  const results = [];

  for (const pin of pins) {
    const allArts = pin.artifacts || [];
    const filteredArts =
      artifactType === 'all' ? allArts : allArts.filter((a) => a.type === artifactType);

    if (artifactType !== 'all' && filteredArts.length === 0) continue;

    if (viewMode === 'artifacts') {
      for (const art of filteredArts) {
        const corpus = `${art.title} ${art.content} ${art.language || ''} ${pin.title}`.toLowerCase();
        if (tokens.every((t) => corpus.includes(t))) {
          results.push({
            resultType: 'artifact',
            pin,
            matchedArtifact: art,
            snippetHtml: buildSnippet(art.content, tokens),
          });
        }
      }
      continue;
    }

    const fullCorpus = [
      pin.title,
      pin.summary || '',
      pin.userPrompt || '',
      pin.rawMarkdown || '',
      (pin.tags || []).join(' '),
      ...(viewMode === 'all' ? filteredArts.map((a) => `${a.title} ${a.content}`) : []),
    ]
      .join('\n')
      .toLowerCase();

    if (!tokens.every((t) => fullCorpus.includes(t))) continue;

    let matchedArtifact = null;
    if (tokens.length > 0 && viewMode === 'all') {
      matchedArtifact =
        filteredArts.find((a) =>
          tokens.some((t) => `${a.title} ${a.content}`.toLowerCase().includes(t))
        ) || null;
    }

    const snippetSource = matchedArtifact
      ? matchedArtifact.content
      : tokens.length > 0
      ? pin.rawMarkdown
      : pin.summary || pin.rawMarkdown;

    results.push({
      resultType: 'pin',
      pin: { ...pin, artifacts: filteredArts },
      matchedArtifact,
      snippetHtml: buildSnippet(snippetSource, tokens),
    });
  }

  return results;
}

function buildMarkdownExport(pins) {
  const sections = pins.map((pin) => {
    const artMd = (pin.artifacts || [])
      .map(
        (a, i) =>
          `#### ${i + 1}. [${a.type.toUpperCase()}] ${a.title}\n\`\`\`${a.language || ''}\n${
            a.content
          }\n\`\`\``
      )
      .join('\n\n');
    return [
      `# ${pin.title}`,
      `- **Platform**: ${pin.sourcePlatform}`,
      `- **Thread**: ${pin.threadUrl}`,
      `- **Tags**: ${(pin.tags || []).map((t) => `#${t}`).join(' ')}`,
      pin.summary ? `- **TL;DR**: ${pin.summary}` : '',
      pin.userPrompt ? `\n### Prompt\n> ${pin.userPrompt}` : '',
      `\n### Full LLM Response\n${pin.rawMarkdown}`,
      artMd ? `\n### Extracted Artifacts\n${artMd}` : '',
      `\n---\n`,
    ]
      .filter(Boolean)
      .join('\n');
  });
  return `# PinLLM Export (${pins.length} Pinned Responses)\n\n${sections.join('\n')}`;
}

chrome.commands?.onCommand.addListener(async (command) => {
  if (command === 'toggle-pin-drawer') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PIN_DRAWER' });
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PIN_LLM_RESPONSE') {
    (async () => {
      const startTime = Date.now();
      const vault = await getVault();
      const pinId = genId('pin');

      const newPin = {
        id: pinId,
        sourcePlatform: message.payload.sourcePlatform || 'custom',
        threadUrl: message.payload.threadUrl || '',
        threadTitle: message.payload.threadTitle || 'Chat Session',
        messageSelector: message.payload.messageSelector,
        userPrompt: message.payload.userPrompt || '',
        rawMarkdown: message.payload.rawMarkdown || '',
        title:
          (message.payload.userPrompt || message.payload.threadTitle || 'Pinned Response').slice(
            0,
            64
          ),
        summary: '',
        tags: [],
        extractionStatus: 'pending',
        artifacts: [],
        createdAt: startTime,
        updatedAt: startTime,
      };

      // 1. Instant synchronous save of the full LLM response
      vault.pins.unshift(newPin);
      await saveVault(vault);
      sendResponse({ ok: true, pin: newPin });

      // 2. Non-blocking Asynchronous Extraction (Stage 1 AST + Stage 2 Agentic Enrichment)
      setTimeout(async () => {
        const currentVault = await getVault();
        const target = currentVault.pins.find((p) => p.id === pinId);
        if (!target) return;

        const cfg = await getConfig();
        const stage1 = extractStage1Artifacts(pinId, target.rawMarkdown);
        const stage2 = await runStage2Enrichment(target, stage1, cfg);

        target.title = stage2.title || target.title;
        target.summary = stage2.summary;
        target.tags = stage2.tags;
        target.artifacts = [...stage1, ...stage2.implicitArtifacts];
        target.extractionStatus = 'completed';
        target.extractionDurationMs = Date.now() - startTime;
        target.updatedAt = Date.now();

        await saveVault(currentVault);

        // Optional sync to local server if running
        try {
          await fetch(`${LOCAL_SERVER_URL}/api/pins`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message.payload),
          });
        } catch {
          // Local server not running; browser extension storage is primary
        }

        if (sender.tab?.id) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'PIN_EXTRACTION_COMPLETED',
            pin: target,
          });
        }
      }, 80);
    })();
    return true;
  }

  if (message.type === 'SEARCH_PINS') {
    (async () => {
      const vault = await getVault();
      const results = searchVaultPins(vault.pins, {
        query: message.query || '',
        viewMode: message.viewMode || 'all',
        artifactType: message.artifactType || 'all',
      });
      const totalArtifacts = vault.pins.reduce((sum, p) => sum + (p.artifacts || []).length, 0);
      sendResponse({
        ok: true,
        results,
        stats: { totalPins: vault.pins.length, totalArtifacts },
      });
    })();
    return true;
  }

  if (message.type === 'DELETE_PIN') {
    (async () => {
      const vault = await getVault();
      vault.pins = vault.pins.filter((p) => p.id !== message.pinId);
      await saveVault(vault);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'EXPORT_MARKDOWN') {
    (async () => {
      const vault = await getVault();
      sendResponse({ ok: true, markdown: buildMarkdownExport(vault.pins) });
    })();
    return true;
  }

  if (message.type === 'GET_CONFIG') {
    (async () => {
      const config = await getConfig();
      sendResponse({ ok: true, config });
    })();
    return true;
  }

  if (message.type === 'SAVE_CONFIG') {
    (async () => {
      const config = await saveConfig(message.config || {});
      sendResponse({ ok: true, config });
    })();
    return true;
  }
});

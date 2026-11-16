import type {
  AgentEnrichmentResult,
  ArtifactType,
  ExtractedArtifact,
  LLMExtractorConfig,
} from './types.ts';

const SHELL_LANGUAGES = new Set([
  'sh',
  'bash',
  'zsh',
  'shell',
  'console',
  'terminal',
  'fish',
  'powershell',
  'ps1',
]);

const CONFIG_LANGUAGES = new Set([
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'env',
]);

const TECH_TAG_KEYWORDS: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /\b(typescript|ts|tsx)\b/i, tag: 'typescript' },
  { pattern: /\b(javascript|nodejs|node\.js)\b/i, tag: 'javascript' },
  { pattern: /\b(python|fastapi|pydantic|pytest|asyncio)\b/i, tag: 'python' },
  { pattern: /\b(rust|cargo|tokio)\b/i, tag: 'rust' },
  { pattern: /\b(golang|goroutine)\b/i, tag: 'go' },
  { pattern: /\b(postgres|postgresql|pgvector|psql|sqlite|fts5|sql)\b/i, tag: 'database' },
  { pattern: /\b(redis|cache|caching|rate[- ]?limit\w*)\b/i, tag: 'caching' },
  { pattern: /\b(docker|dockerfile|kubernetes|k8s|helm|container)\b/i, tag: 'devops' },
  { pattern: /\b(jwt|oauth|auth\w*|session|token|rbac|cors)\b/i, tag: 'security' },
  { pattern: /\b(react|nextjs|next\.js|tailwind|css|dom|html)\b/i, tag: 'frontend' },
  { pattern: /\b(graphql|rest api|webhook|grpc|websocket|sse)\b/i, tag: 'api' },
  { pattern: /\b(mermaid|flowchart|sequenceDiagram|architecture|system design)\b/i, tag: 'architecture' },
  { pattern: /\b(llm|embedding\w*|rag|vector|openai|anthropic|claude|gemini|ollama)\b/i, tag: 'ai' },
  { pattern: /\b(git|github|ci\/cd|github actions)\b/i, tag: 'git' },
  { pattern: /\b(benchmark|latency|performance|optimization|memory leak)\b/i, tag: 'performance' },
];

export function generateId(prefix = 'id'): string {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}_${time}_${random}`;
}

function inferTitleFromCode(code: string, lang: string, fallbackHeading?: string): string {
  const lines = code.trim().split('\n');
  const firstLine = (lines[0] || '').trim();

  // 1. Check file path comment in first line: // src/auth.ts, # app/main.py, -- schema.sql
  const fileCommentMatch = firstLine.match(
    /^(?:\/\/|#|\/\*|--|<!--)\s*(?:file:\s*)?([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)\s*(?:\*\/|-->)?$/i
  );
  if (fileCommentMatch) {
    return fileCommentMatch[1];
  }

  // 2. Check if there is a specific heading context
  if (fallbackHeading && fallbackHeading.length <= 65) {
    return fallbackHeading;
  }

  // 3. Check for symbol definitions (function, class, interface, SQL table, etc.)
  for (const line of lines.slice(0, 12)) {
    const fnMatch = line.match(
      /(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|def|fn|struct|impl)\s+([a-zA-Z0-9_]+)/
    );
    if (fnMatch) {
      return `${fnMatch[1]} (${lang || 'code'})`;
    }
    const sqlMatch = line.match(
      /CREATE\s+(?:VIRTUAL\s+)?(?:TABLE|INDEX|VIEW|FUNCTION)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/i
    );
    if (sqlMatch) {
      return `SQL: ${sqlMatch[1]}`;
    }
    const dockerMatch = line.match(/^FROM\s+([a-zA-Z0-9_:.-]+)/i);
    if (dockerMatch) {
      return `Dockerfile (${dockerMatch[1]})`;
    }
  }

  if (lang === 'mermaid') {
    if (/sequenceDiagram/i.test(code)) return 'Sequence Diagram';
    if (/erDiagram/i.test(code)) return 'Entity Relationship Diagram';
    if (/stateDiagram/i.test(code)) return 'State Diagram';
    if (/classDiagram/i.test(code)) return 'Class Diagram';
    return 'Architecture Flowchart';
  }

  if (SHELL_LANGUAGES.has(lang)) {
    const cmdLine = lines.find((l) => l.trim() && !l.trim().startsWith('#')) || firstLine;
    const cleanCmd = cmdLine.replace(/^\$\s*/, '').trim().slice(0, 42);
    return cleanCmd ? `CLI: ${cleanCmd}` : 'Shell Commands';
  }

  return fallbackHeading || `${(lang || 'Code').toUpperCase()} Snippet`;
}

function cleanHeadingText(raw: string): string {
  return raw
    .replace(/^#+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^\d+\.\s*/, '')
    .trim();
}

/**
 * Stage 1: Deterministic, instantaneous AST / structural extraction of artifacts from raw Markdown.
 * Extracts code blocks, Mermaid diagrams, CLI commands, JSON/YAML configs, Markdown tables, and checklists.
 */
export function extractArtifactsStage1(
  pinId: string,
  rawMarkdown: string,
  now = Date.now()
): ExtractedArtifact[] {
  const artifacts: ExtractedArtifact[] = [];
  const lines = rawMarkdown.split('\n');

  let currentHeading = '';
  let lastParagraph = '';

  let inFence = false;
  let fenceChar = '`';
  let fenceLang = '';
  let fenceMeta = '';
  let fenceStartLine = 0;
  let fenceLines: string[] = [];
  let fenceHeading = '';
  let fenceExplanation = '';

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Handle fenced code blocks
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})([^\s`~]*)(.*)$/);
    if (!inFence && fenceMatch) {
      inFence = true;
      fenceChar = fenceMatch[1][0];
      fenceLang = (fenceMatch[2] || '').toLowerCase();
      fenceMeta = (fenceMatch[3] || '').trim();
      fenceStartLine = i + 1;
      fenceLines = [];
      fenceHeading = currentHeading;
      fenceExplanation = lastParagraph;
      i++;
      continue;
    }

    if (inFence) {
      const closeFenceRegex = new RegExp(`^${fenceChar}{3,}\\s*$`);
      if (closeFenceRegex.test(trimmed)) {
        const content = fenceLines.join('\n').trimEnd();
        if (content.trim().length > 0) {
          let type: ArtifactType = 'code';
          if (fenceLang === 'mermaid') {
            type = 'mermaid';
          } else if (SHELL_LANGUAGES.has(fenceLang)) {
            type = 'command';
          } else if (CONFIG_LANGUAGES.has(fenceLang)) {
            type = 'json';
          }

          // Check meta for title="...":
          const metaTitleMatch =
            fenceMeta.match(/title=["']([^"']+)["']/i) ||
            fenceMeta.match(/^([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)$/);
          const inferredTitle = metaTitleMatch
            ? metaTitleMatch[1]
            : inferTitleFromCode(content, fenceLang, fenceHeading);

          artifacts.push({
            id: generateId('art'),
            pinId,
            type,
            title: inferredTitle,
            language: fenceLang || (type === 'command' ? 'bash' : 'text'),
            content,
            explanation: fenceExplanation || undefined,
            lineStart: fenceStartLine,
            lineEnd: i + 1,
            extractionMethod: 'ast',
            createdAt: now,
          });
        }
        inFence = false;
        fenceLines = [];
        i++;
        continue;
      } else {
        fenceLines.push(line);
        i++;
        continue;
      }
    }

    // Track headings
    if (/^#{1,6}\s+/.test(trimmed)) {
      currentHeading = cleanHeadingText(trimmed);
      lastParagraph = '';
      i++;
      continue;
    }

    // Detect Markdown Tables
    if (
      trimmed.startsWith('|') &&
      trimmed.endsWith('|') &&
      i + 1 < lines.length &&
      /^\|\s*[-:]+[-|\s:]*\|$/.test(lines[i + 1].trim())
    ) {
      const tableStart = i + 1;
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      const headers = tableLines[0]
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(' vs ');
      artifacts.push({
        id: generateId('art'),
        pinId,
        type: 'table',
        title: currentHeading || (headers ? `Table: ${headers}` : 'Comparison Table'),
        language: 'markdown',
        content: tableLines.join('\n'),
        explanation: lastParagraph || undefined,
        lineStart: tableStart,
        lineEnd: i,
        extractionMethod: 'ast',
        createdAt: now,
      });
      continue;
    }

    // Detect Action Checklists (- [ ] or - [x])
    if (/^[-*]\s+\[[ xX]\]\s+/.test(trimmed)) {
      const listStart = i + 1;
      const listLines: string[] = [];
      while (i < lines.length && /^(\s*[-*]\s+\[[ xX]\]\s+|\s{2,}\S+)/.test(lines[i])) {
        listLines.push(lines[i]);
        i++;
      }
      if (listLines.length >= 2) {
        artifacts.push({
          id: generateId('art'),
          pinId,
          type: 'checklist',
          title: currentHeading || 'Implementation Checklist',
          language: 'markdown',
          content: listLines.join('\n'),
          explanation: lastParagraph || undefined,
          lineStart: listStart,
          lineEnd: i,
          extractionMethod: 'ast',
          createdAt: now,
        });
      }
      continue;
    }

    // Track prose paragraph for context
    if (trimmed.length > 0 && !trimmed.startsWith('>')) {
      const cleanLine = trimmed.replace(/\*\*/g, '');
      lastParagraph = cleanLine.length > 220 ? cleanLine.slice(0, 217) + '...' : cleanLine;
    }

    i++;
  }

  return artifacts;
}

/**
 * Generates high-signal heuristic title, summary, tags, and implicit prose artifacts
 * when running in local/offline mode (or as fallback).
 */
export function runHeuristicAgentEnrichment(
  userPrompt: string,
  rawMarkdown: string,
  existingArtifacts: ExtractedArtifact[]
): AgentEnrichmentResult {
  const lines = rawMarkdown
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // 1. Infer Title
  let title = '';
  const firstHeading = lines.find((l) => /^#{1,3}\s+/.test(l));
  if (firstHeading) {
    title = cleanHeadingText(firstHeading);
  } else if (userPrompt && userPrompt.trim().length > 0) {
    const cleanPrompt = userPrompt
      .trim()
      .replace(/^(can you|could you|please|how do i|how to|help me|write|explain)\s+/i, '');
    title = cleanPrompt.charAt(0).toUpperCase() + cleanPrompt.slice(1);
    if (title.length > 68) title = title.slice(0, 65).trim() + '...';
  } else {
    const firstSentence = (lines[0] || 'Pinned LLM Response').replace(/[*#>`]/g, '').trim();
    title = firstSentence.slice(0, 65);
  }

  // 2. Infer Summary (1-2 sentence TL;DR from lead prose paragraph)
  let inCode = false;
  const proseParagraphs: string[] = [];
  for (const rawLine of rawMarkdown.split('\n')) {
    const t = rawLine.trim();
    if (/^(`{3,}|~{3,})/.test(t)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (!t || /^#{1,6}\s+/.test(t) || t.startsWith('|') || /^[-*]\s+\[[ xX]\]/.test(t)) {
      continue;
    }
    const cleaned = t
      .replace(/^>\s*(\[![A-Z]+\]\s*)?/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .trim();
    if (cleaned.length >= 35) {
      proseParagraphs.push(cleaned);
      if (proseParagraphs.length >= 2) break;
    }
  }
  const summary =
    proseParagraphs[0]?.slice(0, 220) ||
    `Full response containing ${existingArtifacts.length} extracted artifact(s).`;

  // 3. Infer Semantic Tags
  const combinedText = `${userPrompt}\n${rawMarkdown}`;
  const tagSet = new Set<string>();
  for (const { pattern, tag } of TECH_TAG_KEYWORDS) {
    if (pattern.test(combinedText)) {
      tagSet.add(tag);
    }
  }
  for (const art of existingArtifacts) {
    if (art.type === 'mermaid') tagSet.add('diagram');
    if (art.type === 'table') tagSet.add('comparison');
    if (art.type === 'checklist') tagSet.add('checklist');
    if (art.language && !['text', 'markdown'].includes(art.language)) {
      tagSet.add(art.language.toLowerCase());
    }
  }
  const tags = Array.from(tagSet).slice(0, 6);
  if (tags.length === 0) tags.push('general');

  // 4. Extract Implicit Prose Artifacts (Decisions, Callouts, Key Takeaways, Runbooks)
  const implicitArtifacts: AgentEnrichmentResult['implicitArtifacts'] = [];
  const rawLines = rawMarkdown.split('\n');

  // 4a. Extract GitHub-style alerts or Blockquote callouts (> [!IMPORTANT], > **Decision:**, etc.)
  let idx = 0;
  while (idx < rawLines.length) {
    const line = rawLines[idx].trim();
    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (idx < rawLines.length && rawLines[idx].trim().startsWith('>')) {
        quoteLines.push(rawLines[idx].trim().replace(/^>\s?/, ''));
        idx++;
      }
      const joined = quoteLines.join('\n').trim();
      const alertMatch = joined.match(/^\[!(IMPORTANT|WARNING|TIP|CAUTION|NOTE)\]\s*(.*)/is);
      if (alertMatch || /\b(decision|trade-?off|takeaway|recommendation|rule|why this matters):/i.test(joined)) {
        const label = alertMatch ? `${alertMatch[1]} Callout` : 'Architectural Decision / Note';
        const body = alertMatch ? alertMatch[2].trim() : joined;
        if (body.length >= 25) {
          implicitArtifacts.push({
            type: 'decision',
            title: label,
            language: 'markdown',
            content: body,
            explanation: 'Key callout or decision extracted asynchronously from prose.',
          });
        }
      }
      continue;
    }

    // 4b. Explicit bold callout paragraphs like "**Key Architectural Decision:** ..." or "**TL;DR:** ..."
    const decisionParaMatch = line.match(
      /^\*\*(Key\s+Decision|Architectural\s+Decision|Trade-?offs?|Recommendation|Why\s+This\s+Works|Root\s+Cause|Fix\s+Summary)[:\s]*\*\*:?\s*(.+)$/i
    );
    if (decisionParaMatch && decisionParaMatch[2].length >= 25) {
      implicitArtifacts.push({
        type: 'decision',
        title: decisionParaMatch[1].trim(),
        language: 'markdown',
        content: `${decisionParaMatch[1]}: ${decisionParaMatch[2]}`,
        explanation: 'Implicit architectural note extracted from response prose.',
      });
    }

    idx++;
  }

  return {
    title,
    summary,
    tags,
    implicitArtifacts,
  };
}

/**
 * Stage 2: Asynchronous Agentic Extraction.
 * Uses configured LLM provider (OpenAI / Anthropic / Gemini / Ollama) if provided,
 * and falls back gracefully to the deterministic+heuristic semantic agent.
 */
export async function enrichWithAgentStage2(
  userPrompt: string,
  rawMarkdown: string,
  stage1Artifacts: ExtractedArtifact[],
  config: LLMExtractorConfig = { provider: 'heuristic', simulatedLatencyMs: 350 }
): Promise<AgentEnrichmentResult> {
  if (config.simulatedLatencyMs && config.simulatedLatencyMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, config.simulatedLatencyMs));
  }

  if (config.provider !== 'heuristic' && (config.apiKey || config.provider === 'ollama')) {
    try {
      const systemPrompt = [
        'You are an asynchronous artifact extraction agent for pinned LLM chat responses.',
        'Given a user prompt and an LLM response, return strict JSON with keys:',
        '- "title": concise 4-8 word title for the pinned response',
        '- "summary": 1-sentence TL;DR summary',
        '- "tags": array of 3-6 lowercase topic/tech tags',
        '- "implicitArtifacts": array of important decisions, callouts, checklists, or prose insights not already inside fenced code blocks, each with { "type": "decision" | "note" | "checklist" | "command", "title": string, "content": string, "explanation": string }',
      ].join('\n');

      const userPayload = `USER PROMPT:\n${userPrompt}\n\nLLM RESPONSE:\n${rawMarkdown.slice(0, 8000)}`;

      if (config.provider === 'openai') {
        const res = await fetch(config.baseUrl || 'https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model || 'gpt-4o-mini',
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPayload },
            ],
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          const parsed = JSON.parse(data.choices[0].message.content);
          return {
            title: parsed.title || 'Pinned Response',
            summary: parsed.summary || '',
            tags: Array.isArray(parsed.tags) ? parsed.tags : [],
            implicitArtifacts: Array.isArray(parsed.implicitArtifacts)
              ? parsed.implicitArtifacts
              : [],
          };
        }
      } else if (config.provider === 'ollama') {
        const baseUrl = (config.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
        const res = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config.model || 'llama3.2',
            format: 'json',
            stream: false,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPayload },
            ],
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          const parsed = JSON.parse(data.message.content);
          return {
            title: parsed.title || 'Pinned Response',
            summary: parsed.summary || '',
            tags: Array.isArray(parsed.tags) ? parsed.tags : [],
            implicitArtifacts: Array.isArray(parsed.implicitArtifacts)
              ? parsed.implicitArtifacts
              : [],
          };
        }
      }
    } catch {
      // Fall back to local heuristic extraction if remote call fails
    }
  }

  return runHeuristicAgentEnrichment(userPrompt, rawMarkdown, stage1Artifacts);
}

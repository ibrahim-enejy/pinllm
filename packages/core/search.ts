import type {
  ExtractedArtifact,
  PinnedResponse,
  SearchMatchLocation,
  SearchQuery,
  SearchResultItem,
} from './types.ts';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .trim()
    .split(/[\s,]+/)
    .map((t) => t.replace(/^#/, '').trim())
    .filter((t) => t.length > 0);
}

/**
 * Generates a contextual snippet with <mark> highlights around matching query tokens.
 */
export function buildHighlightedSnippet(
  text: string,
  tokens: string[],
  maxLength = 190
): string {
  if (!text) return '';
  if (tokens.length === 0) {
    const clean = text.slice(0, maxLength);
    return escapeHtml(clean) + (text.length > maxLength ? '...' : '');
  }

  const lower = text.toLowerCase();
  let bestIndex = -1;
  for (const token of tokens) {
    const idx = lower.indexOf(token);
    if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
      bestIndex = idx;
    }
  }

  const start = bestIndex > 45 ? bestIndex - 40 : 0;
  const end = Math.min(text.length, start + maxLength);
  let slice = text.slice(start, end).replace(/\n+/g, ' ↵ ');

  let escaped = escapeHtml(slice);
  const pattern = tokens
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((t) => escapeRegExp(escapeHtml(t)))
    .join('|');

  if (pattern) {
    const regex = new RegExp(`(${pattern})`, 'gi');
    escaped = escaped.replace(regex, '<mark>$1</mark>');
  }

  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return `${prefix}${escaped}${suffix}`;
}

function scoreField(text: string | undefined, tokens: string[], weight: number): number {
  if (!text || tokens.length === 0) return 0;
  const lower = text.toLowerCase();
  let fieldScore = 0;

  for (const token of tokens) {
    const idx = lower.indexOf(token);
    if (idx === -1) continue;

    // Count occurrences (capped at 5 to avoid long-document bias)
    let count = 0;
    let pos = 0;
    while (count < 5) {
      const found = lower.indexOf(token, pos);
      if (found === -1) break;
      count++;
      pos = found + token.length;
    }

    // Bonus for exact word boundary match
    const wordBoundaryRegex = new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i');
    const boundaryBonus = wordBoundaryRegex.test(text) ? 1.4 : 1.0;

    // Diminishing returns on term frequency (BM25-style saturation)
    const tf = (count * 2.2) / (count + 1.2);
    fieldScore += tf * weight * boundaryBonus;
  }

  return fieldScore;
}

/**
 * Searches across both full PinnedResponses and their ExtractedArtifacts,
 * supporting view modes ('all' | 'responses' | 'artifacts') and facet filters.
 */
export function searchPinsAndArtifacts(
  pins: PinnedResponse[],
  artifactsByPinId: Map<string, ExtractedArtifact[]>,
  searchQuery: SearchQuery
): SearchResultItem[] {
  const {
    query = '',
    viewMode = 'all',
    artifactType = 'all',
    language = 'all',
    sourcePlatform = 'all',
    tag = 'all',
    limit = 100,
  } = searchQuery;

  const tokens = tokenizeQuery(query);
  const results: SearchResultItem[] = [];

  for (const pin of pins) {
    // 1. Apply pin-level filters
    if (sourcePlatform !== 'all' && pin.sourcePlatform !== sourcePlatform) {
      continue;
    }
    if (tag !== 'all' && !pin.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
      continue;
    }

    const allPinArtifacts = artifactsByPinId.get(pin.id) || [];
    const filteredArtifacts = allPinArtifacts.filter((art) => {
      if (artifactType !== 'all' && art.type !== artifactType) return false;
      if (language !== 'all' && (art.language || '').toLowerCase() !== language.toLowerCase()) {
        return false;
      }
      return true;
    });

    // If user is filtering by artifactType or language and this pin has no matching artifacts, skip
    if ((artifactType !== 'all' || language !== 'all') && filteredArtifacts.length === 0) {
      continue;
    }

    // Mode A: Artifact-first view mode (returns each matching artifact as its own card)
    if (viewMode === 'artifacts') {
      for (const art of filteredArtifacts) {
        if (tokens.length === 0) {
          results.push({
            resultType: 'artifact',
            score: art.createdAt,
            pin,
            artifacts: allPinArtifacts,
            matchedArtifact: art,
            matches: [
              {
                field: 'artifactContent',
                artifactId: art.id,
                artifactTitle: art.title,
                artifactType: art.type,
                snippetHtml: buildHighlightedSnippet(art.content, [], 180),
              },
            ],
          });
          continue;
        }

        const titleScore = scoreField(art.title, tokens, 6.0);
        const contentScore = scoreField(art.content, tokens, 3.5);
        const explanationScore = scoreField(art.explanation, tokens, 2.5);
        const langScore = scoreField(art.language, tokens, 3.0);
        const parentScore =
          scoreField(pin.title, tokens, 1.5) + scoreField(pin.tags.join(' '), tokens, 1.5);

        const totalScore = titleScore + contentScore + explanationScore + langScore + parentScore;

        // Require all tokens to appear somewhere in the artifact or its parent pin metadata
        const combinedArtifactContext = `${art.title} ${art.content} ${art.explanation || ''} ${art.language || ''} ${pin.title} ${pin.tags.join(' ')}`.toLowerCase();
        const allTokensMatched = tokens.every((t) => combinedArtifactContext.includes(t));

        if (totalScore > 0 && allTokensMatched) {
          const matches: SearchMatchLocation[] = [];
          if (titleScore > 0) {
            matches.push({
              field: 'artifactTitle',
              artifactId: art.id,
              artifactTitle: art.title,
              artifactType: art.type,
              snippetHtml: buildHighlightedSnippet(art.title, tokens, 120),
            });
          }
          if (contentScore > 0 || matches.length === 0) {
            matches.push({
              field: 'artifactContent',
              artifactId: art.id,
              artifactTitle: art.title,
              artifactType: art.type,
              snippetHtml: buildHighlightedSnippet(art.content, tokens, 200),
            });
          }
          results.push({
            resultType: 'artifact',
            score: totalScore,
            pin,
            artifacts: allPinArtifacts,
            matchedArtifact: art,
            matches,
          });
        }
      }
      continue;
    }

    // Mode B: 'all' or 'responses' view mode (returns PinnedResponse items with matched artifacts attached)
    if (tokens.length === 0) {
      results.push({
        resultType: 'pin',
        score: pin.createdAt,
        pin,
        artifacts: filteredArtifacts,
        matches: [
          {
            field: 'summary',
            snippetHtml: buildHighlightedSnippet(pin.summary || pin.rawMarkdown, [], 200),
          },
        ],
      });
      continue;
    }

    // Compute match scores across full response AND artifacts
    const titleScore = scoreField(pin.title, tokens, 6.0);
    const tagScore = scoreField(pin.tags.join(' '), tokens, 5.0);
    const summaryScore = scoreField(pin.summary, tokens, 3.5);
    const promptScore = scoreField(pin.userPrompt, tokens, 2.5);
    const rawScore = scoreField(pin.rawMarkdown, tokens, 2.0);
    const noteScore = scoreField(pin.note, tokens, 4.0);

    const matches: SearchMatchLocation[] = [];
    if (titleScore > 0) {
      matches.push({
        field: 'title',
        snippetHtml: buildHighlightedSnippet(pin.title, tokens, 120),
      });
    }
    if (rawScore > 0) {
      matches.push({
        field: 'rawMarkdown',
        snippetHtml: buildHighlightedSnippet(pin.rawMarkdown, tokens, 200),
      });
    }
    if (promptScore > 0) {
      matches.push({
        field: 'userPrompt',
        snippetHtml: buildHighlightedSnippet(pin.userPrompt, tokens, 160),
      });
    }

    let artifactScoreTotal = 0;
    let bestArtifact: ExtractedArtifact | undefined;
    let bestArtScore = 0;

    if (viewMode === 'all') {
      for (const art of filteredArtifacts) {
        const aTitle = scoreField(art.title, tokens, 4.5);
        const aContent = scoreField(art.content, tokens, 3.0);
        const aExpl = scoreField(art.explanation, tokens, 2.0);
        const aScore = aTitle + aContent + aExpl;
        if (aScore > 0) {
          artifactScoreTotal += aScore;
          if (aScore > bestArtScore) {
            bestArtScore = aScore;
            bestArtifact = art;
          }
          matches.push({
            field: aContent > 0 ? 'artifactContent' : 'artifactTitle',
            artifactId: art.id,
            artifactTitle: art.title,
            artifactType: art.type,
            snippetHtml: buildHighlightedSnippet(
              aContent > 0 ? art.content : art.title,
              tokens,
              180
            ),
          });
        }
      }
    }

    const combinedCorpus = [
      pin.title,
      pin.summary || '',
      pin.userPrompt,
      pin.rawMarkdown,
      pin.tags.join(' '),
      pin.note || '',
      ...(viewMode === 'all'
        ? filteredArtifacts.map((a) => `${a.title} ${a.content} ${a.explanation || ''}`)
        : []),
    ]
      .join('\n')
      .toLowerCase();

    const allTokensPresent = tokens.every((t) => combinedCorpus.includes(t));
    const totalScore =
      titleScore + tagScore + summaryScore + promptScore + rawScore + noteScore + artifactScoreTotal;

    if (totalScore > 0 && allTokensPresent) {
      results.push({
        resultType: 'pin',
        score: totalScore,
        pin,
        artifacts: filteredArtifacts,
        matchedArtifact: bestArtifact,
        matches: matches.slice(0, 4),
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score || b.pin.createdAt - a.pin.createdAt)
    .slice(0, limit);
}

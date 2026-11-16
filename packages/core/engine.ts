import {
  enrichWithAgentStage2,
  extractArtifactsStage1,
  generateId,
} from './extractor.ts';
import { searchPinsAndArtifacts } from './search.ts';
import type {
  CreatePinInput,
  ExtractedArtifact,
  LLMExtractorConfig,
  PinEvent,
  PinnedResponse,
  PinWithArtifacts,
  SearchQuery,
  SearchResultItem,
} from './types.ts';

export interface PinStorageDriver {
  savePin(pin: PinnedResponse): void;
  getPin(id: string): PinnedResponse | undefined;
  getAllPins(): PinnedResponse[];
  deletePin(id: string): void;
  saveArtifacts(pinId: string, artifacts: ExtractedArtifact[]): void;
  getArtifactsForPin(pinId: string): ExtractedArtifact[];
  getAllArtifacts(): ExtractedArtifact[];
}

export class InMemoryPinStorage implements PinStorageDriver {
  private pins = new Map<string, PinnedResponse>();
  private artifactsByPin = new Map<string, ExtractedArtifact[]>();

  savePin(pin: PinnedResponse): void {
    this.pins.set(pin.id, { ...pin, tags: [...pin.tags] });
  }

  getPin(id: string): PinnedResponse | undefined {
    const p = this.pins.get(id);
    return p ? { ...p, tags: [...p.tags] } : undefined;
  }

  getAllPins(): PinnedResponse[] {
    return Array.from(this.pins.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  deletePin(id: string): void {
    this.pins.delete(id);
    this.artifactsByPin.delete(id);
  }

  saveArtifacts(pinId: string, artifacts: ExtractedArtifact[]): void {
    this.artifactsByPin.set(
      pinId,
      artifacts.map((a) => ({ ...a }))
    );
  }

  getArtifactsForPin(pinId: string): ExtractedArtifact[] {
    return (this.artifactsByPin.get(pinId) || []).map((a) => ({ ...a }));
  }

  getAllArtifacts(): ExtractedArtifact[] {
    const all: ExtractedArtifact[] = [];
    for (const list of this.artifactsByPin.values()) {
      all.push(...list);
    }
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }
}

export class PinEngine {
  private storage: PinStorageDriver;
  private extractorConfig: LLMExtractorConfig;
  private listeners = new Set<(event: PinEvent) => void>();
  private activeJobs = new Map<string, Promise<PinWithArtifacts>>();

  constructor(options?: {
    storage?: PinStorageDriver;
    extractorConfig?: LLMExtractorConfig;
  }) {
    this.storage = options?.storage || new InMemoryPinStorage();
    this.extractorConfig = options?.extractorConfig || {
      provider: 'heuristic',
      simulatedLatencyMs: 320,
    };
  }

  setExtractorConfig(config: Partial<LLMExtractorConfig>): LLMExtractorConfig {
    this.extractorConfig = { ...this.extractorConfig, ...config };
    return this.extractorConfig;
  }

  getExtractorConfig(): LLMExtractorConfig {
    return { ...this.extractorConfig };
  }

  subscribe(listener: (event: PinEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: PinEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener errors
      }
    }
  }

  /**
   * Synchronously pins the full LLM response immediately (< 5ms)
   * and triggers the non-blocking asynchronous artifact extraction pipeline.
   */
  pinResponse(input: CreatePinInput): {
    pin: PinnedResponse;
    extractionPromise: Promise<PinWithArtifacts>;
  } {
    const now = Date.now();
    const id = input.id || generateId('pin');

    const quickTitle =
      input.title ||
      input.userPrompt.trim().slice(0, 62) ||
      input.rawMarkdown
        .replace(/[#*`>]/g, '')
        .trim()
        .slice(0, 62) ||
      'Pinned LLM Response';

    const pin: PinnedResponse = {
      id,
      sourcePlatform: input.sourcePlatform || 'custom',
      threadUrl: input.threadUrl || '#chat',
      threadTitle: input.threadTitle || 'Chat Session',
      messageSelector: input.messageSelector,
      userPrompt: input.userPrompt,
      rawMarkdown: input.rawMarkdown,
      title: quickTitle,
      summary: undefined,
      tags: input.tags ? [...input.tags] : [],
      note: input.note,
      extractionStatus: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    // 1. Instant synchronous persistence of the full LLM response
    this.storage.savePin(pin);
    this.storage.saveArtifacts(pin.id, []);

    this.emit({
      type: 'pin:created',
      pinId: pin.id,
      pin,
      artifacts: [],
      timestamp: now,
      detail: 'Full LLM response pinned synchronously. Queuing async artifact extraction...',
    });

    // 2. Schedule non-blocking asynchronous artifact & metadata extraction
    const extractionPromise = this.runAsyncExtraction(pin.id);
    return { pin, extractionPromise };
  }

  /**
   * Asynchronous background worker pipeline:
   * - Stage 1: Deterministic Markdown AST extraction (code, mermaid, tables, commands, checklists)
   * - Stage 2: Agentic enrichment (smart title, 1-line summary, semantic tags, implicit prose decisions)
   */
  async runAsyncExtraction(pinId: string): Promise<PinWithArtifacts> {
    const existingJob = this.activeJobs.get(pinId);
    if (existingJob) return existingJob;

    const job = (async (): Promise<PinWithArtifacts> => {
      const startTime = Date.now();
      const pin = this.storage.getPin(pinId);
      if (!pin) {
        throw new Error(`Pin not found: ${pinId}`);
      }

      // Yield to event loop so synchronous UI updates finish first
      await new Promise((resolve) => setTimeout(resolve, 10));

      const processingPin: PinnedResponse = {
        ...pin,
        extractionStatus: 'processing',
        updatedAt: Date.now(),
      };
      this.storage.savePin(processingPin);
      this.emit({
        type: 'extraction:started',
        pinId,
        pin: processingPin,
        timestamp: Date.now(),
        detail: 'Stage 1: Running AST parser for code blocks, diagrams, tables, and checklists...',
      });

      try {
        // Stage 1: AST Extraction
        const stage1Artifacts = extractArtifactsStage1(pinId, pin.rawMarkdown, Date.now());
        this.storage.saveArtifacts(pinId, stage1Artifacts);

        this.emit({
          type: 'extraction:stage1_complete',
          pinId,
          pin: processingPin,
          artifacts: stage1Artifacts,
          timestamp: Date.now(),
          detail: `Stage 1 complete (${stage1Artifacts.length} structural artifacts). Running Stage 2 Agentic enrichment...`,
        });

        // Stage 2: Async Agentic Enrichment
        const enrichment = await enrichWithAgentStage2(
          pin.userPrompt,
          pin.rawMarkdown,
          stage1Artifacts,
          this.extractorConfig
        );

        const stage2Artifacts: ExtractedArtifact[] = enrichment.implicitArtifacts.map((imp) => ({
          id: generateId('art'),
          pinId,
          type: imp.type,
          title: imp.title,
          language: imp.language || 'markdown',
          content: imp.content,
          explanation: imp.explanation,
          extractionMethod: 'agent',
          createdAt: Date.now(),
        }));

        const allArtifacts = [...stage1Artifacts, ...stage2Artifacts];
        const mergedTags = Array.from(new Set([...pin.tags, ...enrichment.tags]));
        const durationMs = Date.now() - startTime;

        const completedPin: PinnedResponse = {
          ...processingPin,
          title: enrichment.title || processingPin.title,
          summary: enrichment.summary,
          tags: mergedTags,
          extractionStatus: 'completed',
          extractionDurationMs: durationMs,
          updatedAt: Date.now(),
        };

        this.storage.savePin(completedPin);
        this.storage.saveArtifacts(pinId, allArtifacts);

        this.emit({
          type: 'extraction:completed',
          pinId,
          pin: completedPin,
          artifacts: allArtifacts,
          timestamp: Date.now(),
          detail: `Extracted ${allArtifacts.length} artifacts and ${mergedTags.length} tags in ${durationMs}ms.`,
        });

        return {
          ...completedPin,
          artifacts: allArtifacts,
        };
      } catch (err: any) {
        const failedPin: PinnedResponse = {
          ...processingPin,
          extractionStatus: 'failed',
          extractionError: err?.message || String(err),
          updatedAt: Date.now(),
        };
        this.storage.savePin(failedPin);
        const currentArtifacts = this.storage.getArtifactsForPin(pinId);
        this.emit({
          type: 'extraction:failed',
          pinId,
          pin: failedPin,
          artifacts: currentArtifacts,
          timestamp: Date.now(),
          detail: failedPin.extractionError,
        });
        return {
          ...failedPin,
          artifacts: currentArtifacts,
        };
      } finally {
        this.activeJobs.delete(pinId);
      }
    })();

    this.activeJobs.set(pinId, job);
    return job;
  }

  getPinWithArtifacts(pinId: string): PinWithArtifacts | undefined {
    const pin = this.storage.getPin(pinId);
    if (!pin) return undefined;
    return {
      ...pin,
      artifacts: this.storage.getArtifactsForPin(pinId),
    };
  }

  listPinsWithArtifacts(): PinWithArtifacts[] {
    return this.storage.getAllPins().map((pin) => ({
      ...pin,
      artifacts: this.storage.getArtifactsForPin(pin.id),
    }));
  }

  updatePin(
    pinId: string,
    patch: Partial<Pick<PinnedResponse, 'title' | 'tags' | 'note'>>
  ): PinWithArtifacts | undefined {
    const existing = this.storage.getPin(pinId);
    if (!existing) return undefined;
    const updated: PinnedResponse = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      updatedAt: Date.now(),
    };
    this.storage.savePin(updated);
    const artifacts = this.storage.getArtifactsForPin(pinId);
    this.emit({
      type: 'pin:updated',
      pinId,
      pin: updated,
      artifacts,
      timestamp: Date.now(),
    });
    return { ...updated, artifacts };
  }

  deletePin(pinId: string): boolean {
    const existing = this.storage.getPin(pinId);
    if (!existing) return false;
    this.storage.deletePin(pinId);
    this.emit({
      type: 'pin:deleted',
      pinId,
      timestamp: Date.now(),
    });
    return true;
  }

  search(query: SearchQuery): SearchResultItem[] {
    const pins = this.storage.getAllPins();
    const artifactsMap = new Map<string, ExtractedArtifact[]>();
    for (const pin of pins) {
      artifactsMap.set(pin.id, this.storage.getArtifactsForPin(pin.id));
    }
    return searchPinsAndArtifacts(pins, artifactsMap, query);
  }

  exportMarkdown(): string {
    const pins = this.listPinsWithArtifacts();
    const sections = pins.map((pin) => {
      const artifactSection =
        pin.artifacts.length > 0
          ? `\n### Extracted Artifacts (${pin.artifacts.length})\n` +
            pin.artifacts
              .map(
                (a, idx) =>
                  `#### ${idx + 1}. [${a.type.toUpperCase()}] ${a.title}\n` +
                  (a.explanation ? `_${a.explanation}_\n\n` : '') +
                  (a.type === 'table' || a.type === 'checklist' || a.type === 'decision'
                    ? `${a.content}\n`
                    : `\`\`\`${a.language || ''}\n${a.content}\n\`\`\`\n`)
              )
              .join('\n')
          : '';

      return [
        `# ${pin.title}`,
        `- **Platform**: ${pin.sourcePlatform}`,
        `- **Thread**: [${pin.threadTitle}](${pin.threadUrl})`,
        `- **Tags**: ${pin.tags.map((t) => `#${t}`).join(' ')}`,
        `- **Pinned At**: ${new Date(pin.createdAt).toISOString()}`,
        pin.summary ? `- **TL;DR**: ${pin.summary}` : '',
        pin.note ? `- **User Note**: ${pin.note}` : '',
        `\n### Prompt\n> ${pin.userPrompt.replace(/\n/g, '\n> ')}`,
        `\n### Full LLM Response\n${pin.rawMarkdown}`,
        artifactSection,
        `\n---\n`,
      ]
        .filter(Boolean)
        .join('\n');
    });

    return `# PinLLM Export (${pins.length} Pinned Responses)\n\n${sections.join('\n')}`;
  }
}

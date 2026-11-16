export type SourcePlatform = 'chatgpt' | 'claude' | 'gemini' | 'ollama' | 'openwebui' | 'custom';

export type ExtractionStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type ArtifactType =
  | 'code'
  | 'mermaid'
  | 'table'
  | 'command'
  | 'checklist'
  | 'json'
  | 'decision'
  | 'note';

export interface ExtractedArtifact {
  id: string;
  pinId: string;
  type: ArtifactType;
  title: string;
  language?: string;
  content: string;
  explanation?: string;
  lineStart?: number;
  lineEnd?: number;
  extractionMethod: 'ast' | 'agent';
  createdAt: number;
}

export interface PinnedResponse {
  id: string;
  sourcePlatform: SourcePlatform;
  threadUrl: string;
  threadTitle: string;
  messageSelector?: string;
  userPrompt: string;
  rawMarkdown: string;
  title: string;
  summary?: string;
  tags: string[];
  note?: string;
  extractionStatus: ExtractionStatus;
  extractionError?: string;
  extractionDurationMs?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PinWithArtifacts extends PinnedResponse {
  artifacts: ExtractedArtifact[];
}

export interface CreatePinInput {
  id?: string;
  sourcePlatform?: SourcePlatform;
  threadUrl?: string;
  threadTitle?: string;
  messageSelector?: string;
  userPrompt: string;
  rawMarkdown: string;
  title?: string;
  tags?: string[];
  note?: string;
}

export type SearchViewMode = 'all' | 'responses' | 'artifacts';

export interface SearchQuery {
  query: string;
  viewMode?: SearchViewMode;
  artifactType?: ArtifactType | 'all';
  language?: string | 'all';
  sourcePlatform?: SourcePlatform | 'all';
  tag?: string | 'all';
  limit?: number;
}

export interface SearchMatchLocation {
  field: 'title' | 'summary' | 'rawMarkdown' | 'userPrompt' | 'tags' | 'artifactTitle' | 'artifactContent' | 'artifactExplanation';
  artifactId?: string;
  artifactTitle?: string;
  artifactType?: ArtifactType;
  snippetHtml: string;
}

export interface SearchResultItem {
  resultType: 'pin' | 'artifact';
  score: number;
  pin: PinnedResponse;
  artifacts: ExtractedArtifact[];
  matchedArtifact?: ExtractedArtifact;
  matches: SearchMatchLocation[];
}

export interface LLMExtractorConfig {
  provider: 'heuristic' | 'openai' | 'anthropic' | 'gemini' | 'ollama';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  simulatedLatencyMs?: number;
}

export interface AgentEnrichmentResult {
  title: string;
  summary: string;
  tags: string[];
  implicitArtifacts: Array<{
    type: ArtifactType;
    title: string;
    language?: string;
    content: string;
    explanation?: string;
  }>;
  artifactTitleOverrides?: Record<number, { title: string; explanation?: string }>;
}

export type PinEventType =
  | 'pin:created'
  | 'pin:updated'
  | 'pin:deleted'
  | 'extraction:started'
  | 'extraction:stage1_complete'
  | 'extraction:completed'
  | 'extraction:failed';

export interface PinEvent {
  type: PinEventType;
  pinId: string;
  pin?: PinnedResponse;
  artifacts?: ExtractedArtifact[];
  timestamp: number;
  detail?: string;
}

import { DatabaseSync } from 'node:sqlite';
import type { PinStorageDriver } from './engine.ts';
import type { ExtractedArtifact, PinnedResponse } from './types.ts';

/**
 * Persistent SQLite + FTS5 storage driver using Node's native `node:sqlite`.
 * Stores full LLM responses and asynchronously extracted artifacts with full-text indexing.
 */
export class SqlitePinStorage implements PinStorageDriver {
  private db: DatabaseSync;

  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pins (
        id TEXT PRIMARY KEY,
        sourcePlatform TEXT NOT NULL,
        threadUrl TEXT NOT NULL,
        threadTitle TEXT NOT NULL,
        messageSelector TEXT,
        userPrompt TEXT NOT NULL,
        rawMarkdown TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        tagsJson TEXT NOT NULL,
        note TEXT,
        extractionStatus TEXT NOT NULL,
        extractionError TEXT,
        extractionDurationMs INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        pinId TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        language TEXT,
        content TEXT NOT NULL,
        explanation TEXT,
        lineStart INTEGER,
        lineEnd INTEGER,
        extractionMethod TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (pinId) REFERENCES pins(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_pinId ON artifacts(pinId);

      CREATE VIRTUAL TABLE IF NOT EXISTS pins_fts USING fts5(
        pinId UNINDEXED,
        title,
        summary,
        userPrompt,
        rawMarkdown,
        tags,
        note
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
        artifactId UNINDEXED,
        pinId UNINDEXED,
        type,
        title,
        language,
        content,
        explanation
      );
    `);
  }

  savePin(pin: PinnedResponse): void {
    const stmt = this.db.prepare(`
      INSERT INTO pins (
        id, sourcePlatform, threadUrl, threadTitle, messageSelector,
        userPrompt, rawMarkdown, title, summary, tagsJson, note,
        extractionStatus, extractionError, extractionDurationMs,
        createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        sourcePlatform = excluded.sourcePlatform,
        threadUrl = excluded.threadUrl,
        threadTitle = excluded.threadTitle,
        messageSelector = excluded.messageSelector,
        userPrompt = excluded.userPrompt,
        rawMarkdown = excluded.rawMarkdown,
        title = excluded.title,
        summary = excluded.summary,
        tagsJson = excluded.tagsJson,
        note = excluded.note,
        extractionStatus = excluded.extractionStatus,
        extractionError = excluded.extractionError,
        extractionDurationMs = excluded.extractionDurationMs,
        updatedAt = excluded.updatedAt
    `);

    stmt.run(
      pin.id,
      pin.sourcePlatform,
      pin.threadUrl,
      pin.threadTitle,
      pin.messageSelector ?? null,
      pin.userPrompt,
      pin.rawMarkdown,
      pin.title,
      pin.summary ?? null,
      JSON.stringify(pin.tags || []),
      pin.note ?? null,
      pin.extractionStatus,
      pin.extractionError ?? null,
      pin.extractionDurationMs ?? null,
      pin.createdAt,
      pin.updatedAt
    );

    // Sync FTS5 row
    this.db.prepare('DELETE FROM pins_fts WHERE pinId = ?').run(pin.id);
    this.db
      .prepare(
        `INSERT INTO pins_fts (pinId, title, summary, userPrompt, rawMarkdown, tags, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        pin.id,
        pin.title,
        pin.summary ?? '',
        pin.userPrompt,
        pin.rawMarkdown,
        (pin.tags || []).join(' '),
        pin.note ?? ''
      );
  }

  private rowToPin(row: any): PinnedResponse {
    return {
      id: row.id,
      sourcePlatform: row.sourcePlatform,
      threadUrl: row.threadUrl,
      threadTitle: row.threadTitle,
      messageSelector: row.messageSelector ?? undefined,
      userPrompt: row.userPrompt,
      rawMarkdown: row.rawMarkdown,
      title: row.title,
      summary: row.summary ?? undefined,
      tags: JSON.parse(row.tagsJson || '[]'),
      note: row.note ?? undefined,
      extractionStatus: row.extractionStatus,
      extractionError: row.extractionError ?? undefined,
      extractionDurationMs: row.extractionDurationMs ?? undefined,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  private rowToArtifact(row: any): ExtractedArtifact {
    return {
      id: row.id,
      pinId: row.pinId,
      type: row.type,
      title: row.title,
      language: row.language ?? undefined,
      content: row.content,
      explanation: row.explanation ?? undefined,
      lineStart: row.lineStart ?? undefined,
      lineEnd: row.lineEnd ?? undefined,
      extractionMethod: row.extractionMethod,
      createdAt: Number(row.createdAt),
    };
  }

  getPin(id: string): PinnedResponse | undefined {
    const row = this.db.prepare('SELECT * FROM pins WHERE id = ?').get(id);
    return row ? this.rowToPin(row) : undefined;
  }

  getAllPins(): PinnedResponse[] {
    const rows = this.db.prepare('SELECT * FROM pins ORDER BY createdAt DESC').all();
    return rows.map((r) => this.rowToPin(r));
  }

  deletePin(id: string): void {
    this.db.prepare('DELETE FROM artifacts WHERE pinId = ?').run(id);
    this.db.prepare('DELETE FROM artifacts_fts WHERE pinId = ?').run(id);
    this.db.prepare('DELETE FROM pins_fts WHERE pinId = ?').run(id);
    this.db.prepare('DELETE FROM pins WHERE id = ?').run(id);
  }

  saveArtifacts(pinId: string, artifacts: ExtractedArtifact[]): void {
    this.db.prepare('DELETE FROM artifacts WHERE pinId = ?').run(pinId);
    this.db.prepare('DELETE FROM artifacts_fts WHERE pinId = ?').run(pinId);

    const insertArt = this.db.prepare(`
      INSERT INTO artifacts (
        id, pinId, type, title, language, content, explanation,
        lineStart, lineEnd, extractionMethod, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertFts = this.db.prepare(`
      INSERT INTO artifacts_fts (
        artifactId, pinId, type, title, language, content, explanation
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const art of artifacts) {
      insertArt.run(
        art.id,
        pinId,
        art.type,
        art.title,
        art.language ?? null,
        art.content,
        art.explanation ?? null,
        art.lineStart ?? null,
        art.lineEnd ?? null,
        art.extractionMethod,
        art.createdAt
      );
      insertFts.run(
        art.id,
        pinId,
        art.type,
        art.title,
        art.language ?? '',
        art.content,
        art.explanation ?? ''
      );
    }
  }

  getArtifactsForPin(pinId: string): ExtractedArtifact[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE pinId = ? ORDER BY rowid ASC')
      .all(pinId);
    return rows.map((r) => this.rowToArtifact(r));
  }

  getAllArtifacts(): ExtractedArtifact[] {
    const rows = this.db.prepare('SELECT * FROM artifacts ORDER BY createdAt DESC').all();
    return rows.map((r) => this.rowToArtifact(r));
  }

  /**
   * Direct SQLite FTS5 query across both `pins_fts` and `artifacts_fts`.
   */
  ftsMatchPinIds(rawQuery: string): Set<string> {
    const cleanTokens = rawQuery
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/[^a-zA-Z0-9_-]/g, ''))
      .filter(Boolean);
    if (cleanTokens.length === 0) return new Set();

    const ftsExpr = cleanTokens.map((t) => `"${t}"*`).join(' AND ');
    const matchedPinIds = new Set<string>();

    const pinRows = this.db
      .prepare('SELECT pinId FROM pins_fts WHERE pins_fts MATCH ?')
      .all(ftsExpr) as Array<{ pinId: string }>;
    for (const r of pinRows) matchedPinIds.add(r.pinId);

    const artRows = this.db
      .prepare('SELECT pinId FROM artifacts_fts WHERE artifacts_fts MATCH ?')
      .all(ftsExpr) as Array<{ pinId: string }>;
    for (const r of artRows) matchedPinIds.add(r.pinId);

    return matchedPinIds;
  }
}

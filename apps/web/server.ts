import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PinEngine,
  SqlitePinStorage,
  type ArtifactType,
  type PinEvent,
  type SearchViewMode,
  type SourcePlatform,
} from '../../packages/core/index.ts';
import { SIMULATED_THREADS } from './seed-chats.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, '../../.data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const dbPath = process.env.PINLLM_DB_PATH || path.join(DATA_DIR, 'pinllm.sqlite');
const storage = new SqlitePinStorage(dbPath);
const engine = new PinEngine({
  storage,
  extractorConfig: {
    provider: 'heuristic',
    simulatedLatencyMs: 650,
  },
});

// Seed initial pin if database is empty so user can immediately test search & inspect
if (engine.listPinsWithArtifacts().length === 0) {
  const pgThread = SIMULATED_THREADS[1];
  const pgPrompt = pgThread.messages[0].content;
  const pgResponse = pgThread.messages[1].content;
  engine.pinResponse({
    id: 'pin_seed_pg_rrf',
    sourcePlatform: pgThread.platform,
    threadUrl: pgThread.url,
    threadTitle: pgThread.title,
    messageSelector: 'msg-pg-2',
    userPrompt: pgPrompt,
    rawMarkdown: pgResponse,
  });
}

// Track connected SSE clients for real-time async extraction updates
const sseClients = new Set<http.ServerResponse>();
const recentEvents: PinEvent[] = [];

engine.subscribe((event) => {
  recentEvents.unshift(event);
  if (recentEvents.length > 40) recentEvents.pop();
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
});

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function createPinServer() {
  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      // SSE stream for real-time async extraction status
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write(`data: ${JSON.stringify({ type: 'connected', recentEvents: recentEvents.slice(0, 12) })}\n\n`);
        sseClients.add(res);
        req.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }

      // Simulated chat threads
      if (req.method === 'GET' && pathname === '/api/threads') {
        sendJson(res, 200, { threads: SIMULATED_THREADS });
        return;
      }

      // List all pins with artifacts
      if (req.method === 'GET' && pathname === '/api/pins') {
        const pins = engine.listPinsWithArtifacts();
        sendJson(res, 200, { pins, recentEvents: recentEvents.slice(0, 15) });
        return;
      }

      // Create pin synchronously + queue async extraction
      if (req.method === 'POST' && pathname === '/api/pins') {
        const body = await readJsonBody(req);
        if (!body.rawMarkdown) {
          sendJson(res, 400, { error: 'rawMarkdown is required' });
          return;
        }
        const { pin } = engine.pinResponse({
          id: body.id,
          sourcePlatform: body.sourcePlatform || 'custom',
          threadUrl: body.threadUrl || '#chat',
          threadTitle: body.threadTitle || 'Chat Session',
          messageSelector: body.messageSelector,
          userPrompt: body.userPrompt || '',
          rawMarkdown: body.rawMarkdown,
          title: body.title,
          tags: body.tags,
          note: body.note,
        });
        sendJson(res, 201, { pin });
        return;
      }

      // Hybrid Search across full responses and extracted artifacts
      if (req.method === 'GET' && pathname === '/api/search') {
        const query = url.searchParams.get('q') || '';
        const viewMode = (url.searchParams.get('viewMode') || 'all') as SearchViewMode;
        const artifactType = (url.searchParams.get('artifactType') || 'all') as ArtifactType | 'all';
        const language = url.searchParams.get('language') || 'all';
        const sourcePlatform = (url.searchParams.get('sourcePlatform') || 'all') as SourcePlatform | 'all';
        const tag = url.searchParams.get('tag') || 'all';

        const results = engine.search({
          query,
          viewMode,
          artifactType,
          language,
          sourcePlatform,
          tag,
        });

        // Compute facets across all stored pins & artifacts
        const allPins = engine.listPinsWithArtifacts();
        const tagCounts: Record<string, number> = {};
        const artifactTypeCounts: Record<string, number> = {};
        const platformCounts: Record<string, number> = {};
        let totalArtifacts = 0;

        for (const p of allPins) {
          platformCounts[p.sourcePlatform] = (platformCounts[p.sourcePlatform] || 0) + 1;
          for (const t of p.tags) {
            tagCounts[t] = (tagCounts[t] || 0) + 1;
          }
          for (const a of p.artifacts) {
            totalArtifacts++;
            artifactTypeCounts[a.type] = (artifactTypeCounts[a.type] || 0) + 1;
          }
        }

        sendJson(res, 200, {
          results,
          stats: {
            totalPins: allPins.length,
            totalArtifacts,
            tagCounts,
            artifactTypeCounts,
            platformCounts,
          },
        });
        return;
      }

      // Update pin (note / title / tags)
      if (req.method === 'PATCH' && pathname.startsWith('/api/pins/')) {
        const pinId = decodeURIComponent(pathname.replace('/api/pins/', ''));
        const body = await readJsonBody(req);
        const updated = engine.updatePin(pinId, {
          title: body.title,
          tags: body.tags,
          note: body.note,
        });
        if (!updated) {
          sendJson(res, 404, { error: 'Pin not found' });
          return;
        }
        sendJson(res, 200, { pin: updated });
        return;
      }

      // Re-run async extraction
      if (req.method === 'POST' && pathname.endsWith('/reextract') && pathname.startsWith('/api/pins/')) {
        const pinId = decodeURIComponent(
          pathname.replace('/api/pins/', '').replace('/reextract', '')
        );
        engine.runAsyncExtraction(pinId);
        sendJson(res, 202, { status: 'queued', pinId });
        return;
      }

      // Delete pin
      if (req.method === 'DELETE' && pathname.startsWith('/api/pins/')) {
        const pinId = decodeURIComponent(pathname.replace('/api/pins/', ''));
        const deleted = engine.deletePin(pinId);
        sendJson(res, 200, { deleted, pinId });
        return;
      }

      // Extractor config
      if (req.method === 'GET' && pathname === '/api/config') {
        sendJson(res, 200, { config: engine.getExtractorConfig() });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/config') {
        const body = await readJsonBody(req);
        const updated = engine.setExtractorConfig(body);
        sendJson(res, 200, { config: updated });
        return;
      }

      // Export Markdown
      if (req.method === 'GET' && pathname === '/api/export/markdown') {
        const md = engine.exportMarkdown();
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': 'attachment; filename="pinllm-export.md"',
        });
        res.end(md);
        return;
      }

      // Export JSON
      if (req.method === 'GET' && pathname === '/api/export/json') {
        sendJson(res, 200, {
          exportedAt: new Date().toISOString(),
          pins: engine.listPinsWithArtifacts(),
        });
        return;
      }

      // Static files
      const filePath =
        pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
      if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err: any) {
      sendJson(res, 500, { error: err?.message || 'Internal Server Error' });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const port = Number(process.env.PORT || 4173);
  const server = createPinServer();
  server.listen(port, () => {
    console.log(`PinLLM server running at http://localhost:${port}`);
  });
}

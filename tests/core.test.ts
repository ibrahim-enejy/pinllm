import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PinEngine,
  SqlitePinStorage,
  type PinEvent,
} from '../packages/core/index.ts';
import { SIMULATED_THREADS } from '../apps/web/seed-chats.ts';

const SAMPLE_LLM_RESPONSE = `
## Distributed Token Bucket Rate Limiter with Redis & Lua

To prevent race conditions across multiple API gateway instances, perform the token bucket check and decrement atomically inside a Redis Lua script.

> [!IMPORTANT]
> **Architectural Decision**: Never use separate \`GET\` and \`SET\` commands for rate limiting in a distributed cluster—clock drift and concurrent requests will bypass limits under burst traffic.

### 1. Request Flow Diagram

\`\`\`mermaid
sequenceDiagram
    participant Client
    participant Gateway as API Gateway
    participant Redis as Redis Cluster
    Client->>Gateway: POST /v1/chat/completions
    Gateway->>Redis: EVALSHA token_bucket.lua (key, rate, burst)
    Redis-->>Gateway: [allowed: 1, remaining: 42]
    Gateway-->>Client: 200 OK (X-RateLimit-Remaining: 42)
\`\`\`

### 2. Atomic Lua + TypeScript Middleware

\`\`\`typescript
// src/middleware/rateLimit.ts
import type { Redis } from 'ioredis';

const LUA_TOKEN_BUCKET = \`
  local key = KEYS[1]
  local capacity = tonumber(ARGV[1])
  return capacity
\`;

export async function checkTokenBucket(redis: Redis, userId: string): Promise<boolean> {
  const result = await redis.eval(LUA_TOKEN_BUCKET, 1, \`rl:\${userId}\`, 100);
  return Number(result) > 0;
}
\`\`\`

### 3. Algorithm Trade-offs

| Algorithm | Burst Handling | Memory Overhead | Atomic Accuracy |
| :--- | :--- | :--- | :--- |
| Token Bucket | Excellent | Low (2 keys/user) | High (via Lua) |
| Sliding Window Log | Exact | High (sorted set) | High |

### 4. Production Rollout Checklist

- [x] Load Lua script via \`SCRIPT LOAD\` on gateway startup
- [ ] Configure Redis replica read-failover timeout to 50ms
- [ ] Add Prometheus counter \`http_ratelimit_rejected_total\`

\`\`\`bash
redis-cli --eval src/scripts/token_bucket.lua rl:user_123 , 100 10
\`\`\`
`.trim();

describe('PinLLM Core Engine & Async Extraction Pipeline', () => {
  it('synchronously pins the full LLM response immediately and extracts artifacts asynchronously', async () => {
    const storage = new SqlitePinStorage(':memory:');
    const engine = new PinEngine({
      storage,
      extractorConfig: { provider: 'heuristic', simulatedLatencyMs: 25 },
    });

    const events: PinEvent[] = [];
    engine.subscribe((e) => events.push(e));

    const { pin, extractionPromise } = engine.pinResponse({
      sourcePlatform: 'claude',
      threadUrl: 'https://claude.ai/chat/rate-limit-design',
      threadTitle: 'Distributed Rate Limiter Architecture',
      userPrompt: 'How do I design an atomic distributed rate limiter using Redis and TypeScript?',
      rawMarkdown: SAMPLE_LLM_RESPONSE,
    });

    // 1. Verify instant synchronous state
    assert.equal(pin.extractionStatus, 'pending');
    assert.equal(pin.rawMarkdown, SAMPLE_LLM_RESPONSE);
    assert.equal(events[0]?.type, 'pin:created');

    // Immediately searchable by full response prose even BEFORE async extraction finishes!
    const immediateSearch = engine.search({ query: 'race conditions' });
    assert.equal(immediateSearch.length, 1);
    assert.equal(immediateSearch[0].pin.id, pin.id);

    // 2. Wait for asynchronous extraction to complete
    const completed = await extractionPromise;
    assert.equal(completed.extractionStatus, 'completed');
    assert.ok(completed.title.includes('Distributed Token Bucket Rate Limiter'));
    assert.ok(completed.summary && completed.summary.length > 20);
    assert.ok(completed.tags.includes('caching') || completed.tags.includes('typescript'));

    // Verify lifecycle events fired in order
    const eventTypes = events.map((e) => e.type);
    assert.deepEqual(eventTypes, [
      'pin:created',
      'extraction:started',
      'extraction:stage1_complete',
      'extraction:completed',
    ]);

    // Verify all artifact types were extracted (mermaid, code, table, checklist, command, decision)
    const artifactTypes = new Set(completed.artifacts.map((a) => a.type));
    assert.ok(artifactTypes.has('mermaid'), 'Should extract Mermaid diagram');
    assert.ok(artifactTypes.has('code'), 'Should extract TypeScript code block');
    assert.ok(artifactTypes.has('table'), 'Should extract Markdown table');
    assert.ok(artifactTypes.has('checklist'), 'Should extract Checklist');
    assert.ok(artifactTypes.has('command'), 'Should extract CLI command');
    assert.ok(artifactTypes.has('decision'), 'Should extract implicit prose Architectural Decision');

    // Verify filename inference on code artifact
    const codeArtifact = completed.artifacts.find((a) => a.type === 'code');
    assert.equal(codeArtifact?.title, 'src/middleware/rateLimit.ts');
  });

  it('searches across both full responses and extracted artifacts with facet filtering', async () => {
    const storage = new SqlitePinStorage(':memory:');
    const engine = new PinEngine({
      storage,
      extractorConfig: { provider: 'heuristic', simulatedLatencyMs: 5 },
    });

    const { extractionPromise: p1 } = engine.pinResponse({
      sourcePlatform: 'claude',
      threadTitle: 'Rate Limiter Thread',
      userPrompt: 'Build a Redis token bucket middleware',
      rawMarkdown: SAMPLE_LLM_RESPONSE,
    });

    const { extractionPromise: p2 } = engine.pinResponse({
      sourcePlatform: 'chatgpt',
      threadTitle: 'Postgres Indexing',
      userPrompt: 'How to speed up JSONB queries in PostgreSQL?',
      rawMarkdown: `
## Optimizing PostgreSQL JSONB Queries with GIN Indexes

When querying deeply nested JSONB payloads, use \`jsonb_path_ops\` to reduce index size by up to 60%.

\`\`\`sql
CREATE INDEX CONCURRENTLY idx_events_payload_gin
ON analytics_events USING GIN (payload jsonb_path_ops);
\`\`\`
      `.trim(),
    });

    await Promise.all([p1, p2]);

    // 1. Search by symbol inside a code artifact
    const codeSearch = engine.search({ query: 'checkTokenBucket', viewMode: 'all' });
    assert.equal(codeSearch.length, 1);
    assert.equal(codeSearch[0].pin.sourcePlatform, 'claude');
    assert.ok(codeSearch[0].matchedArtifact);
    assert.equal(codeSearch[0].matchedArtifact?.title, 'src/middleware/rateLimit.ts');

    // 2. Search in 'artifacts' view mode filtered by type='mermaid'
    const mermaidResults = engine.search({
      query: 'EVALSHA',
      viewMode: 'artifacts',
      artifactType: 'mermaid',
    });
    assert.equal(mermaidResults.length, 1);
    assert.equal(mermaidResults[0].resultType, 'artifact');
    assert.equal(mermaidResults[0].matchedArtifact?.type, 'mermaid');
    assert.ok(mermaidResults[0].matches[0].snippetHtml.includes('<mark>EVALSHA</mark>'));

    // 3. Search SQLite FTS5 directly
    const ftsMatches = storage.ftsMatchPinIds('jsonb_path_ops');
    assert.equal(ftsMatches.size, 1);
  });

  it('extracts artifacts across all simulated multi-platform threads and exports Markdown', async () => {
    const engine = new PinEngine({
      storage: new SqlitePinStorage(':memory:'),
      extractorConfig: { provider: 'heuristic', simulatedLatencyMs: 5 },
    });

    const jobs: Promise<any>[] = [];
    for (const thread of SIMULATED_THREADS) {
      for (let i = 0; i < thread.messages.length; i++) {
        const msg = thread.messages[i];
        if (msg.role === 'assistant') {
          const prompt = i > 0 ? thread.messages[i - 1].content : '';
          const { extractionPromise } = engine.pinResponse({
            sourcePlatform: thread.platform,
            threadUrl: thread.url,
            threadTitle: thread.title,
            messageSelector: msg.id,
            userPrompt: prompt,
            rawMarkdown: msg.content,
          });
          jobs.push(extractionPromise);
        }
      }
    }

    await Promise.all(jobs);

    const allPins = engine.listPinsWithArtifacts();
    assert.equal(allPins.length, 4);

    // Search for Kubernetes preStop hook inside YAML artifact
    const k8sSearch = engine.search({ query: 'preStop', viewMode: 'all' });
    assert.equal(k8sSearch.length, 1);
    assert.equal(k8sSearch[0].pin.sourcePlatform, 'gemini');

    // Verify Markdown export includes both full response and extracted artifacts
    const md = engine.exportMarkdown();
    assert.ok(md.includes('# PinLLM Export (4 Pinned Responses)'));
    assert.ok(md.includes('### Full LLM Response'));
    assert.ok(md.includes('### Extracted Artifacts'));
  });
});

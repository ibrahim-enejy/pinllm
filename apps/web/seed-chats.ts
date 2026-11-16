import type { SourcePlatform } from '../../packages/core/index.ts';

export interface SimulatedChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  modelName?: string;
}

export interface SimulatedChatThread {
  id: string;
  platform: SourcePlatform;
  title: string;
  url: string;
  modelBadge: string;
  messages: SimulatedChatMessage[];
}

export const SIMULATED_THREADS: SimulatedChatThread[] = [
  {
    id: 'thread-rate-limiter',
    platform: 'claude',
    title: 'Distributed Redis Token Bucket Rate Limiter',
    url: 'https://claude.ai/chat/distributed-rate-limiter',
    modelBadge: 'Claude 3.7 Sonnet',
    messages: [
      {
        id: 'msg-rl-1',
        role: 'user',
        timestamp: '10:14 AM',
        content:
          'We run 12 Node.js API gateway pods behind an ALB and our current in-memory rate limiter lets bursts through. How should we implement an atomic distributed token bucket in Redis with TypeScript, and how does it compare to sliding window?',
      },
      {
        id: 'msg-rl-2',
        role: 'assistant',
        timestamp: '10:14 AM',
        modelName: 'Claude 3.7 Sonnet',
        content: `## Atomic Distributed Token Bucket with Redis & Lua

When running 12 stateless Node.js gateway pods, reading a counter with \`GET\` and decrementing with \`DECR\` introduces a classic **time-of-check to time-of-use (TOCTOU)** race condition under concurrent burst traffic. The solution is to execute the refill calculation and token deduction inside a single atomic **Redis Lua script** (\`EVALSHA\`).

> [!IMPORTANT]
> **Architectural Decision**: Always use Redis server time (\` redis.call('TIME') \`) instead of passing \`Date.now()\` from Node.js pods. Clock skew of even 80ms across EC2 nodes can cause token buckets to reset prematurely or reject valid traffic.

### 1. Request & Refill Flow

\`\`\`mermaid
sequenceDiagram
    participant Client
    participant Pod as Gateway Pod (1..12)
    participant Redis as Redis Primary
    Client->>Pod: POST /v1/inference (API Key)
    Pod->>Redis: EVALSHA token_bucket_sha 1 "rl:org_99" 50 10
    Note over Redis: 1. Fetch [tokens, last_refill]<br/>2. Refill based on Redis TIME<br/>3. Deduct 1 token atomically
    Redis-->>Pod: [1, 49, 17100000]
    Pod-->>Client: 200 OK (X-RateLimit-Remaining: 49)
\`\`\`

### 2. TypeScript Middleware + Embedded Lua Script

\`\`\`typescript
// src/middleware/distributedRateLimiter.ts
import type { Redis } from 'ioredis';

const TOKEN_BUCKET_LUA = \`
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local requested = tonumber(ARGV[3])

local time_res = redis.call('TIME')
local now_ms = (tonumber(time_res[1]) * 1000) + math.floor(tonumber(time_res[2]) / 1000)

local bucket = redis.call('HMGET', key, 'tokens', 'last_updated')
local tokens = tonumber(bucket[1])
local last_updated = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  last_updated = now_ms
else
  local elapsed_sec = math.max(0, (now_ms - last_updated) / 1000.0)
  tokens = math.min(capacity, tokens + (elapsed_sec * refill_rate))
  last_updated = now_ms
end

if tokens < requested then
  return { 0, math.floor(tokens) }
end

tokens = tokens - requested
local ttl_sec = math.ceil((capacity / refill_rate) * 2)
redis.call('HMSET', key, 'tokens', tokens, 'last_updated', last_updated)
redis.call('EXPIRE', key, ttl_sec)
return { 1, math.floor(tokens) }
\`;

export async function enforceRateLimit(
  redis: Redis,
  tenantId: string,
  capacity = 100,
  refillPerSec = 20
): Promise<{ allowed: boolean; remaining: number }> {
  const [allowed, remaining] = (await redis.eval(
    TOKEN_BUCKET_LUA,
    1,
    \`ratelimit:\${tenantId}\`,
    capacity,
    refillPerSec,
    1
  )) as [number, number];

  return { allowed: allowed === 1, remaining };
}
\`\`\`

### 3. Algorithm Comparison Table

| Algorithm | Burst Tolerance | Redis Memory per User | Complexity | Best Use Case |
| :--- | :--- | :--- | :--- | :--- |
| **Token Bucket (Lua)** | High (controlled burst) | \`O(1)\` (Hash with 2 fields) | \`O(1)\` | Public APIs & LLM token quotas |
| **Sliding Window Log** | Strict (no edge burst) | \`O(N)\` (ZSET of timestamps) | \`O(log N)\` | High-security login / OTP endpoints |
| **Fixed Window Counter** | Vulnerable to 2x boundary spike | \`O(1)\` (Single string key) | \`O(1)\` | Coarse internal telemetry throttling |

### 4. Production Verification Checklist

- [x] Pre-warm script hash via \`redis.defineCommand\` on gateway boot
- [ ] Set \`enableOfflineQueue: false\` in \`ioredis\` so Redis hiccups fail-open within 40ms
- [ ] Emit \`ratelimit_throttled_total\` metric tagged by \`tenant_tier\`

\`\`\`bash
redis-cli --eval scripts/token_bucket.lua ratelimit:org_demo , 100 20 1
\`\`\``,
      },
      {
        id: 'msg-rl-3',
        role: 'user',
        timestamp: '10:18 AM',
        content: 'What happens if Redis is unreachable for 2 seconds during a failover? How do we fail open cleanly with a local fallback?',
      },
      {
        id: 'msg-rl-4',
        role: 'assistant',
        timestamp: '10:19 AM',
        modelName: 'Claude 3.7 Sonnet',
        content: `## Fail-Open Circuit Breaker with Local In-Memory Fallback

If your Redis primary experiences a network partition or replica promotion, waiting on default TCP timeouts will exhaust your Node.js event loop and cascade into a full gateway outage. Wrap the Redis evaluation in a **50ms timeout + local per-pod fallback bucket**.

**Key Decision**: During a Redis failover window, divide the tenant's global capacity by the active pod count (\`capacity / 12\`) in local memory so tenants stay roughly within their quota until Redis recovers.

\`\`\`typescript
// src/middleware/resilientLimiter.ts
import { enforceRateLimit } from './distributedRateLimiter.ts';

const localFallbackMap = new Map<string, { count: number; resetAt: number }>();

export async function checkLimitWithFallback(
  redis: any,
  tenantId: string,
  globalCapacity = 120,
  podCount = 12
) {
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('REDIS_TIMEOUT_50MS')), 50)
    );
    return await Promise.race([
      enforceRateLimit(redis, tenantId, globalCapacity, 20),
      timeout,
    ]);
  } catch {
    // Degrade gracefully to local pod memory
    const now = Date.now();
    const podQuota = Math.max(5, Math.floor(globalCapacity / podCount));
    const entry = localFallbackMap.get(tenantId);
    if (!entry || now > entry.resetAt) {
      localFallbackMap.set(tenantId, { count: 1, resetAt: now + 10_000 });
      return { allowed: true, remaining: podQuota - 1, degraded: true };
    }
    entry.count += 1;
    return {
      allowed: entry.count <= podQuota,
      remaining: Math.max(0, podQuota - entry.count),
      degraded: true,
    };
  }
}
\`\`\``,
      },
    ],
  },
  {
    id: 'thread-pg-hybrid-search',
    platform: 'chatgpt',
    title: 'PostgreSQL Hybrid Search (BM25 + pgvector RRF)',
    url: 'https://chatgpt.com/c/pg-hybrid-search-rrf',
    modelBadge: 'GPT-4o',
    messages: [
      {
        id: 'msg-pg-1',
        role: 'user',
        timestamp: 'Yesterday',
        content:
          'How can I combine full-text keyword search and pgvector cosine similarity in a single PostgreSQL query using Reciprocal Rank Fusion (RRF)?',
      },
      {
        id: 'msg-pg-2',
        role: 'assistant',
        timestamp: 'Yesterday',
        modelName: 'GPT-4o',
        content: `## Single-Query Hybrid Search in PostgreSQL using Reciprocal Rank Fusion (RRF)

Combining lexical search (\`tsvector\` / \`ts_rank_cd\`) with dense semantic search (\`pgvector\` HNSW index) using **Reciprocal Rank Fusion (RRF)** avoids brittle score normalization because RRF combines **rank positions** rather than raw scores:

$$\\text{RRF\\_Score}(d) = \\frac{1}{k + \\text{rank}_{\\text{fts}}(d)} + \\frac{1}{k + \\text{rank}_{\\text{vec}}(d)}$$

> [!TIP]
> **Why This Works**: Dense embeddings excel at conceptual synonyms (*"out of memory crash"* $\\leftrightarrow$ \`OOMKilled\`), while \`tsvector\` guarantees exact matches on error codes, function names, and SKUs. Setting $k = 60$ balances both signals without tuning weights per query.

### 1. Schema & Index Setup

\`\`\`sql
-- migrations/004_hybrid_search_indexes.sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_chunks (
  id BIGSERIAL PRIMARY KEY,
  doc_title TEXT NOT NULL,
  content TEXT NOT NULL,
  search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(doc_title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) STORED,
  embedding vector(1536) NOT NULL
);

CREATE INDEX idx_chunks_tsv ON knowledge_chunks USING GIN (search_tsv);
CREATE INDEX idx_chunks_embedding_hnsw ON knowledge_chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
\`\`\`

### 2. Single-Pass RRF SQL Query

\`\`\`sql
-- queries/hybrid_rrf_search.sql
WITH fulltext_ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (ORDER BY ts_rank_cd(search_tsv, websearch_to_tsquery('english', $1)) DESC) AS fts_rank
  FROM knowledge_chunks
  WHERE search_tsv @@ websearch_to_tsquery('english', $1)
  LIMIT 40
),
vector_ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (ORDER BY embedding <=> $2::vector) AS vec_rank
  FROM knowledge_chunks
  ORDER BY embedding <=> $2::vector
  LIMIT 40
)
SELECT
  c.id,
  c.doc_title,
  c.content,
  COALESCE(1.0 / (60 + f.fts_rank), 0.0) +
  COALESCE(1.0 / (60 + v.vec_rank), 0.0) AS rrf_score
FROM fulltext_ranked f
FULL OUTER JOIN vector_ranked v ON f.id = v.id
JOIN knowledge_chunks c ON c.id = COALESCE(f.id, v.id)
ORDER BY rrf_score DESC
LIMIT 10;
\`\`\`

### 3. Index Tuning Reference

| Parameter | Recommended Value | Impact on Recall & Latency |
| :--- | :--- | :--- |
| \`hnsw.ef_search\` | \`40 - 80\` | Higher increases recall at slight CPU cost |
| \`RRF constant k\` | \`60\` | Dampens outlier rank dominance |
| \`Candidate pool\` | \`40 per leg\` | Ensures top-10 overlap precision |`,
      },
    ],
  },
  {
    id: 'thread-zero-downtime-k8s',
    platform: 'gemini',
    title: 'Zero-Downtime Kubernetes Graceful Shutdown & PDB',
    url: 'https://gemini.google.com/app/k8s-zero-downtime',
    modelBadge: 'Gemini 2.5 Pro',
    messages: [
      {
        id: 'msg-k8s-1',
        role: 'user',
        timestamp: '2 days ago',
        content:
          'Our Kubernetes rolling deployments still drop ~0.3% of HTTP requests with 502 Bad Gateway even though we handle SIGTERM in Node.js. Why does this happen and how do we fix it?',
      },
      {
        id: 'msg-k8s-2',
        role: 'assistant',
        timestamp: '2 days ago',
        modelName: 'Gemini 2.5 Pro',
        content: `## Eliminating 502 Bad Gateways During Kubernetes Rolling Updates

The 502 errors happen because Kubernetes executes **two actions in parallel** when terminating a Pod:
1. \`kubelet\` sends \`SIGTERM\` to your container immediately.
2.The Endpoints controller removes the Pod IP from \`kube-proxy\` / Ingress upstream lists asynchronously.

If your Node.js server closes its listening socket immediately on \`SIGTERM\`, in-flight requests routed by the Ingress controller **100–3000ms later** hit a closed socket (\`ECONNREFUSED\` $\\rightarrow$ \`502 Bad Gateway\`).

> [!WARNING]
> **Root Cause**: Handling \`SIGTERM\` in application code is not sufficient on its own—you must add a \`preStop\` sleep hook so the Ingress load balancer finishes draining the Pod endpoint **before** \`SIGTERM\` is even delivered to your process.

### 1. Pod Termination Timeline

\`\`\`mermaid
flowchart LR
    Term["Pod Marked Terminating"] --> Parallel1["Endpoints Controller Removes Pod IP (1-3s propagation)"]
    Term --> Parallel2["kubelet Runs preStop Hook (sleep 10s)"]
    Parallel2 --> Sigterm["kubelet Sends SIGTERM to Node.js"]
    Sigterm --> Drain["server.close() Drains Active Connections"]
    Drain --> Exit["Clean Exit 0"]
\`\`\`

### 2. Production Deployment Manifest

\`\`\`yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
spec:
  replicas: 4
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  template:
    spec:
      terminationGracePeriodSeconds: 45
      containers:
        - name: api
          image: ghcr.io/org/api-service:1.14.0
          lifecycle:
            preStop:
              exec:
                command: ["sh", "-c", "sleep 10"]
          readinessProbe:
            httpGet:
              path: /healthz/ready
              port: 8080
            periodSeconds: 3
            failureThreshold: 2
\`\`\`

### 3. Rollout Verification Commands

\`\`\`bash
kubectl rollout status deployment/api-service -n production
kubectl get endpoints api-service -n production --watch
\`\`\`

### 4. Zero-Downtime Checklist

- [x] Set \`maxUnavailable: 0\` and \`maxSurge: 1\` in RollingUpdate strategy
- [x] Add \`preStop: sleep 10\` hook to absorb Ingress endpoint propagation delay
- [ ] Ensure \`terminationGracePeriodSeconds\` (45s) > \`preStop\` (10s) + \`server.close()\` drain timeout (25s)
- [ ] Configure \`keepAliveTimeout: 65000\` on Node.js HTTP server to exceed ALB idle timeout (60s)`,
      },
    ],
  },
];

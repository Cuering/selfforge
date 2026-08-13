# selfforge — Agent Memory Leaderboard Submission

**Submitted for:** Textual Memory track · Academic / Code route
**Version:** 1.9.3
**Repository:** https://github.com/Cuering/selfforge
**License:** MIT

---

## 1. System overview

selfforge is a self-evolving agent·memory engine. It persists conversation-derived
facts into a local SQLite store and retrieves them on demand. The benchmark entry
point is a small, dependency-free HTTP server exposing only the evaluation
contract endpoints (`/add`, `/search`, `/health`); the rest of the engine is
irrelevant to evaluation and is not part of the runtime image.

**Method disclosure (original work):**

- Retrieval is a zero-model, deterministic heuristic: token-overlap (word-level
  Jaccard-style query coverage) plus an exact-phrase bonus, then a gentle recency
  boost (`< 30 days`). Memory entries are ranked by relevance before being
  returned. No embedding model, no external LLM, no re-ranking service is used
  for retrieval.
- Storage is a local SQLite table (`bench_memories`). Writes are synchronous:
  `POST /add` persists every message before returning `HTTP 200`.
- Isolation follows the contract strictly: `user_id` is the only retrieval
  boundary; `/search` queries only rows stored under the exact `user_id`.
- No prompt injection surface: `/search` answers are never generated — only
  stored memory chunks are returned as evidence.

---

## 2. Repository layout (evaluation-relevant)

| Path                              | Role                                    |
|-----------------------------------|-----------------------------------------|
| `plugin/selfforge/lib/bench.ts`   | Contract logic: `benchAdd` / `benchSearch` |
| `plugin/selfforge/lib/rpc.ts`     | HTTP routing for `/add` `/search` `/health` |
| `plugin/selfforge/serve-daemon.ts`| Standalone server entrypoint            |
| `Dockerfile`                      | Evaluation image (build + run)          |
| `tests/bench.test.ts`             | Contract tests (isolation, top_k, add/search) |

---

## 3. How to build and run (Docker)

The platform builds the image from the submitted repository:

```bash
docker build -t selfforge-bench .
```

Run:

```bash
docker run --rm -p 9210:9210 \
  -e SELFFORGE_PORT=9210 \
  -e EVOLVE_HOME=/data \
  selfforge-bench
```

- Listens on `0.0.0.0:9210`.
- Data volume `/data` holds the SQLite store for evaluation memory.
- Endpoints: `POST /add`, `POST /search`, `GET /health`.
- No authentication is required (permitted by the contract for the academic route).

Run locally without Docker (requires bun; optional `bun build` for node):

```bash
bun plugin/selfforge/serve-daemon.ts      # or: bun cli/selfforge.ts serve
```

---

## 4. API contract

### Health

```
GET /health            → 200 "ok"
```

### Add (synchronous write)

Request (JSON):

```json
{
  "request_id": "eval:run_abc:conv-0:chunk-0",
  "messages": [
    { "role": "user", "timestamp": 1704067200000, "content": "memory text" }
  ],
  "user_id": "eval:run_abc:conv-0",
  "session_id": "eval:run_abc:sample:0"
}
```

Response `200` (only after persistence is searchable):

```json
{
  "success": true,
  "request_id": "eval:run_abc:conv-0:chunk-0",
  "user_id": "eval:run_abc:conv-0",
  "session_id": "eval:run_abc:sample:0",
  "stored": 1
}
```

- Does **not** return `202` / task id / polling URL.
- Echoes `request_id`, `user_id`, `session_id` byte-for-byte.

### Search (synchronous read)

Request (JSON):

```json
{
  "query": "which runtime did the user prefer?",
  "options": ["A. Node", "B. Bun"],
  "user_id": "eval:run_abc:conv-0",
  "top_k": 100
}
```

Response `200` (relevance-ordered, at most `top_k`):

```json
{
  "data": [
    {
      "id": "uuid-memory-1",
      "content": "the user prefers Node over Bun",
      "score": 0.87,
      "created_at": "2026-07-01T12:00:00Z"
    }
  ]
}
```

- `data` is a plain array (no `items` wrapper); empty array when nothing matches.
- Only memories under the exact `user_id` are ever returned (cross-user return is
  forbidden and never happens).
- `content` is the stored evidence text, passed directly to the platform answer
  model. selfforge does **not** generate answers.

---

## 5. Smoke test

```bash
# health
curl -s localhost:9210/health
# → ok

# add
curl -s -X POST localhost:9210/add -H 'content-type: application/json' -d '{
  "request_id":"r1",
  "messages":[{"role":"user","content":"the user prefers Node over Bun"}],
  "user_id":"u1","session_id":"s1"}'
# → {"success":true,...,"stored":1}

# search same user
curl -s -X POST localhost:9210/search -H 'content-type: application/json' -d '{
  "query":"runtime",
  "user_id":"u1",
  "top_k":10}'
# → {"data":[{"id":"...","content":"the user prefers Node over Bun","score":...}]}

# isolation: different user returns empty
curl -s -X POST localhost:9210/search -H 'content-type: application/json' -d '{
  "query":"runtime",
  "user_id":"u2",
  "top_k":10}'
# → {"data":[]}
```

---

## 6. Stability & compliance

- The endpoint is deterministic and synchronous; `Add` waits for the SQLite WAL
  write to commit before responding. Standard HTTP timeouts are well within the
  platform bounds for small chunk sizes.
- No external services, no outbound network calls, no model inference at runtime.
- Data retention: evaluation data lives in the Docker volume `/data` for the
  life of the evaluated run and is deleted per the platform's data-handling
  obligations when the container is removed.
- The implementer discloses: retrieval is heuristic (token-overlap + phrase
  bonus + recency), no embeddings, no fine-tuned reranker; all code is original
  in this repository. No other project's code is reused.

## 7. Points of contact

Author: see Git history / GitHub repository; leave a contact address in the
evaluation application form under the same repository.
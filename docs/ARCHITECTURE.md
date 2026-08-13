# selfforge Memory — Architecture & Improvement Blueprint

> 蓝本：按 Agent Memory Leaderboard 学术文本榜（agentmemories.ai/leaderboard/academic/textual）
> 7 大维度（A/B/C/D/E/G/H）对标，指导 selfforge 记忆系统从「零 LLM 启发式」升级为「可参赛的资深检索系统」。
>
> 本文档是开发蓝本：所有改动按此分层、以 `lib/bench-eval.ts` 本地评测为验收门。

---

## 0. 现状基线（2026-08-13）

### 已具备（评测契约）
| 模块 | 职责 | 状态 |
|------|------|------|
| `lib/bench.ts` | HTTP 契约 Add/Search；user_id 硬隔离；同步写入 | ✅ 已实现，5 测试过 |
| `lib/rpc.ts` `/add /search /health` | 路由接线 | ✅ 已实现 |
| `lib/bench-eval.ts` | 7 维度本地评测脚手架 | ✅ 已建（待跑） |
| `lib/memory.ts` | 产品记忆（衰减/去重/召回/注入） | ✅ 已有 |
| `lib/rules.ts` + goals | 规则评分 / 目标追踪 | ✅ 已有 |

### 当前检索能力（bench.ts）
```
score = phrase*1 + overlap*0.8 + recency*0.05
```
- token 重叠 + 精确短语 + 近因
- **零语义、零关系、零时序重建、零同义扩展**

### 评测维度的当前薄弱点
| 维度 | 目前 | 差距根因 |
|------|------|---------|
| A 显式召回 | 中 | 无语义/同义匹配；查询与存储措辞不同即漏 |
| B 多跳组合 | 弱 | 每条记忆孤立，无实体/关系关联加权 |
| C 时序 | 弱 | 只做近因加成，无事件链/先后重排 |
| D 治理 | 强 | 衰减/去重/TTL/冲突已有基础 |
| E 个性化 | 中 | 偏好类记忆无类型加权 |
| G 规则 | 中 | 规则句无专门检索加权 |
| H 隐私 | 强 | user_id 硬隔离 ✅ |

---

## 1. 分层架构

```
┌─────────────────────────────────────────────────────────┐
│  评测契约层（与 agentmemories.ai 契约一致）                │
│    POST /add · POST /search · GET /health               │
│    lib/bench.ts（路由在 lib/rpc.ts）                      │
├─────────────────────────────────────────────────────────┤
│  检索管道 SearchPipeline（本次核心改造）                   │
│    query 分析 → 召回 → 维度加权 → 排序 → top_k            │
│    lib/retrieve.ts（新增）                                │
├─────────────────────────────────────────────────────────┤
│  维度增强器（Retriever 一查多用，零 LLM 亦可）              │
│    A 词义扩展 · B 实体关系 · C 时间序 · D 治理 ·           │
│    E 偏好加权 · G 规则加权 · H 隔离保证                    │
│    lib/retrieve-dimensions.ts（新增）                    │
├─────────────────────────────────────────────────────────┤
│  写入处理（IngestPipeline @ Add 时）                       │
│    原文 → 分块 → 实体抽取 → 关系/事件链 → 冲突消解 → 落库   │
│    lib/ingest.ts（新增）                                  │
├─────────────────────────────────────────────────────────┤
│  基础设施                                                │
│    SQLite 表（bench_memories + 新增 bench_entities /     │
│    bench_relations / bench_timeline）                    │
│    lib/bench-schema.ts（新增，集中建表）                  │
└─────────────────────────────────────────────────────────┘
```

---

## 2. 数据模型（Schema）

### 现有 `bench_memories`（保留）
`id, uuid, user_id, session_id, role, content, memory_ts, created_at, deleted`

### 新增 `bench_entities`（B 维度支撑）
```sql
CREATE TABLE IF NOT EXISTS bench_entities (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  memory_id INTEGER NOT NULL,      -- 关联 bench_memories.id
  name TEXT NOT NULL,              -- 实体名（归一化小写）
  type TEXT DEFAULT 'org',         -- person/org/place/date/product/…
  created_at TEXT
);
CREATE INDEX idx_be_user_name ON bench_entities(user_id, name);
```

### 新增 `bench_relations`（B 维度支撑）
```sql
CREATE TABLE IF NOT EXISTS bench_relations (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  sub TEXT NOT NULL, out TEXT NOT NULL, obj TEXT NOT NULL,
  memory_id INTEGER,
  created_at TEXT
);
CREATE INDEX idx_br_user ON bench_relations(user_id, sub, obj);
```

### 新增 `bench_timeline`（C 维度支撑）
```sql
CREATE TABLE IF NOT EXISTS bench_timeline (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  memory_id INTEGER NOT NULL,
  seq INTEGER,                      -- 会话内事件序号
  ts INTEGER,                      -- memory_ts 冗余（便于排序）
  created_at TEXT
);
CREATE INDEX idx_bt_user OF bench_timeline(user_id, seq);
```

---

## 3. 检索管道设计（core: lib/retrieve.ts）

```
search(query, user_id, top_k):
  1) query 分析：分词 + 查询意图（fact/relation/temp/entity）轻分类
  2) 召回候选：
     a. 词重叠候选（现有 overlapScore，略调）
     b. 同义扩展候选（同义词/近形字扩展后重叠）
     c. 实体关联候选（若 query 含已索引实体 → 拉该实体相关记忆）
     d. 时间过滤候选（若 query 含 before/after/next/之前/然后 → 限时窗）
  3) 维度加权（每维独立权重，可配置）：
     score = overlap*0.7 + phrase*0.15 + recency*0.05
           + entityLink*0.2  (B)
           + temporalFit*0.2  (C)
           + typeBoost        (E: preference 类, G: rule 类)
  4) 排序 → top_k → 返回 {data:[{id, content, score}]}
```

### 加权配置（lib/retrieve-dimensions.ts 导出常量，可调）
```ts
export const DIM_WEIGHTS = {
  overlap: 0.7, phrase: 0.15, recency: 0.05,
  entityLink: 0.2, temporalFit: 0.2,      // B/C，命中才加入
  prefBoost: +0.3, ruleBoost: +0.3,       // E/G
}
```

---

## 4. 写入处理设计（core: lib/ingest.ts）

```
add(user_id, messages, …):
  0) 写入原文到 bench_memories（现有逻辑保留）
  1) 实体抽取（零 LLM 规则式）：
     - 专名：首字母大写词、自带引号 "*" 的短语
     - 中英混合：匹配名单/公司/城市常识小辞典（内置小表）
     - 写入 bench_entities
  2) 关系抽取（简单 pattern）：
     - "X works at Y" / "X is Y's Z" / "X is headquartered in Y"
     - 写入 bench_relations
  3) 时序登记：
     - 同一 session 按到达顺序 seq++ 写 bench_timeline
  4) 冲突消解（D 增强）：
     - 同 user 同内容 → 更新 updated_at（不重复落库）
     - 含 "superseded"/"旧"/"NEWKEY" 类标记 → 旧记忆降权（deleted 或 score 折扣）
  5) 同步返回（契约）
```

---

## 5. 7 维度落地清单（验收 = lib/bench-eval.ts 该维 precision 提升）

| 维度 | 改动文件 | 机制 | 验收阈值（本地） |
|------|---------|------|----------------|
| A 显式召回 | retrieve.ts + ingest 规范化 | 同义扩展 + 大小写/空格归一化 | ≥ 80% |
| B 多跳组合 | bench_entities/relations + entityLink 加权 | 实体 → 关联记忆同回 | 测试期望：Alice→Berlin 全召回 |
| C 时序 | bench_timeline + temporalFit | before/after/next/之后 意图 → 按 seq 限窗重排 | ≥ 60% |
| D 治理 | ingest 冲突消解 + memory_ts | superseded 降权；更新优先 | 新增 case 期望 NEWKEY |
| E 个性化 | typeBoost(preference) | Add 时标记 type 或关键字识别偏好句 | ≥ 80% |
| G 规则 | typeBoost(rule) | Add 时识别 "rule:" 前缀 | ≥ 80% |
| H 隐私 | bench.ts user_id 隔离（保持） | 跨 user 恒空 | 100%（现值） |

---

## 6. 开发里程碑（Milestones）

### M0 基线（先做）
- [x] bench.ts / rpc 契约 ✅
- [x] bench-eval.ts 脚手架 ✅
- [ ] 跑 `bun run eval-bench`（CLI）输出当前基线分（记录到 docs/bench-baseline.md）
- [ ] 固定基线，后续每步对比

### M1 检索三项（A/D/G 快赢）
- [ ] `lib/retrieve.ts`：同义扩展 + 类型加权（E/G 关键字识别）
- [ ] `lib/ingest.ts`：写入规范化 + 冲突消解（D）
- [ ] bench-eval 跑分，A/E/G 各应明显回升

### M2 关系与时序（B/C 攻坚）
- [ ] bench_entities / bench_relations / bench_timeline 建表 + ingest 抽取
- [ ] retrieve: entityLink + temporalFit 插桩
- [ ] bench-eval B/C 加 case，跑分

### M3 达标收尾
- [ ] 全维度本地 ≥ 目标值
- [ ] 文档 docs/bench-result.md
- [ ] （可选）评审申请时附本地基线

---

## 7. 验证方式（晨检）

```bash
# 写一个 CLI：bun plugin/selfforge/lib/bench-eval-cli.ts
bun run eval-bench
# → 输出 7 维度 precision + 明细
# 改动任何 retrieve/ingest 后都跑它，作为回归门
```

任何改动需满足：**bench-eval 各维度 precision 不低于上一版**，否则回退。

---

## 8. 诚实边界

- **B 多跳、C 时序**：本地评测只测「相关证据是否被 top-k 召回」。最终答案由榜单裁判 LLM 组合，selfforge 职责是把**同一 user 内的多条相关记忆都送进 top_k=100**。
- **零 LLM**：全部规则式实现，无 embedding（除非评审环境允许外呼且用户配 key；否则 A 维对标 SQLite-FTS-Baseline 41.79 量级）。
- **D/H 已是强项**：保持不回归，不浪费精力。

---

## 9. 文件清单

| 文件 | 类型 | 状态 |
|------|------|------|
| `lib/bench.ts` | 契约 | 已有 |
| `lib/bench-eval.ts` | 本地评测脚手架 | 已有（待填 case 与 CLI） |
| `lib/bench-schema.ts` | 新增表 | 待建 |
| `lib/ingest.ts` | 写入处理 | 待建 |
| `lib/retrieve.ts` | 检索管道 | 待建 |
| `lib/retrieve-dimensions.ts` | 维度权重配置 | 待建 |
| `lib/bench-eval-cli.ts` | CLI 入口 | 待建 |
| `docs/bench-baseline.md` | 基线记录 | 待建 |
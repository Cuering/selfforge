# selfforge

面向[OpenCode](https://opencode.ai)的统一自进化引擎。一个插件把多类能力合并进单一存储，用同一套工具驱动。

Selfforge从对话中学习，跟踪目标，管理持久记忆，提炼并优化可复用技能，把行为规则升级进AGENTS.md，自动修复自己的决策，并在多个智能体、多台机器与团队之间同步知识——全部通过一个插件和一份SQLite数据库完成。

## 合并了什么

|能力|来源|表面工具|
|---|---|---|
|对话监控与复盘|autolearn|事件钩子、复盘子代理|
|持久记忆与用户画像|autolearn|`memory_*`、`user_*`|
|技能提炼与优化|autolearn+opencode-self-improving-skills|`skill_*`、`evolution_*`|
|行为规则写入AGENTS.md|self-improving-agent|`rule_*`|
|目标驱动的PDCA循环|miles990/self-evolving-agent|`goal_*`、检查点CP0–CP6.5|
|技能生命周期管理|autolearn|`curator_*`|
|技能试用生命周期+防幻觉验证|MemOS(memos-local-plugin)|`skill_status`、`skill_feedback`、`skill_verify`、`pattern_*`|
|决策修复(反馈→修复草稿)|MemOS`core/feedback`+`core/decision-repair`|`repair_*`、`feedback_classify`|
|工作环境感知|MemOS工作区指纹|`workspace_*`、作用域召回|
|跨智能体/平台迁移|自研|`transfer_*`、`cli/selfforge.ts`、本地JSON-RPC|
|团队共享记忆|自研(git支撑)|`team_*`|

所有数据存放在同一份SQLite数据库：`~/.evolve/unified.db`（或`$EVOLVE_HOME`）。

## 安装

一行命令（下载并安装）：

```bash
curl -sSL https://raw.githubusercontent.com/Cuering/selfforge/main/install-remote.sh | bash
```

从本地克隆手动安装：

```bash
git clone https://github.com/Cuering/selfforge.git
bash selfforge/install.sh
# 重启 opencode
```

手动安装：

1. 复制插件与技能：
   - `plugin/selfforge.ts`+`plugin/lib/**`→`~/.config/opencode/plugins/`
   - `skills/selfforge/`→`~/.agents/skills/selfforge/`
   - `skills/evolve-reviewer/`→`~/.agents/skills/evolve-reviewer/`
2. 在`~/.config/opencode/opencode.json`中注册：

```jsonc
{
  "plugin": ["./plugins/selfforge.ts"],
  "instructions": ["~/.evolve/memory.context.md"],
  "agent": {
    "evolve-reviewer": {
      "description": "Reviews past conversations for self-improvement opportunities",
      "hidden": true,
      "steps": 20,
      "prompt": "Load the selfforge skill and follow its review workflow to review the attached conversation for learning opportunities. Take immediate action: record observations, update memory, create or patch skills, track goals.",
      "permission": {
        "bash": "allow", "read": "allow", "glob": "allow", "grep": "allow",
        "write": "allow", "edit": "deny", "webfetch": "deny", "task": "deny",
        "skill": "allow", "external_directory": "allow"
      }
    }
  }
}
```

3. 重启opencode。首次加载时插件会创建`~/.evolve/unified.db`与`~/.evolve/memory.context.md`。

## 工具

|分组|工具|
|---|---|
|记忆|`memory_add`、`memory_search`、`memory_list`、`memory_strengthen`、`memory_weaken`、`memory_remove`、`memory_status`、`memory_brief`、`memory_candidates`、`memory_confirm`、`memory_reject`、`memory_feedback`|
|会话状态|`session_summary`、`session_summaries`、`session_search`|
|召回评测|`memory_eval`|
|用户画像|`user_add`、`user_list`、`user_remove`|
|技能|`skill_create`、`skill_patch`、`skill_list`、`skill_archive`、`skill_usage`、`skill_status`、`skill_feedback`、`skill_verify`|
|规则|`rule_observe`、`rule_status`、`rule_escalate`|
|目标|`goal_start`、`goal_status`、`goal_checkpoint`、`goal_complete`、`goal_stop`|
|进化|`evolution_status`、`evolution_propose`、`evolution_apply`、`evolution_reject`|
|会话召回|`session_search`（对全部历史对话的FTS5全文检索）|
|管理|`curator_run`、`curator_status`|
|决策修复|`repair_run`、`repair_signal`、`feedback_classify`、`repair_status`、`repair_list`、`repair_accept`、`repair_reject`|
|模式候选|`pattern_status`、`pattern_record`、`pattern_induce`、`pattern_signature`|
|工作区|`workspace_status`、`workspace_scan`、`workspace_list`|
|迁移|`transfer_export`、`transfer_import`、`transfer_preview`、`transfer_status`|
|团队同步|`team_sync`、`team_status`、`team_init`、`team_ping`|

## 架构

```
~/.evolve/unified.db                单一SQLite存储
  ├── memories / user_profile       记忆与偏好（hot/warm/cold分层）
  ├── session_messages + FTS5       全部对话历史全文索引
  ├── skills                        提炼的技能（镜像到~/.agents/skills/）
  ├── rules                         行为规则（升级进AGENTS.md）
  ├── goals + checkpoints           PDCA目标跟踪
  ├── evolution                     GEPA式候选（人工把关后应用）
  ├── signals / repairs             决策修复：步骤成败信号+修复草稿
  ├── pattern_signatures            零LLM复发桶（episode阈值→记忆）
  ├── workspaces                    环境指纹+ws:作用域记忆
  ├── session_summaries             固定大小压缩会话状态（蒸馏而非原文重放）
  ├── recall_evidence               逐词召回反馈（hits/positives/negatives）
  └── config                        node_id+Lamport时钟（行级同步身份）

opencode插件（selfforge.ts）
  ├── 会话钩子                       轮次计数、缓冲、敏感信息打码、闲聊过滤
  ├── tool.execute.after            技能使用跟踪+成败信号
  └── chat.system.transform         建议注入（进行中的目标、进化候选）
```

记忆分层与生命周期：每条记忆按`strength`分入hot/warm/cold/evictable，并按`lifecycle`经历temporary→active→permanent→archived的晋升与降级。强度按自适应半衰期指数衰减，访问频率、重要度与近因会调整衰减速率；不活跃记忆降级，陈旧记忆归档，重复记忆合并。

## 设计原则

- **单一引擎、单一存储。** 所有自改进数据都在`~/.evolve/`下。
- **事实层级。** 注入的记忆优先于猜测，但绝不压过当前事实：仓库现状、构建脚本、测试结果与显式指令为准，冲突被标记为陈旧记忆。详见[docs/MEMORY_CONTRACT.md](docs/MEMORY_CONTRACT.md)。
- **外科手术式召回。** `memory_search`按关键词打分按需返回，而不是倾倒整个存储。
- **数据驱动进化。** 只有在技能满足`use≥2且fail≥1`后才给出优化候选。
- **人工把关。** 技能改写与AGENTS.md写入都需要显式批准。
- **不产出也是有效结果。** 大多数会话没有值得沉淀的内容。
- **卫生。** 闲聊消息在缓冲前被过滤；记忆随时间衰减，近似重复自动合并。

## 隐私

所有数据都保存在本机`~/.evolve/`下，不离开你的机器，没有任何外发请求。

## MemOS风格引擎（Phase 1）

四个借鉴自MemOS(`memos-local-plugin`)的能力，全部确定性、零LLM：

- **技能试用生命周期：** 每条技能以`candidate`起步，`eta=(passed+1)/(attempted+2)`（Beta(1,1)）。达到试用阈值后按eta晋升`active`或归档；`skill_feedback`（±0.1）支持康复/退役；`evolution_apply`喂入奖励漂移（`0.7η+0.3m`）。
- **决策修复：** 步骤级成败信号（`signals_auto`默认开启）喂入突发检测器（滑动窗口+冷却）。修复突发或分类出的用户偏好（`用X代替Y`/`prefer X over Y`/否定句）会草拟带证据的确定性修复；`repair_accept`/`repair_reject`把关应用。
- **防幻觉验证：** `skill_verify`对照真实证据（观测到的工具调用、代码围栏命令）检查技能草稿中提到的工具，报告工具覆盖度与证据共鸣度。草稿快速失败，而不是带着虚构工具名上线。
- **模式签名候选桶：** 反复出现的子问题被指纹化为`primaryTag|secondaryTag|tool|errCode`，哈希成16位十六进制桶。只有包含≥N个独立episode（默认2，TTL清除）的桶才归纳成候选记忆——单次偶发episode永远不会铸造知识。

## 工作环境感知（Phase 2）

工作区通过廉价栈标记（`package.json`、`pyproject.toml`、`go.mod`、`Dockerfile`…）指纹化为稳定的`ws:<目录名>:<哈希>`作用域键。记忆可绑定该键，`memoryRecall`应用`scopeBoost`让当前工作区的经验排在最前——完全不需要嵌入向量。

## 跨智能体/平台迁移（Phase 3）

可移植快照把整个存储序列化（`format: selfforge-snapshot`），携带逐行身份。`transfer_export`/`transfer_import`在机器、智能体、平台间搬运；导入是逐uuid的last-write-wins合并（`updated_at`新者胜，平局按node_id，墓碑删除）。零依赖引擎（`lib/index.ts`）同时支撑：

- `cli/selfforge.ts`——`status`、`export`、`import`（支持`--dry-run`）、`serve`、`team`子命令；只要有bun就能跑，不需要OpenCode。
- 本地JSON-RPC服务（`lib/rpc.ts`）——`ping`、`status`、`memory.list`、`skills.list`、`workspaces.list`、`goals.list`、`snapshot.export`/`snapshot.import`走HTTP。

## 团队共享记忆（Phase 4）

git仓库持有`snapshot.json`作为共享真值。`team_sync`执行拉取→逐uuid LWW合并进本地库→重新导出→提交→推送，任意数量的节点最终收敛。`team_init`引导建仓（可选加remote）；墓碑以删除形式传播。

## 可视化管理（Phase 5）

`selfforge serve`（或`bun cli/selfforge.ts serve`）启动零依赖HTTP服务：

- `GET /`——单页仪表盘（概览计数、记忆、技能、目标、待处理修复、模式候选）。
- `GET /api/*`——JSON端点（`/api/dashboard`、`/api/memories`、`/api/skills`、`/api/goals`、`/api/repairs`、`/api/patterns`、`/api/workspaces`）。
- `POST /`——上述JSON-RPC接口。

## Metis式记忆（v1.8）

借鉴自[MemTensor Metis](https://github.com/MemTensor/Metis)记忆基础模型论文的五个能力——`原生记忆状态`、`习得化利用`、`固定大小会话状态`——全部保持确定性与零LLM：

- **固定大小会话状态（`session_summary`）：**对话历史被蒸馏成有界的用户指令/决策摘要（`session_summaries`），后续查询读取紧凑状态而非重放原始记录——插件在每次复盘后自动构建。
- **信息量写入门控：**confirmed写入必须相对现有存储贡献足够的全新token（`memory_novelty_gate`默认0.35）；冗余改写被拒绝而非膨胀记忆库。candidate写入豁免。
- **召回证据闭环（`memory_feedback`）：**每次召回记录逐词hits；显式的有用/无用反馈调整词级精确度权重，为未来召回重新排序——无需LLM的习得化利用。
- **分级注入融合：**`composeMemoryContext`按当前工作区→作用域→通用三级融合记忆，让最具情境性的信号最贴近查询头部。
- **召回评测基准（`memory_eval`/`selfforge eval`）：**播种已知样例集，对一组正负查询报告precision@k，让召回退化可见。

## 版本更新说明

### v1.8.0（2026-08-10）Metis式记忆（原生状态、习得化利用、固定大小状态）

- **固定大小会话状态：**新增`session_summaries`表与`lib/summary.ts`，把会话中的用户指令/决策蒸馏成有界摘要；插件在每次复盘后自动构建并融合进注入上下文。工具：`session_summary`、`session_summaries`。
- **信息量写入门控：**`memoryAddDedup`现在会拒绝相对现有存储的token新颖度低于`memory_novelty_gate`（默认0.35）的confirmed写入；candidate写入豁免。新增`memoryNovelty`/`noveltyGate`。
- **召回证据闭环：**新增`recall_evidence`表，每次召回记录逐词hits；`memory_feedback`（+/-）调整词级精确度权重，为未来召回重新排序。`recallFeedback`同时按id强化/弱化底层记忆。
- **分级注入融合：**`composeMemoryContext`按工作区→作用域→通用三级排序，并可融合会话状态块。
- **召回评测：**新增`lib/eval.ts`，播种已知样例集并报告precision@k；通过`memory_eval`工具与`selfforge eval`CLI暴露。
- 测试：新增`tests/metis.test.ts`（13个用例）——全量99通过。

### v1.7.0（2026-08-10）MemOS引擎+跨智能体+团队同步+仪表盘（Phase 1–5）

- **技能试用生命周期（Phase 1）：** 技能携带Beta(1,1)的`eta`，以`candidate`起步，按试用阈值（`skill_candidate_trials`默认3）晋升；`evolution_apply`喂入奖励漂移；`skill_feedback`支持康复/退役。工具：`skill_status`、`skill_feedback`。
- **决策修复（Phase 1）：** 步骤级成败信号（`signals_auto`）喂入突发检测器+冷却；分类出的用户偏好与反模式草拟带证据的确定性修复。工具：`repair_run`、`repair_signal`、`feedback_classify`、`repair_status`、`repair_list`、`repair_accept`、`repair_reject`。
- **防幻觉验证（Phase 1）：** `skill_verify`对照真实观测（工具调用、代码围栏命令）给技能草稿打分工具覆盖度与证据共鸣；`skill_create`附带该建议。
- **模式签名候选桶（Phase 1）：** 复发子问题指纹化为`primaryTag|secondaryTag|tool|errCode`，哈希成16位桶；只有≥N个独立episode（TTL清除）的桶归纳为候选记忆。工具：`pattern_status`、`pattern_record`、`pattern_induce`、`pattern_signature`。
- **工作环境感知（Phase 2）：** `workspaces`表+栈标记指纹→`ws:`作用域键；`memoryRecall`应用`scopeBoost`。工具：`workspace_status`、`workspace_scan`、`workspace_list`。
- **跨智能体/平台迁移（Phase 3）：** 可移植快照+逐uuid LWW导入；CLI`cli/selfforge.ts`；零依赖本地JSON-RPC。工具：`transfer_export`、`transfer_import`、`transfer_preview`、`transfer_status`。
- **团队共享记忆（Phase 4）：** git仓库持有`snapshot.json`；`team_sync`=拉取→LWW合并→重新导出→推送。工具：`team_sync`、`team_status`、`team_init`、`team_ping`。
- **可视化管理（Phase 5）：** `selfforge serve`提供`GET /`单页仪表盘与`/api/*`JSON端点；JSON-RPC保留在`POST /`。
- 测试：`skill-lifecycle`、`repair`、`verify`、`patterns`、`workspace`、`transfer`、`rpc`、`team`。

### v1.5.0（2026-08-09）同步原语（Phase 0）

- 全部数据表新增行级同步身份：`uuid`+`origin`+`deleted`墓碑；旧库在迁移时幂等回填。
- `node_id`持久化进`config`；Lamport时钟（`config.lamport_clock`）每次写入自增——这是跨智能体/跨平台/团队同步记忆的地基。
- 显式删除（记忆移除/拒绝、技能归档、画像删除）落墓碑，以"删除"而非"残留"形式复制。
- 导出表面：`lib/index.ts`把引擎独立于OpenCode适配器重新导出。
- 新增`tests/sync.test.ts`（node id、时钟单调性、打戳、墓碑、迁移回填）。

### v1.4.0（2026-08-09）入口模块化

- 工具注册从入口文件拆分到`lib/tools/*`，按领域分组（memory/user/skills/rules/goals/evolution/curator），入口仅保留生命周期钩子。
- `install.sh`新增`lib/tools/`目录拷贝，无需改动`opencode.json`。

### v1.3.0（2026-08-09）记忆契约与防污染

- 候选区：自动推断的记忆以`candidate`状态入库，未经人工确认（`memory_candidates`/`memory_confirm`/`memory_reject`）绝不召回或注入；用户显式陈述直接以confirmed写入。
- 作用域：记忆可带路径glob作用域`scope`（如`services/payment/**`），防止某模块的经验泄漏进其他模块的召回。
- 置信度与TTL：新增`confidence`（1–10）与`expires_at`，临时事实过期即被召回排除并归档。
- 写入守门：凭据、令牌与代码/文件快照在写入时被拒绝。
- 优先级明确：注入记忆优先于猜测但绝不压过当前仓库/CI/测试事实，冲突被标记为陈旧记忆。
- 记忆契约：操作规则文档化于`docs/MEMORY_CONTRACT.md`。
- 记忆轨迹：每次召回记录查询/作用域/召回id/注入准则到`observations`，可复现排障。
- 污染回归测试：`tests/memory-fixtures.test.ts`共7个高风险样例（凭据、候选、过期、跨模块泄漏、注入纯净、去重转正）。

### v1.2.0（2026-08-09）记忆生命周期管理

- 数据库迁移：`memories`表新增`last_accessed_at`、`access_count`、`importance`、`lifecycle`、`type`五列，对旧库用`PRAGMA table_info`探测后幂等补列。
- 自适应指数衰减：strength按半衰期公式衰减，半衰期随访问频率、重要度与近因自适应调整；低于阈值的陈旧记忆降级生命周期，长期不活跃的记忆归档。
- 生命周期晋升与降级：temporary→active→permanent按访问次数晋升（15次/30次），手动弱化或不活跃时降级。
- 记忆分类：`memory_add`支持`type`（preference/insight/instruction/fact/decision/episodic）与`importance`（1–10）。
- 每日简报：新增`memory_brief`工具，汇总活跃/归档数量、今日新增、类型与生命周期分布及健康建议。
- 短查询注入：`memory_search`对≤15字的短查询自动注入最近应用的进化准则作为权威行为指引。
- VACUUM维护：低频数据库压缩并入闲置维护周期（默认每日一次，可配置）。

### v1.1.0（2026-08-09）检索与会话召回优化

- 事实层级：注入上下文中的记忆被标记为权威，智能体优先使用而非重复发现。
- 外科手术式召回：`memory_search`按关键词打分精确召回。
- FTS5会话全文检索：新增`session_search`，跨全部历史对话检索。
- 衰减与去重：记忆随年龄衰减，近似重复（相似度≥0.7）自动合并强化。
- 新增smoke测试套件。

### v1.0.0（2026-08-07）初始发布

- 统一自进化引擎：对话复盘、持久记忆、技能提炼优化、行为规则升级、PDCA目标跟踪、技能生命周期管理。
- 单一SQLite存储`~/.evolve/unified.db`与注入文件`~/.evolve/memory.context.md`。
- 一键安装脚本`install.sh`与`install-remote.sh`。

## License

MIT

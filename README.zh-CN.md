# selfforge

面向[OpenCode](https://opencode.ai)的统一自进化引擎。一个插件把四类能力合并进单一存储，用同一套工具驱动。

Selfforge从对话中学习，跟踪目标，管理持久记忆，提炼并优化可复用技能，并把行为规则升级进AGENTS.md——全部通过一个插件和一份SQLite数据库完成。

## 合并了什么

|能力|来源|表面工具|
|---|---|---|
|对话监控与复盘|autolearn|事件钩子、复盘子代理|
|持久记忆与用户画像|autolearn|`memory_*`、`user_*`|
|技能提炼与优化|autolearn+opencode-self-improving-skills|`skill_*`、`evolution_*`|
|行为规则写入AGENTS.md|self-improving-agent|`rule_*`|
|目标驱动的PDCA循环|miles990/self-evolving-agent|`goal_*`、检查点CP0–CP6.5|
|技能生命周期管理|autolearn|`curator_*`|

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
|记忆|`memory_add`、`memory_search`、`memory_list`、`memory_strengthen`、`memory_weaken`、`memory_remove`、`memory_status`、`memory_brief`、`memory_candidates`、`memory_confirm`、`memory_reject`|
|用户画像|`user_add`、`user_list`、`user_remove`|
|技能|`skill_create`、`skill_patch`、`skill_list`、`skill_archive`、`skill_usage`|
|规则|`rule_observe`、`rule_status`、`rule_escalate`|
|目标|`goal_start`、`goal_status`、`goal_checkpoint`、`goal_complete`、`goal_stop`|
|进化|`evolution_status`、`evolution_propose`、`evolution_apply`、`evolution_reject`|
|会话召回|`session_search`（对全部历史对话的FTS5全文检索）|
|管理|`curator_run`、`curator_status`|

## 架构

```
~/.evolve/unified.db                单一SQLite存储
  ├── memories / user_profile       记忆与偏好（hot/warm/cold分层）
  ├── session_messages + FTS5       全部对话历史全文索引
  ├── skills                        提炼的技能（镜像到~/.agents/skills/）
  ├── rules                         行为规则（升级进AGENTS.md）
  ├── goals + checkpoints           PDCA目标跟踪
  └── evolution                     GEPA式候选（人工把关后应用）

opencode插件（selfforge.ts）
  ├── 会话钩子                       轮次计数、缓冲、敏感信息打码、闲聊过滤
  ├── tool.execute.after            技能使用跟踪
  └── chat.system.transform         建议注入（进行中的目标、进化候选）
```

记忆分层与生命周期：每条记忆按`strength`分入hot/warm/cold/evictable，并按`lifecycle`经历temporary→active→permanent→archived的晋升与降级。强度按自适应半衰期指数衰减，访问频率、重要度与近因会调整衰减速率；不活跃记忆降级，陈旧记忆归档，重复记忆合并。

## 设计原则

- **单一引擎、单一存储。**所有自改进数据都在`~/.evolve/`下。
- **事实层级。**注入的记忆优先于猜测，但绝不压过当前事实：仓库现状、构建脚本、测试结果与显式指令为准，冲突被标记为陈旧记忆。详见[docs/MEMORY_CONTRACT.md](docs/MEMORY_CONTRACT.md)。
- **外科手术式召回。**`memory_search`按关键词打分按需返回，而不是倾倒整个存储。
- **数据驱动进化。**只有在技能满足`use≥2且fail≥1`后才给出优化候选。
- **人工把关。**技能改写与AGENTS.md写入都需要显式批准。
- **不产出也是有效结果。**大多数会话没有值得沉淀的内容。
- **卫生。**闲聊消息在缓冲前被过滤；记忆随时间衰减，近似重复自动合并。

## 隐私

所有数据都保存在本机`~/.evolve/`下，不离开你的机器，没有任何外发请求。

## 版本更新说明

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

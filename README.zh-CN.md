# selfforge

自进化的智能体记忆引擎。它从对话中学习，跟踪目标，管理持久记忆，提炼可复用技能，升级行为规则，并在多个智能体、多台机器与团队之间同步知识——全部通过一个插件和一份SQLite数据库完成。

`selfforge`以[OpenCode](https://opencode.ai)插件形式运行，但核心引擎零依赖，可独立运行（`cli/selfforge.ts`、HTTP daemon、Docker）。

所有数据存放在一份SQLite数据库：`~/.evolve/unified.db`（或`$EVOLVE_HOME`）。

## 功能特点

- **对话监控与复盘** —— 把每个会话的消息转化为可沉淀的成果：记忆、技能、规则、目标。
- **持久记忆与用户画像** —— 按强度分层（`热/温/冷/可淘汰`），支持衰减、去重、作用域隔离与TTL。
- **技能提炼与生命周期** —— 把可复用技术沉淀为技能；技能从`候选`起步，经试用/η毕业；长期未用自动归档。
- **行为规则 → AGENTS.md** —— 规则自动评分（基础3分，每60天降1分）；高分规则自动升级写入`AGENTS.md`。
- **目标驱动PDCA循环** —— 活动目标带检查点（CP0–CP6.5），进度建议注入聊天系统提示词。
- **决策修复** —— 步骤级成功/失败信号生成带证据的确定性修复建议。
- **每日总结** —— 展示每个会话最后一条助手结论，增量追加、质量门控。
- **工作环境感知** —— 工作区指纹化为稳定的`ws:`作用域键，作用域记忆排名优先。
- **跨智能体/平台迁移** —— 可移植快照（`format: selfforge-snapshot`）带行级同步身份。
- **团队共享记忆** —— git仓库持有`snapshot.json`；`team_sync`拉取、合并（per-uuid LWW）、再导出并推送。
- **Web面板** —— 中英双语单页面板：概览计数、记忆、技能、规则、目标、检查点、每日总结、日志。

## 记忆模型

```
~/.evolve/unified.db                单一SQLite存储
  ├── memories / user_profile       记忆与偏好（热/温/冷分层）
  ├── session_messages + FTS5       全部对话历史全文索引
  ├── skills                        提炼的技能（镜像到~/.evolve/skills）
  ├── rules                         行为规则（评分，升级进AGENTS.md）
  ├── repairs / signals             决策修复：步骤成败信号+修复草稿
  ├── pattern_signatures            重复失败模式桶（episode阈值→记忆）
  ├── workspaces                    环境指纹+ws:作用域记忆
  ├── session_summaries             固定大小压缩会话状态
  └── config                        node_id+Lamport时钟（行级同步身份）
```

记忆按`strength`分入`热/温/冷/可淘汰`，强度按自适应半衰期指数衰减（访问频率、重要度与近因会调整速率），近似重复自动合并，陈旧记忆归档。

**事实层级** —— 注入的记忆优先于猜测，但绝不压过当前事实：仓库现状、构建脚本、测试结果与显式指令为准，冲突被标记为陈旧记忆。

## 安装

### 一行命令（推荐，无需手动配置）

Linux / macOS / WSL（bash）：

```bash
curl -sSL https://raw.githubusercontent.com/Cuering/selfforge/main/install-remote.sh | bash
# 或从本地克隆后：
bash install.sh
# 重启 opencode
```

Windows（PowerShell）：

```powershell
git clone https://github.com/Cuering/selfforge.git
cd selfforge
powershell -ExecutionPolicy Bypass -File install.ps1
# 重启 opencode
```

安装脚本自动完成：

- 复制插件源码 → `~/.config/opencode/plugins/`
- 复制`selfforge`与`evolve-reviewer`技能 → `~/.agents/skills/`
- 若装了Bun，自动`bun build.mjs`产出`compiled/selfforge.js`（桌面版Node需要；配置按编译成功选`.js`、否则`.ts`）
- 写入`opencode.json`/`jsonc`：`plugin`、`instructions`（`~/.evolve/memory.context.md`）、`skills.paths`（`~/.evolve/skills`）、`evolve-reviewer` agent
- 校验文件完整性

### 依赖

| 依赖 | 用途 | 缺失时 |
|------|------|--------|
| opencode | 运行时 | 插件无法加载 |
| Bun（可选） | 编译`.js` / CLI | CLI可用`.ts`；桌面版需先装Bun |
| Node / git / bash或PowerShell | 安装脚本与CLI | 无法安装 |

> 其余全部自包含：SQLite内置，无外部服务。首次加载自动创建`~/.evolve/unified.db`与`~/.evolve/memory.context.md`。

## 使用

### 在OpenCode内

- 输入`/selfforge` —— 打印终端概览（记忆/技能/目标/修复计数），按需打开浏览器面板。
- 工具：`selfforge_status`（纯文本概览）、`selfforge_dashboard`（确保daemon在跑并打开浏览器）、`selfforge_dashboard_stop`。
- 记忆/检索/规则/目标工具：`memory_add`、`memory_search`、`memory_candidates`、`skill_create`、`skill_patch`、`rule_observe`、`rule_escalate`、`goal_start`、`goal_checkpoint`、`evolution_propose`、`curator_run`等。

### Web面板

`selfforge serve`（或插件自动启动的daemon）首选绑定http://127.0.0.1:9210/。若首选端口被其他进程占用，`serve()`通过`tryListen`自动迁移（最多+64端口），因此即使腾讯QQ抢占9210，daemon仍然可达。插件的`/selfforge`、`selfforge_dashboard`和浏览器弹窗都会跟随实际端口。

- `GET /` —— 单页中英双语面板
- `GET /api/*` —— JSON端点（`/api/dashboard`、`/api/memories`、`/api/skills`、`/api/goals`、`/api/rules`、`/api/checkpoints`、`/api/workspaces`、`/api/errors`、`/api/stats`）
- `GET /api/ping` —— 存活探针，返回`{pong,pid,port}`；这是判断是否真正selfforge daemon的可靠方式（外部服务在9210返回200**不**算数）
- `POST /` —— JSON-RPC接口
- 顶栏按钮：语言切换（EN/中文）、主题、刷新、热重启daemon

### 端口稳定性与Windows看护

在Windows上，面板端口可能被无关应用抢占（例如腾讯QQ占用`127.0.0.1:9210`）。此时daemon会漂移到更高端口，页内「重启」按钮也随之不可达。若要稳定、自愈且不依赖桌面版/插件/浏览器的方案：

- 使用`scripts/watchdog/`下的看护脚本（放入Windows启动文件夹或计划任务）：
  - `selfforge-watchdog.cmd` —— 循环启动器（每30秒，互斥锁防重入）
  - `selfforge-watchdog-once.ps1` —— 单次检查：探9220..9230（首选，QQ不占）再探9211..9215的`/api/ping`；无存活时以`SELFFORGE_PORT=9220`拉起daemon；多个daemon时只保留最低端口并清理重复；把存活端口写入`~/.evolve/watchdog-port.txt`，端口首次变化时打开浏览器
- 用固定的非冲突首选端口（如通过`SELFFORGE_PORT=9220`），避免每次开机地址漂移。
- 不要为腾端口去停无关服务（QQ）——selfforge会绕开它们自动迁移。

### 独立CLI（无需OpenCode）

```bash
bun cli/selfforge.ts status                # 节点ID、时钟、DB路径
bun cli/selfforge.ts export <file.json>    # 可移植快照
bun cli/selfforge.ts import <file.json>    # per-uuid LWW合并（--dry-run预览）
bun cli/selfforge.ts serve --port 9210     # 面板+JSON-RPC
bun cli/selfforge.ts team init <dir>       # 团队仓库（可选--remote）
bun cli/selfforge.ts team sync [<dir>]     # 拉取、合并、再导出、推送
bun cli/selfforge.ts eval [--k <n>]        # 召回精度基准
```

## Agent Memory 评测接入

selfforge以**学术 × 代码**路径参加[Agent Memory](https://agentmemories.ai)（文本记忆赛道）：平台负责构建并评测提交的仓库，无需保持主机在线。

评测端点实现了同步Add/Search契约：

| 端点 | 方法 | 行为 |
|------|------|------|
| `/health` | GET | 未鉴权存活检测（200） |
| `/add` | POST | 同步持久化消息，返回`success:true`并回显ids |
| `/search` | POST | 按用户隔离，返回按相关度排序的`{data:[{id,content,score}]}`；绝不泄漏其他用户记忆 |

本地启动评测服务：

```bash
bun cli/selfforge.ts serve --port 9210
# 或用Docker（评测镜像，仅暴露/add /search /health）
docker build -t selfforge-bench .
docker run -p 9210:9210 -e SELFFORGE_PORT=9210 -e EVOLVE_HOME=/data selfforge-bench
```

冒烟测试：

```bash
curl -s localhost:9210/health
curl -s -X POST localhost:9210/add -H 'content-type: application/json' \
  -d '{"request_id":"r1","messages":[{"role":"user","content":"prefer Node"}],"user_id":"u1","session_id":"s1"}'
curl -s -X POST localhost:9210/search -H 'content-type: application/json' \
  -d '{"query":"runtime","user_id":"u1","top_k":10}'
```

## 版本更新

### v1.9.4（2026-08-13）端口稳定性看护

- **看护脚本**（`scripts/watchdog/`）——30秒循环探测`/api/ping`，daemon死亡时以`SELFFORGE_PORT=9220`自动拉起（绕过QQ等端口抢占者），去重多个daemon，记录存活端口，端口首次变化时自动打开浏览器。
- **`/api/ping`**文档化为权威存活探针（`{pong,pid,port}`）——外部服务在9210返回200不算selfforge。

### v1.9.3（2026-08-13）Agent Memory评测 + 规则评分 + 国际化

- 为[Agent Memory](https://agentmemories.ai)文本赛道实现`/add`、`/search`、`/health`契约端点，严格`user_id`隔离；`lib/bench.ts` + `tests/bench.test.ts`。
- **Dockerfile** —— 评测镜像，仅暴露评测HTTP端点。
- **规则自动评分** —— 基础3分，每60天降1分，加频次/近因/领域/manual反馈奖励；规则面板新增赞踩；高分规则自动升级写入`AGENTS.md`。
- **面板国际化** —— EN/中文切换，`localStorage.lang`持久化并记住当前标签页；英文模式下技能说明切换到`description_en`。

### v1.9.2（2026-08-11）进程内复盘 + 稳定面板daemon

- **复盘在opencode内运行，无需外部CLI**（`spawnReviewSdk`）；外部CLI仅作最后兜底。
- **分离式面板daemon** —— 跨opencode重启存活，端口固定。
- 各面板表格通用按行编辑/删除。
- 软删除过滤修复；合并`review_triggered`观测记录。

### v1.9.1（2026-08-11）面板管理

- 面板记忆表格支持编辑/删除。
- `memory.daily`每日总结区块。
- 层级/状态/目标中文标签。

### v1.9.0（2026-08-10）OpenCode界面集成

- 插件加载自动后台启动服务器（`serve(9210)`）。
- `/selfforge`命令 + `selfforge_status`/`selfforge_dashboard`工具。
- 终端文本概览（`dashboardText()`）；单例服务。

### v1.8.0（2026-08-10）记忆原生状态

- 固定大小会话状态（`session_summaries`）、信息写入门控、召回证据循环（`recall_evidence`）、分层注入融合、召回评测基准。

### v1.7.0（2026-08-10）引擎阶段1–5

- 技能试用生命周期、决策修复、反幻觉校验、模式候选、工作区感知、跨智能体迁移、团队同步、可视化面板。

### v1.5.0（2026-08-09）同步原语

- 行级同步身份（`uuid` + `origin` + `deleted`墓碑）、node_id + Lamport时钟。

### v1.4.0（2026-08-09）模块化入口

- 工具注册按领域拆入`lib/tools/*`。

### v1.3.0（2026-08-09）记忆契约与防污染

- 候选区、作用域隔离、置信度与TTL、写入层防护、记忆追踪、回归测试套件。

### v1.2.0（2026-08-09）记忆生命周期管理

- 自适应指数衰减、生命周期晋升/降级、记忆分类、每日简报、VACUUM维护。

### v1.1.0（2026-08-09）召回与会话检索

- 事实层级、外科手术式`memory_search`、FTS5会话全文检索、衰减与去重。

### v1.0.0（2026-08-07）初始版本

- 统一自进化引擎，单一SQLite存储，一键安装。

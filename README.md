# dsh-token-usage-stats

> DeepSeek Harness 的 Token 用量统计插件：**「使用统计」整页仪表盘 + 底部常驻状态栏 + 会话顶部「用量」标签页**，按日 / 周 / 月汇总用量，并可下钻到**项目 / 会话 / 每次对话**，记录每次 LLM 请求的**未命中缓存输入、命中缓存输入、缓存写入、输出**与时间；数据持久化在**嵌入式 SQLite 数据库**，附 `/tokenstats` 命令与同源 HTTP 接口。

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.2-2f7cf6)](https://github.com/deepseek-ai)
[![npm](https://img.shields.io/npm/v/@h643560027/dsh-token-usage-stats)](https://www.npmjs.com/package/@h643560027/dsh-token-usage-stats)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![Storage: SQLite](https://img.shields.io/badge/storage-SQLite-003b57)](#统计口径)

- **零 npm 依赖**：只使用 Node 内置的 `node:sqlite` / `node:zlib` 与宿主注入的服务，离线可装，任何 profile 安装布局都能解析
- **数据全部本地**：只写入 SQLite 文件 `~/.dsh/storages/token_usage_stats.sqlite`，不联网、不上传
- **不重复计数**：恢复会话时回放的历史事件不会进入统计；同一 `(turn, step)` 的重试替换不叠加；历史回填按会话去重
- **历史也统计**：启动时把插件安装之前（以及未运行时）的用量从宿主会话日志**回填一次**，幂等
- **四级下钻**：每次请求 → 每次对话（turn）→ 每个会话 → 每个项目（会话工作目录）

## 快速安装

在 Harness 中：**设置 → 插件 → 添加插件**，粘贴以下任一项后点击安装：

- **npm 包名 `@h643560027/dsh-token-usage-stats`**（需联网，Plugin Manager 会从 npm 拉取）
- 发布包 `dsh-token-usage-stats.tgz`（从 [Releases](../../releases) 下载）
- 或本仓库克隆/解压后的目录路径

也可以让具备权限的 DSH 会话调用 `plugin_manager` 工具的 `install_bundle`，target 填上述 npm 包名或路径。

完整步骤（含手动安装、验证清单、卸载、故障排查）见 **[INSTALL.md](INSTALL.md)**。

## 界面预览

| 入口 | 说明 |
|---|---|
| 底部状态栏 | `Token 用量  今日 xx · 本周 xx · 本月 xx`，右侧「统计面板 / 明细 / 刷新」 |
| 会话「用量」标签页 | 会话标签栏里「轨迹」后面的 **用量**：只统计当前会话 |
| 使用统计面板 | 汇总卡片 → 每日趋势图 → 模型用量 |

> 面板通过 `main` 全局面板注册（与插件市场页同一机制），从状态栏「统计面板」按钮打开，页内「返回会话」回到对话。
>
> 「用量」标签页通过 `conversation.view` 列表槽位注册（`order: 15`，介于轨迹 `10` 与上下文 `20` 之间），槽位按会话作用域渲染，因此它拿到的始终是当前打开的会话 id。

## 功能

- **「使用统计」仪表盘**（`main` 全局面板，key `token-usage-stats`）：
  - **汇总卡片**：累计 Token 数、峰值 Token 数（含峰值日期）、最长单轮时长、当前连续天数、最长连续天数；
  - **每日 Token 趋势图**：「近 7 日 / 近 30 日」切换的 SVG 面积折线图；**整图任意位置可悬停**，显示参考线、日期与逐日精确用量（输入/输出/缓存读/缓存写/请求数拆分）；
  - **项目 / 会话 / 对话**：三级下钻列表，逐行显示总 Token、命中缓存输入、未命中缓存输入、输出、请求数与时间；点项目看它的会话，点会话看它的每次对话；
  - **模型用量**：按 `provider/model` 归属的用量排行（进度条 + 明细拆分）。
- **会话「用量」标签页**（`conversation.view` 槽位，「轨迹」后面）：
  - **只看当前会话**：卡片显示该会话的累计 Token、未命中缓存输入、命中缓存输入、缓存写入、输出、计费请求数与对话轮数；顶部标注项目名与会话标题；
  - **逐轮明细**：每次对话一行（序号 `#N`、开始时间 · 时长、总 Token、命中缓存 / 未命中输入 / 输出 / 请求数），精确值在悬停提示里；
  - 每 30 秒自动刷新，切换会话立即换数据（不会闪现别的会话的数字），新会话无用量时显示空状态；右上角可跳到整页「统计面板」。
  - 数据来自已有的 `GET /api/token-stats/breakdown?by=turn&session=<id>`：`totals` 是该会话全量合计，行列表取最近 200 轮（超出时标注「仅展示最近 N 轮」，合计值不受影响），**不需要新增 Host 路由，也不需要重启应用**。
- **底部状态栏**（`shell.bottom` 槽位，横跨三列下方）：常驻「今日 / 本周 / 本月」Token 总量与累计值，「明细」展开近 14 天逐日列表。数字中文环境用 万/亿、英文环境用 K/M/B。
- **历史回填**（Host 侧，随每次启动自动执行）：
  - 插件只能监听**激活之后**的新事件，因此安装之前的对话原本是空白。启动后在后台遍历 `$DSH_HOME/sessions` 的会话日志，把**数据库里还没有的会话**按与实时折叠完全相同的规则重放一遍：日汇总、模型归属、项目 / 会话 / 对话聚合、单轮时长都会补齐。
  - **幂等**：已在 `sessions` 表中的会话（实时记录过或以前回填过）直接跳过，绝不重复计数；同一会话存在多代日志（`session.jsonl.zstd` 与迁移后的 `session.v4.jsonl.zstd`）时只读**最高代次**。
  - **不阻塞**：在数据库就绪、后台事件回放完之后执行，按文件让出事件循环，日志损坏只跳过该会话并告警（下次启动重试）。实测本机 160 个日志、125 个会话、6133 次请求约 7 秒完成，一次性。
  - 老会话的「用量」标签页、仪表盘的会话 / 项目维度、趋势图与热力图都会随之补上历史。
- **`/tokenstats` 命令**：对话内文本版统计（今日/本周/本月、峰值、连续天数、最长单轮、项目 Top5、模型 Top5）；`--json` 返回完整机器可读 JSON。
- **HTTP 接口**：
  - `GET /api/token-stats`：完整汇总（`v:3`：today/week/month、recent/trend、heatmap、stats、models、allTime，外加 `requestCount`、`projects`、`sessions`、`turns`）。
  - `GET /api/token-stats/breakdown?by=project|session|turn&limit=N&project=<cwd>&session=<id>`：按维度分页下钻，返回 `rows` 与整段筛选集的 `totals`。

## 统计口径

- 数据源是**每次计费尝试**的供应商上报用量（`assistant/message` / `assistant/attempt` 事件中的 usage；与官方 `dsh-token-meter` 的 `tokenUsage` 投影同一折叠语义）：
  - 同一 (turn, step) 内的新样本**替换**旧样本；`llm/retry-started` 关闭替换槽位，重试的尝试**累加**；替换同样作用于模型归属桶。
  - 恢复（resume/fork）时回放的历史事件不会进入统计（宿主的 `session/event` 只发布新提交的事件），不会重复计数。
  - **历史回填**读的是宿主自己写的会话日志（`$DSH_HOME/sessions/<项目>/<会话>/session[.vN].jsonl[.zstd]`）：日志是「按批追加的多个独立 Zstandard 帧」，插件解析帧结构逐帧解压，再用**同一个 fold**重放，因此替换 / 重试 / 日归属 / 模型归属的语义与实时完全一致（实测同一会话重放结果与实时记录逐轮完全相等）。
- 按宿主进程**本地日历日**（`event.time` 提交时间）归档；周从周一起算，月为自然月；接口热力图窗口 365 天、趋势窗口 30 天。
- **模型归属**：取该会话最近一次 `request/header` 的 `provider/model`，格式 `provider/model`；无表头时归入 `unknown`。
- **时长**：`turn/start` → `turn/end` 的墙钟时间计入**开始当日**（`turnMs` 求和、`longestMs` 取最大）；「最长单轮时长」为全期最大值。当前连续天数在今日尚无数据时从昨日起算。
- 每日记录持久化在**嵌入式 SQLite 数据库** `~/.dsh/storages/token_usage_stats.sqlite`（默认路径，可用 `dbPath` 覆盖）。表结构：
  - `days`（主键 `YYYY-MM-DD`）+ `day_models`（按 `(day, model)` 归属）——原有按日汇总；
  - `requests`——**每次计费请求一行**（`day, ts, project_id, session_id, turn, step, attempt, model` + `input / cache_read / cache_write / output / reasoning`）；
  - `projects` / `sessions` / `turns`——从 `requests` 派生并冗余保存的聚合行，重启时由 `requests` 重建，因此聚合永远不会与明细漂移。
  - 默认保留 400 天（`retentionDays`），清理时**明细与聚合一起删除**。
- **四级口径**：
  - **请求**：一次计费尝试（含重试；同 `(turn, step)` 的替换覆盖原行，不新增）。
  - **对话（turn）**：同一 `turn` 下的所有请求，附 `startTs` / `endTs` / `durationMs`（只有两端都在时才有值）。
  - **会话**：按会话头 `id` 归集，标题取 `session/title` 事件。
  - **项目**：按会话头 `cwd`（工作目录）归集，标题取目录名；无 `cwd` 的会话归入 `unknown`。子代理会话沿用父会话的工作目录，因此归到同一项目。
- **字段语义**：`input` 是**未命中缓存**的输入，`cacheRead` 是**命中缓存**的输入，`cacheWrite` 是缓存写入，`output` 是输出，`total` 四者之和。`reasoning` 在上报时单独记录（已含在 `output` 内，不重复计入 `total`）。
- 写入语义：内存折叠 → 脏数据合并成**一次 WAL 事务**（`synchronous = FULL`），进程崩溃不会留下半写的一天；数据库不可用时自动降级为「仅内存统计」，接口照常返回并在 UI 上标注。
- **从旧版本升级自动迁移**：v1 的 JSON 存储 `token_usage_stats.json` 会在首次打开时导入并重命名；v1 的 SQLite 库会原地升级（`user_version` 1 → 2，新增四张表，原有按日数据完整保留）。
- 未产生 usage 上报的中断 / 失败请求不计入；这是使用量统计，不是计费账单。

## 配置（profile 的 `cordis.patch.yml` 用户层）

```yaml
- id: token-usage-stats
  name: 'dsh-token-usage-stats'
  config:
    retentionDays: 400   # 保留的天记录数
    detailDays: 14       # 明细列表与命令展示的近 N 天
    dbPath: '~/token-stats.sqlite'   # 可选：SQLite 文件路径（绝对 / ~ / 相对 $DSH_HOME / :memory:）
    backfillHistory: true            # 可选：启动时回填会话日志里的历史用量（默认开）
    sessionsDir: '~/sessions'        # 可选：会话日志根目录（默认 $DSH_HOME/sessions）
```

`dbPath` 省略时使用 `$DSH_HOME/storages/token_usage_stats.sqlite`（默认 `~/.dsh/storages/token_usage_stats.sqlite`）。`retentionDays` 之外的清理发生在每次写入后，删除的天同时移除其模型归属行与请求明细行。

`backfillHistory: false` 只保留实时监听到的用量（适合日志很大、或希望统计严格从安装时刻开始的环境）。`sessionsDir` 一般不用改；只有在自定义了 `DSH_HOME` 或把日志搬到别处时才需要。

## 架构

```
dsh-token-usage-stats/
├── package.json        # bundle 清单（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml    # 插件行与默认配置
├── index.js            # Host：session/event 折叠 → SQLite（日 / 请求 / 项目 / 会话 / 对话）；历史回填；两条 HTTP 路由；/tokenstats 命令
├── history.js          # Host：会话日志读取（多帧 Zstandard、最高代次、头部快读）
├── client.js           # Client 源码：shell.bottom 状态栏 + main 仪表盘 + conversation.view「用量」标签页（fetch 同源接口）
├── client.v8.js        # Client 当前代次（package.json 的 exports "./client" 指向它）
├── test/               # 持久化场景测试 + 历史回填测试 + 日志读取测试 + Client 渲染测试（node --test）
├── locale/             # Plugin Manager 元数据（en / zh）
├── icon.svg            # 原创图标
├── INSTALL.md          # 安装手册
├── LICENSE
└── .github/workflows/  # tag 推送自动打包并发布 Release
```

- **零外部依赖**：Host 只用 Node 内置能力（`node:sqlite`、`node:zlib`、`node:fs`、`node:path`、`node:os`）+ 宿主注入的服务（`webServer`；`commands` 可选），不 import 任何 `@deepseek-ai/*` 包——包括会话日志解码：`history.js` 自己解析 Zstandard 帧结构，不依赖宿主的持久化包。
- **历史回填管线**：`history.js` 枚举 `$DSH_HOME/sessions`，每个会话只取最高代次日志；先只解压首个帧读 header，命中 `sessions` 表就直接跳过（不必解码事件帧）；需要重放的日志逐帧解压 → JSONL 解析 → **复用实时路径的 `fold`**（替换 / 重试 / 日归属 / 模型归属 / 单轮时长语义因此天然一致）→ 每个会话一次 flush。回填期间 `scheduleFlush` 被合并，文件之间 `setImmediate` 让出事件循环；损坏的日志只跳过并告警，不影响其它会话与实时流。
- **存储层**：`node:sqlite` 的 `DatabaseSync`（Node ≥ 22.5 / 本 Harness 的 Electron 44 + Node 24 内置）。表均为 `STRICT`，写入走 `BEGIN IMMEDIATE … COMMIT` 的单事务；`application_id`/`user_version` 守卫防止误开其他应用的库（旧库原地升级）。若运行时缺少该内置模块，插件降级为内存统计而不是加载失败。
- **健壮性**：事件字段在进入 SQLite 之前全部校验（`turn`/`step` 必须是非负安全整数、`time` 必须可解析）；畸形事件只被跳过，绝不会污染整批写入。写入批次连续失败 3 次后会丢弃该批并告警，避免单条坏数据永久卡死持久化。
- **聚合不漂移**：`requests` 是唯一事实来源，`projects`/`sessions`/`turns` 的聚合在每次打开时由它重算（启动早期已折叠的部分再叠加），实时折叠只做增量维护；替换带来的时间跨度变化也会跟随收缩。
- **Client 数据通道**是同源 HTTP 路由而非远程服务协议，浏览器 `fetch('/api/token-stats')` 与 `fetch('/api/token-stats/breakdown')` 自带会话 Cookie；宿主侧路由本身不鉴权，仅返回聚合数字（无消息内容、无凭据）。「用量」标签页复用 breakdown 路由（`by=turn&session=<id>&limit=200`），`totals` 由服务端在该会话的**全部**对话行上求和，因此行列表截断不会影响汇总值。
- **Client 代次机制**：浏览器模块身份由 `exports "./client"` 的路径决定，因此 Client 改动通过新增 `client.vN.js` 并改 export 路径来换代。**注意（实测）**：Host 把 `exports "./client"` 的解析结果缓存到进程重启，所以改 export 路径（换代）**需要重启应用**才生效，仅刷新页面不够；Host 改动同样需重启。修改 `client.js` 后请同步覆盖当前代次文件（当前 `client.v8.js`）。
- **Client 热更新（无需刷新）**：宿主内置 `client-hmr`，每 500ms 轮询当前代次文件的 mtime/ctime/size，变化即经 SSE `/plugins/events` 推 `rebuilt` 帧，浏览器拆旧 fiber、清 owned styles 后重新 import——**同步覆盖当前代次文件后约 1 秒生效，无需 F5**。因此日常改样式/逻辑的流程是：编辑 `client.js` → 覆盖当前代次文件 → 自动热更新。热替换要求插件自身可重入：样式标签需带 `data-plugin` 属性且 `ensureStyle` 要就地更新（否则旧标签既不会被 Host 清理、CSS 也永远不刷新），slot 注册走 `ctx.slots.inject` 以便随 fiber 注销。
- **旧 Host 兼容**：Client 只在 payload 带 `projects`/`sessions`/`turns` 时才渲染下钻区块，因此页面配旧版 Host 也不会报错，只是看不到新维度。
- **Client 本地化**：字典用 `ctx.effect` 注册（随 fiber 释放，HMR 重新加载时不会残留命名空间）；注册失败只会告警，不影响 `ctx.locale.bind` 继续使用已有字典。`lookup` 先按**扁平键**精确匹配（字典键本身带点，如 `bar.title`），再回退到嵌套路径，因此 locale 服务缺席或语言包未命中时会落到内置字典而不是裸露键名。

## 测试

```bash
cd dsh-token-usage-stats
node --test test/persistence.test.mjs test/history.test.mjs test/client.test.mjs   # 或 npm test
```

覆盖：新建库、重启后数据保留、同槽位替换与重试累加、跨午夜的单轮时长归属、v1 JSON 迁移（含一次性与优先权）、v1 SQLite 原地升级、保留期清理（含明细与聚合）、`:memory:`、外部数据库拒绝、模型归属上限、命令输出、畸形事件容错、卸载时的收尾写入、突发事件的事务合并、**项目/会话/对话三级聚合与下钻路由**，以及四个回归用例：畸形事件不得拖垮持久化、turn 上限不得驱逐已聚合的对话、启动突发不得丢维度聚合、替换后的时间跨度必须跟随明细收缩。**历史回填**覆盖：日志重放出场次/会话/轮次聚合与单轮时长、重启不重复计数、实时记录过的会话跳过、`backfillHistory: false` 不读取日志；**日志读取**覆盖多帧 Zstandard、包内最高代次选择、header 快读、未压缩日志、撕裂尾帧容错、损坏帧报错。Client 侧用 `react-dom/server` 加一个只接管 `useState` 的 React shim 渲染真实 bundle，覆盖「用量」标签页的注册位置（`order: 15` / id / 中英文标签）、加载态、有数据态（会话标题、卡片、逐轮行）、空状态、错误态与无会话 id 的兜底。Client 测试依赖工作区里的 `react`；解析不到时整组跳过，插件本身仍零依赖。

## 发布新版本

```bash
# 1) 更新 package.json version，同步 client.js -> client.vN.js（若 Client 有改动）
# 2) 提交并打 tag，工作流会自动打包 tgz + zip 并创建 Release
git tag v1.4.0 && git push origin v1.4.0
```

本地手工打包：

```bash
npm pack                       # 生成 dsh-token-usage-stats-<version>.tgz
```

## 已知边界

- **历史回填的范围**：只补「数据库里没有的会话」。一个会话如果在插件激活之后才创建、或在激活时正被使用，它会以实时记录为准，日志里激活之前的那部分不会重复叠加；日志文件的最后写入时间早于 `retentionDays` 的直接跳过（导入了也会被下一次清理删掉，不如不读）。日志被宿主改写/迁移过的会话只读最高代次，两代内容一致（已用真实日志验证逐轮相等）。
- **会话「用量」标签页只统计该会话 id 自己的请求**：子代理（subagent）有独立的会话 id，其用量不会并入父会话的标签页（它们会以独立会话出现在仪表盘的「会话」维度里）；页面加载时机早于插件更新的老页面需要按 F5 才能看到新标签。
- **项目归属依赖会话头里的 `cwd`**：同一目录就是同一项目；目录改名会被视为新项目（与宿主 Workspace 的 `realpath` 口径不同，这里不做 realpath 规范化，避免在统计线程里做同步文件系统调用）。项目标题取目录最后一段，不做 Workspace 重命名同步。
- 多进程宿主（如 web 档案被多个进程同时使用）各自的统计进程独立；SQLite 通过 WAL + `busy_timeout` 容忍短暂并发，但多进程同时写入同一统计库仍属尽力而为，不保证合并后的精确性。
- 周起始为周一、时区为宿主本地时区；如需其他口径可在 profile 层覆盖后自行调整源码。
- `node:sqlite` 在部分 Node 版本仍标记为 experimental（会打印一行 ExperimentalWarning），API 保持稳定可用；若运行时缺失该模块则自动降级为内存统计。

## License

[MIT](LICENSE)

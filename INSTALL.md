# dsh-token-usage-stats 安装手册

在 DeepSeek Harness 中安装「Token 用量统计」插件：底部状态栏实时汇总、整页「使用统计」仪表盘（汇总卡片 / 每日趋势图 / **项目·会话·对话三级下钻** / 模型用量）、会话顶部的**「用量」标签页**（只看当前会话），并自动**回填安装前的历史用量**（读取宿主会话日志），附 `/tokenstats` 命令与 HTTP 汇总/下钻接口。

- **兼容性**：DeepSeek Harness **0.2.1-rc.2**（其他 0.2.x 版本通常兼容）；需要宿主运行时带内置 `node:sqlite`（Node ≥ 22.5，桌面版 Electron 44 + Node 24 已内置）
- **零依赖**：插件不依赖任何 npm 包，仅使用 Node 内置模块与宿主注入的服务（`webServer`；`commands` 可选，缺失时仅无命令），离线可装
- **数据本地**：统计只保存在本机 SQLite 文件 `~/.dsh/storages/token_usage_stats.sqlite`，不上传任何网络；从 v1 升级会自动导入旧的 `token_usage_stats.json` 并原地升级 SQLite 库

## 你手上的几种交付物

| 形式 | 用途 |
|---|---|
| npm 包 `@h643560027/dsh-token-usage-stats` | Plugin Manager「添加插件」直接粘贴包名安装（需联网；`npm i @h643560027/dsh-token-usage-stats` 也可） |
| `dsh-token-usage-stats.tgz` | 标准 npm 打包，Plugin Manager「添加插件」直接粘贴路径安装（从 [Releases](https://github.com/hfanshu/dsh-token-usage-stats/releases) 下载） |
| `dsh-token-usage-stats.zip` | 解压后得到插件目录，适合走本地目录安装 |
| 本仓库源码（git clone 后） | 开发 / 二次修改；仓库根目录即插件目录 |

## 方式一：Plugin Manager 界面安装（推荐）

1. 打开 Harness：**设置 → 插件**（Plugins）页面；
2. 点击 **添加插件**（Add plugin）；
3. 在包名/地址框中粘贴 **`@h643560027/dsh-token-usage-stats`**（npm 包名，需联网），
   或 **tgz 的绝对路径**（如 `E:\dist\dsh-token-usage-stats.tgz`），
   或解压 zip 后粘贴**插件目录的绝对路径**（如 `E:\dist\dsh-token-usage-stats`）；
   也可以直接粘贴 GitHub 仓库地址 `hfanshu/dsh-token-usage-stats`（需联网）；
4. 确认信任提示后点击 **安装**；
5. 安装完成后在插件列表中确认出现 **Token 用量统计**（Token Usage Stats）且已启用。

首次安装通常通过 HMR **实时生效**，无需重启。

## 方式二：让 DSH 代理安装（会话内执行）

在任意具备权限的 Harness 会话中，让代理调用 `plugin_manager` 工具：

- `action: install_bundle`
- `target:` tgz 或插件目录的**绝对路径**

代理会完成包安装与 bundle 注册，并回报 `application` 结果；出现 `pendingBuilds` 时需你确认构建脚本（本插件没有任何构建脚本，不会出现该提示）。

## 方式三：手动安装（高级用户）

适用于界面与代理都不可用的场景。以下步骤等效于 `install_bundle`，**需要自己承担时序**（先装包、再注册清单、最后重启）：

```powershell
# 1) 解压 zip（或直接使用源码目录），记下绝对路径，例如 E:\dist\dsh-token-usage-stats

# 2) 在档案目录把插件链接进依赖（档案名按你的环境替换，桌面版为 desktop，网页版为 web）
Set-Location "$env:USERPROFILE\.dsh\profiles\<档案名>"
pnpm add "link:E:/dist/dsh-token-usage-stats"

# 3) 编辑同目录 package.json：把 "dsh-token-usage-stats" 加入 dsh.profile.bundles 数组
#    {
#      "dsh": { "profile": { "bundles": [ ..., "dsh-token-usage-stats" ] }
#  }

# 4) 重启 Harness 应用（完全退出后重开）
```

> 桌面版（Electron）档案由应用独占管理，`dsh plugin --profile desktop` CLI 会拒绝操作，属正常现象；请走界面/代理安装，或按上述手动步骤并重启。

## 安装后验证清单

- [ ] 应用**窗口最底部**出现一条状态栏：`Token 用量  今日 xx · 本周 xx · 本月 xx`（无历史用量时显示 0）；
- [ ] 首次启动后若干秒内，**历史用量自动补上**：仪表盘的累计值/趋势图/热力图出现安装之前的日期，旧会话出现在「会话」「项目」维度（日志越大需要越久，本机 160 个日志约 7 秒；应用日志里有一行 `replayed N historical session(s)`）；
- [ ] 会话标题下方标签栏里，**「轨迹」后面**多出一个 **用量** 标签页；点开只显示当前会话的累计 Token、未命中输入、命中缓存、缓存写入、输出、计费请求、对话轮数，以及逐轮明细（为老页面补装时先按 **F5** 刷新）；打开一个安装前的老会话，也能看到它的历史用量；
- [ ] 状态栏右侧有 **统计面板** 按钮，点开显示「使用统计」页面（汇总卡片 / 趋势图 / **项目·会话·对话下钻** / 模型用量）；
- [ ] 点「项目」里的一行能进入该项目的会话列表，再点会话能进入它的每次对话；
- [ ] 对话输入 `/tokenstats` 返回今日/本周/本月统计文本；`/tokenstats --json` 返回 JSON；
- [ ]（可选）浏览器访问 `http://127.0.0.1:<端口>/api/token-stats` 返回 `"v":3` 的 JSON（随浏览器会话，需应用内已登录）。

## 配置（可选）

在**档案的** `cordis.patch.yml`（用户层）追加，无需改插件文件：

```yaml
- id: token-usage-stats
  name: 'dsh-token-usage-stats'
  config:
    retentionDays: 400   # 保留的天记录数（默认 400）
    detailDays: 14       # 底部栏明细与命令展示的近 N 天（默认 14）
    dbPath: '~/token-stats.sqlite'   # 可选：SQLite 文件路径（默认 $DSH_HOME/storages/token_usage_stats.sqlite）
    backfillHistory: true            # 可选：启动时从会话日志回填历史（默认 true）
    sessionsDir: '~/sessions'        # 可选：会话日志根目录（默认 $DSH_HOME/sessions）
```

改完保存即重组生效；统计口径（本地日历日、周一起算、每次计费尝试计一次、同一步内重试替换不重复计数、历史按会话去重回填）见 README。

## 使用入口一览

| 入口 | 内容 |
|---|---|
| 底部状态栏 | 今日 / 本周 / 本月 + 累计；「明细」展开近 14 天逐日拆分；「统计面板」打开整页仪表盘 |
| 历史回填 | 启动后自动读取 `$DSH_HOME/sessions` 的会话日志，把数据库里还没有的会话补进来（安装前的旧对话也会出现；重复启动不会重复计数，`backfillHistory: false` 可关闭） |
| 会话「用量」标签页 | 会话标题下方的标签栏（「轨迹」后面）：只统计当前会话——累计 Token / 未命中输入 / 命中缓存 / 缓存写入 / 输出 / 计费请求 / 对话轮数，附逐轮明细（对话序号、时间、时长、总 Token 与拆分、请求数）；右上角可跳转整页「统计面板」 |
| 使用统计面板 | 汇总卡片（累计 / 峰值 / 最长单轮时长 / 连续天数）、每日趋势图（近 7/30 日，整图可悬停看逐日精确用量）、**项目 / 会话 / 对话三级下钻**（每行含总 Token、命中缓存输入、未命中缓存输入、输出、请求数、时间）、模型用量排行 |
| `/tokenstats` | 对话内文本统计（含项目 Top5）；`--json` 机器可读 |
| `GET /api/token-stats` | 完整 JSON（`v:3`：today/week/month/recent/trend/heatmap/stats/models/allTime + requestCount/projects/sessions/turns） |
| `GET /api/token-stats/breakdown` | 按 `by=project\|session\|turn` 下钻，支持 `limit`、`project`、`session` 筛选 |

## 卸载

- Plugin Manager 中找到 **Token 用量统计** → 移除 / Disable；
- 手动安装的额外清理：从档案 `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 中删除该条目，删除档案 `node_modules` 中的对应链接，重启应用；
- 历史统计数据保留在 `~/.dsh/storages/token_usage_stats.sqlite`（含 `-wal` / `-shm` 伴生文件），**删除这些文件即清空统计**（删除前请先卸载插件，否则会在下次写入时重建）。升级自 v1 的用户还会看到 `token_usage_stats.json.migrated`，那是迁移后保留的旧 JSON 备份，可随时删除。

## 故障排查

| 现象 | 处理 |
|---|---|
| 底部状态栏不出现 | 插件行未激活：确认插件已启用；查看应用日志中 `token-usage-stats` 关键字。手动安装时确认 `dsh.profile.bundles` 已包含条目且已**重启** |
| 会话标签栏里没有「用量」 | 该标签注册在 `conversation.view` 槽位：先按 **F5** 刷新让 Client 重新加载；确认页面加载的是本次安装的 Client 代次（`package.json` 的 `exports "./client"`）；标签位于「轨迹」与「上下文」之间，窗口过窄时会收进标签栏的溢出菜单 |
| 状态栏在、仪表盘打不开 | 浏览器按 **F5 刷新**（Client 模块随页面加载；Host 更新则需重启应用） |
| 改了 Client 代码但界面没变化 | 热更新监听的是 **exports 指向的当前代次文件**：编辑 `client.js` 后需覆盖 `client.vN.js`，约 1 秒自动热替换（无需 F5）；若改动了 `exports "./client"` 换代路径，Host 会缓存该解析结果，**必须重启应用**才生效 |
| `/api/token-stats` 404 | 插件 Host 未激活（同第一行）；确认访问的是该 Harness 监听的端口与本机地址 |
| 历史用量没补上 | Host 侧改动需要**重启应用**才执行；重启后看应用日志是否有 `replayed N historical session(s)`。若没有：确认 `$DSH_HOME/sessions` 存在且非空、`backfillHistory` 没被设为 false、`sessionsDir` 指向正确；已经被实时记录过的会话会按设计跳过（不重复计数），已超过 `retentionDays` 的旧数据会被清理 |
| 界面出现「仅内存统计」标记 / 命令提示 SQLite 不可用 | 宿主运行时缺少 `node:sqlite` 或数据库文件无法打开：查看应用日志中 `sqlite unavailable` 一行；确认 Node ≥ 22.5，并检查 `dbPath` 指向的目录可写 |
| 升级后历史数据没了 | 旧 JSON 是否在 `storages/` 目录、是否已被重命名为 `*.migrated`；若迁移前数据库里已有同一天记录，以数据库为准（旧 JSON 不会覆盖） |
| 升级新版本后行为未变 | **替换已安装包的 Host 代码必须重启应用**；仅界面变化时刷新页面即可 |
| 装完被标记不兼容 | 插件未声明 `engines.dsh`/peer 版本限制，一般不会出现；若出现，按提示处理版本豁免或换用匹配版本 |

## 隐私与边界

- 统计自**插件激活之后**开始累计，不回填历史会话（避免任何重复计数风险）；从旧版本升级时的一次性 JSON 导入是唯一例外。
- 未上报 usage 的中断/失败请求不计入——这是使用量统计，不是计费账单；
- **项目归属**取会话头里的工作目录 `cwd`：同一目录算同一项目，目录改名会被视为新项目；无 `cwd` 的会话归入 `unknown`。
- 多进程档案（例如同一 web 档案被两个进程使用）各自统计进程独立；SQLite 用 WAL + `busy_timeout` 容忍短暂并发，但不保证多进程合并后的精确性；
- HTTP 接口本身不做鉴权校验，仅返回聚合数字（无消息内容、无凭据），默认随宿主 Web 服务只暴露本机或你的反代内网。

# dsh-token-usage-stats

> DeepSeek Harness 的 Token 用量统计插件：**「使用统计」整页仪表盘 + 底部常驻状态栏**，按日 / 周 / 月汇总用量，附 `/tokenstats` 命令与同源 HTTP 接口。

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.2-2f7cf6)](https://github.com/deepseek-ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

- **零 npm 依赖**：只使用宿主注入的服务，离线可装，任何 profile 安装布局都能解析
- **数据全部本地**：只写入 `~/.dsh/storages/token_usage_stats.json`，不联网、不上传
- **不重复计数**：恢复会话时回放的历史事件不会进入统计

## 快速安装

在 Harness 中：**设置 → 插件 → 添加插件**，粘贴以下任一绝对路径后点击安装：

- 发布包 `dsh-token-usage-stats.tgz`（从 [Releases](../../releases) 下载）
- 或本仓库克隆/解压后的目录路径

也可以让具备权限的 DSH 会话调用 `plugin_manager` 工具的 `install_bundle`，target 填上述路径。

完整步骤（含手动安装、验证清单、卸载、故障排查）见 **[INSTALL.md](INSTALL.md)**。

## 界面预览

| 入口 | 说明 |
|---|---|
| 底部状态栏 | `Token 用量  今日 xx · 本周 xx · 本月 xx`，右侧「统计面板 / 明细 / 刷新」 |
| 使用统计面板 | 汇总卡片 → 每日趋势图 → 模型用量 |

> 面板通过 `main` 全局面板注册（与插件市场页同一机制），从状态栏「统计面板」按钮打开，页内「返回会话」回到对话。

## 功能

- **「使用统计」仪表盘**（`main` 全局面板，key `token-usage-stats`）：
  - **汇总卡片**：累计 Token 数、峰值 Token 数（含峰值日期）、最长单轮时长、当前连续天数、最长连续天数；
  - **每日 Token 趋势图**：「近 7 日 / 近 30 日」切换的 SVG 面积折线图；**整图任意位置可悬停**，显示参考线、日期与逐日精确用量（输入/输出/缓存读/缓存写/请求数拆分）；
  - **模型用量**：按 `provider/model` 归属的用量排行（进度条 + 明细拆分）。
- **底部状态栏**（`shell.bottom` 槽位，横跨三列下方）：常驻「今日 / 本周 / 本月」Token 总量与累计值，「明细」展开近 14 天逐日列表。数字中文环境用 万/亿、英文环境用 K/M/B。
- **`/tokenstats` 命令**：对话内文本版统计（今日/本周/本月、峰值、连续天数、最长单轮、模型 Top5）；`--json` 返回完整机器可读 JSON。
- **HTTP 接口**：`GET /api/token-stats`（同源，随浏览器会话 Cookie）返回完整 JSON（`v:2`：today/week/month、recent/trend、heatmap、stats、models、allTime）。

## 统计口径

- 数据源是**每次计费尝试**的供应商上报用量（`assistant/message` / `assistant/attempt` 事件中的 usage；与官方 `dsh-token-meter` 的 `tokenUsage` 投影同一折叠语义）：
  - 同一 (turn, step) 内的新样本**替换**旧样本；`llm/retry-started` 关闭替换槽位，重试的尝试**累加**；替换同样作用于模型归属桶。
  - 恢复（resume/fork）时回放的历史事件不会进入统计（宿主的 `session/event` 只发布新提交的事件），不会重复计数。
- 按宿主进程**本地日历日**（`event.time` 提交时间）归档；周从周一起算，月为自然月；接口热力图窗口 365 天、趋势窗口 30 天。
- **模型归属**：取该会话最近一次 `request/header` 的 `provider/model`，格式 `provider/model`；无表头时归入 `unknown`。
- **时长**：`turn/start` → `turn/end` 的墙钟时间计入**开始当日**（`turnMs` 求和、`longestMs` 取最大）；「最长单轮时长」为全期最大值。当前连续天数在今日尚无数据时从昨日起算。
- 每日记录持久化在存储域 `token_usage_stats`（表 `days`，键为 `YYYY-MM-DD`），默认保留 400 天（`retentionDays`），可在 profile 的 `cordis.patch.yml` 覆盖。v1 记录（仅标量）可直接加载，新字段补零。
- 未产生 usage 上报的中断 / 失败请求不计入；这是使用量统计，不是计费账单。

## 配置（profile 的 `cordis.patch.yml` 用户层）

```yaml
- id: token-usage-stats
  name: 'dsh-token-usage-stats'
  config:
    retentionDays: 400   # 保留的天记录数
    detailDays: 14       # 明细列表与命令展示的近 N 天
```

## 架构

```
dsh-token-usage-stats/
├── package.json        # bundle 清单（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml    # 插件行与默认配置
├── index.js            # Host：session/event 折叠 → 存储域；/api/token-stats 路由；/tokenstats 命令
├── client.js           # Client 源码：shell.bottom 状态栏 + main 仪表盘（fetch 同源接口）
├── client.v6.js        # Client 当前代次（package.json 的 exports "./client" 指向它）
├── locale/             # Plugin Manager 元数据（en / zh）
├── icon.svg            # 原创图标
├── INSTALL.md          # 安装手册
├── LICENSE
└── .github/workflows/  # tag 推送自动打包并发布 Release
```

- **零外部依赖**：Host 只用 Node 内置能力 + 宿主注入的服务（`storageDomain`、`webServer`；`commands` 可选），不 import 任何 `@deepseek-ai/*` 包。
- **Client 数据通道**是同源 HTTP 路由而非远程服务协议，浏览器 `fetch('/api/token-stats')` 自带会话 Cookie；宿主侧路由本身不鉴权，仅返回聚合数字（无消息内容、无凭据）。
- **Client 代次机制**：浏览器模块身份由 `exports "./client"` 的路径决定，因此 Client 改动通过新增 `client.vN.js` 并改 export 路径来换代（刷新页面即生效，无需重启）；Host 改动则需重启应用。修改 `client.js` 后请同步覆盖当前代次文件。

## 发布新版本

```bash
# 1) 更新 package.json version，同步 client.js -> client.vN.js（若 Client 有改动）
# 2) 提交并打 tag，工作流会自动打包 tgz + zip 并创建 Release
git tag v1.0.6 && git push origin v1.0.6
```

本地手工打包：

```bash
npm pack                       # 生成 dsh-token-usage-stats-<version>.tgz
```

## 已知边界

- 统计覆盖本插件激活之后新提交的用量；激活前的历史会话不会回填（不重放旧日志，避免任何重复计数风险）。
- 多进程宿主（如 web 档案被多个进程同时使用）各自的统计进程独立；json 存储域为单进程语义。
- 周起始为周一、时区为宿主本地时区；如需其他口径可在 profile 层覆盖后自行调整源码。

## License

[MIT](LICENSE)

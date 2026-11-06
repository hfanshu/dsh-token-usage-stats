/**
 * dsh-token-usage-stats — Client half of the bundle (v3 breakdown edition).
 *
 * Generation note: package.json exports "./client" -> "./client.v8.js", an
 * identical served copy. The export PATH is the browser module identity, so
 * bumping it (client.v8.js -> client.v9.js, …) is how a changed client picks
 * up a fresh module generation without an app restart. After editing this
 * file, copy it over the current served generation and update the export.
 *
 * Two surfaces, one data source (the Host's same-origin /api/token-stats):
 *   1. A slim always-visible strip in the root `shell.bottom` slot with
 *      today / week / month totals and a button that opens the dashboard.
 *   2. A full "使用统计" dashboard registered as a global `main` panel
 *      (key `token-usage-stats`): summary cards, a GitHub-style token
 *      activity heatmap with 每日/每周/累计 modes, a 7/30-day trend chart,
 *      a per-model usage breakdown, and a 项目/会话/对话 breakdown with
 *      drill-down (project -> sessions -> turns) plus breadcrumb navigation.
 *
 * All data arrives over HTTP; the browser never touches storage or session
 * logs. Styling inherits the host theme through --dsw-alias-* tokens.
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-usage-stats',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'dsh-token-usage-stats';
    const ROUTE = '/api/token-stats';
    const BREAKDOWN_ROUTE = '/api/token-stats/breakdown';
    const REFRESH_MS = 30000;
    const PANEL_ID = 'token-usage-stats';
    // Root dimension -> summary payload field. Older hosts omit all three.
    const BREAKDOWN_FIELD = { project: 'projects', session: 'sessions', turn: 'turns' };

    // Inline dictionaries; locale/*.json files carry Plugin Manager meta.
    const DICT = {
      zh: {
        'bar.label': 'Token 用量统计',
        'bar.title': 'Token 用量',
        'period.today': '今日',
        'period.week': '本周',
        'period.month': '本月',
        'action.refresh': '刷新',
        'action.detail': '明细',
        'action.collapse': '收起',
        'action.panel': '统计面板',
        'action.back': '返回会话',
        'state.loading': '正在读取用量统计…',
        'state.error': '统计服务不可用',
        'state.memoryOnly': '仅内存统计',
        'detail.recent': '近 {{count}} 天',
        'detail.breakdown': '输入 {{input}} · 输出 {{output}} · 缓存读 {{cacheRead}} · 缓存写 {{cacheWrite}} · 请求 {{settlements}}',
        'detail.empty': '该区间暂无用量记录',
        'allTime': '累计 {{total}}',
        'page.title': '使用统计',
        'page.badge': '应用用量',
        'card.total': '累计 Token 数',
        'card.peak': '峰值 Token 数',
        'card.peakSub': '{{date}}',
        'card.longest': '最长单轮时长',
        'card.streak': '当前连续天数',
        'card.streakLongest': '最长连续天数',
        'card.days': '{{count}} 天',
        'range.title': '时间范围',
        'range.d7': '近 7 日',
        'range.d30': '近 30 日',
        'trend.title': '每日 Token 趋势图',
        'trend.empty': '还没有可展示的数据',
        'trend.emptyHint': '当前区间暂无可展示的用量数据。',
        'models.title': '模型用量',
        'models.empty': '暂无模型归属数据（等待新请求上报）',
        'models.rounds': '{{count}} 次请求',
        'breakdown.title': '项目 / 会话 / 对话',
        'breakdown.tabs': '统计维度',
        'breakdown.tab.project': '项目',
        'breakdown.tab.session': '会话',
        'breakdown.tab.turn': '对话',
        'breakdown.col.name': '名称',
        'breakdown.col.total': '总 Token',
        'breakdown.col.cacheRead': '命中缓存输入',
        'breakdown.col.input': '未命中缓存输入',
        'breakdown.col.output': '输出',
        'breakdown.col.requests': '请求数',
        'breakdown.col.time': '时间',
        'breakdown.loading': '正在读取明细…',
        'breakdown.error': '明细加载失败',
        'breakdown.retry': '重试',
        'breakdown.empty': '暂无明细数据',
        'breakdown.emptyHint': '当前维度暂无可展示的记录。',
        'breakdown.untitled': '未命名项目',
        'breakdown.untitledSession': '未命名会话',
        'breakdown.turnLabel': '对话 #{{turn}}',
        'breakdown.sessionCount': '{{count}} 个会话',
        'breakdown.back': '返回上一级',
        'breakdown.root': '全部',
        'breakdown.totals': '合计 {{total}} · 请求 {{requests}}',
        'breakdown.topN': '仅展示前 {{count}} 条',
        'breakdown.drillProject': '查看该项目的会话',
        'breakdown.drillSession': '查看该会话的对话',
        'footer.hint': '统计自插件激活起累计 · 本地时区 {{tz}} · 每 30 秒自动刷新',
      },
      en: {
        'bar.label': 'Token usage statistics',
        'bar.title': 'Tokens',
        'period.today': 'Today',
        'period.week': 'This week',
        'period.month': 'This month',
        'action.refresh': 'Refresh',
        'action.detail': 'Details',
        'action.collapse': 'Collapse',
        'action.panel': 'Dashboard',
        'action.back': 'Back to chat',
        'state.loading': 'Loading usage statistics…',
        'state.error': 'Statistics service unavailable',
        'state.memoryOnly': 'Memory-only',
        'detail.recent': 'Last {{count}} days',
        'detail.breakdown': 'Input {{input}} · Output {{output}} · Cache read {{cacheRead}} · Cache write {{cacheWrite}} · Calls {{settlements}}',
        'detail.empty': 'No usage recorded in this period',
        'allTime': 'All time {{total}}',
        'page.title': 'Usage Statistics',
        'page.badge': 'App usage',
        'card.total': 'Total tokens',
        'card.peak': 'Peak day',
        'card.peakSub': '{{date}}',
        'card.longest': 'Longest turn',
        'card.streak': 'Current streak',
        'card.streakLongest': 'Longest streak',
        'card.days': '{{count}} days',
        'range.title': 'Range',
        'range.d7': 'Last 7 days',
        'range.d30': 'Last 30 days',
        'trend.title': 'Daily token trend',
        'trend.empty': 'No data to display yet',
        'trend.emptyHint': 'No usage recorded in this range yet.',
        'models.title': 'Model usage',
        'models.empty': 'No model attribution yet (waiting for new requests)',
        'models.rounds': '{{count}} calls',
        'breakdown.title': 'Projects / Sessions / Turns',
        'breakdown.tabs': 'Dimension',
        'breakdown.tab.project': 'Projects',
        'breakdown.tab.session': 'Sessions',
        'breakdown.tab.turn': 'Turns',
        'breakdown.col.name': 'Name',
        'breakdown.col.total': 'Total tokens',
        'breakdown.col.cacheRead': 'Cached input',
        'breakdown.col.input': 'Uncached input',
        'breakdown.col.output': 'Output',
        'breakdown.col.requests': 'Calls',
        'breakdown.col.time': 'Time',
        'breakdown.loading': 'Loading breakdown…',
        'breakdown.error': 'Failed to load breakdown',
        'breakdown.retry': 'Retry',
        'breakdown.empty': 'No breakdown data yet',
        'breakdown.emptyHint': 'No records to show for this dimension.',
        'breakdown.untitled': 'Untitled project',
        'breakdown.untitledSession': 'Untitled session',
        'breakdown.turnLabel': 'Turn #{{turn}}',
        'breakdown.sessionCount': '{{count}} sessions',
        'breakdown.back': 'Back one level',
        'breakdown.root': 'All',
        'breakdown.totals': 'Total {{total}} · {{requests}} calls',
        'breakdown.topN': 'Top {{count}} rows only',
        'breakdown.drillProject': 'View this project’s sessions',
        'breakdown.drillSession': 'View this session’s turns',
        'footer.hint': 'Counted since activation · timezone {{tz}} · refreshes every 30s',
      },
    };

    function lookup(dict, path) {
      return path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), dict);
    }

    function interpolate(template, vars) {
      if (typeof template !== 'string') return template;
      return template.replace(/\{\{(\w+)\}\}/g, (match, name) => (vars && vars[name] !== undefined ? String(vars[name]) : match));
    }

    function createT(ctx) {
      try {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en });
          const bound = ctx.locale.bind(NS);
          if (typeof bound === 'function') {
            return (key, vars) => {
              const value = bound(key);
              return typeof value === 'string' ? interpolate(value, vars) : interpolate(lookup(DICT.zh, key) ?? key, vars);
            };
          }
        }
      } catch {
        // Locale service unavailable: fall back to the inline dictionaries.
      }
      const language = String((ctx.locale && ctx.locale.language) || (typeof navigator !== 'undefined' ? navigator.language : 'zh') || 'zh');
      const dict = language.toLowerCase().startsWith('zh') ? DICT.zh : DICT.en;
      return (key, vars) => interpolate(lookup(dict, key) ?? key, vars);
    }

    function languageOf(ctx) {
      const language = String((ctx.locale && ctx.locale.language) || (typeof navigator !== 'undefined' ? navigator.language : 'zh') || 'zh');
      return language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }

    /** Compact count: zh uses 万/亿, en uses K/M/B. */
    function formatCount(value, lang) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      if (lang === 'zh') {
        if (value >= 1e8) return `${(value / 1e8).toFixed(value >= 1e9 ? 0 : 1)}亿`;
        if (value >= 1e4) return `${(value / 1e4).toFixed(value >= 1e6 ? 0 : 1)}万`;
        return value.toLocaleString('en-US');
      }
      if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
      if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
      if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
      return value.toLocaleString('en-US');
    }

    function formatExact(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
    }

    /** Milliseconds -> "X 小时 Y 分钟" / "Xh Ym". */
    function formatDuration(ms, lang) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return lang === 'zh' ? '0 分钟' : '0m';
      const minutes = Math.round(ms / 60000);
      if (lang === 'zh') {
        if (minutes < 60) return `${minutes} 分钟`;
        return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
      }
      if (minutes < 60) return `${minutes}m`;
      return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    }

    /** Tooltip date label: 2026年10月19日 / Oct 19, 2026. */
    function formatDateLabel(dateKey, lang) {
      const [year, month, day] = dateKey.split('-').map(Number);
      if (lang === 'zh') return `${year}年${month}月${day}日`;
      const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${names[month - 1]} ${day}, ${year}`;
    }

    const pad2 = (value) => String(value).padStart(2, '0');

    /** Epoch milliseconds -> "YYYY-MM-DD HH:mm" in the viewer's local zone. */
    function formatTimestamp(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
      const date = new Date(ms);
      if (Number.isNaN(date.getTime())) return '—';
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    /** Turn wall-clock span: 45 秒 / 3 分 20 秒 / 1 小时 05 分, "45s" / "3m 20s" / "1h 05m". */
    function formatSpan(ms, lang) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
      const totalSeconds = Math.max(1, Math.round(ms / 1000));
      if (totalSeconds < 60) return lang === 'zh' ? `${totalSeconds} 秒` : `${totalSeconds}s`;
      const totalMinutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      if (totalMinutes < 60) {
        return lang === 'zh'
          ? `${totalMinutes} 分 ${pad2(seconds)} 秒`
          : `${totalMinutes}m ${pad2(seconds)}s`;
      }
      const hours = Math.floor(totalMinutes / 60);
      return lang === 'zh'
        ? `${hours} 小时 ${pad2(totalMinutes % 60)} 分`
        : `${hours}h ${pad2(totalMinutes % 60)}m`;
    }

    /** Time column for a breakdown row: turn spans, everything else a timestamp range. */
    function rowTimeLabel(row, lang, dimension) {
      if (dimension === 'turn') {
        return row.durationMs !== undefined && row.durationMs !== null
          ? formatSpan(row.durationMs, lang)
          : formatTimestamp(row.startTs ?? row.endTs);
      }
      const first = formatTimestamp(row.firstTs);
      const last = formatTimestamp(row.lastTs);
      if (first === '—') return last;
      if (last === '—' || first === last) return first;
      return `${first} → ${last}`;
    }

    const STYLE_ID = 'dsh-token-usage-stats-style';
    const styleText = `
.dst-bar{display:flex;align-items:center;gap:16px;padding:4px 16px;min-height:28px;box-sizing:border-box;background:var(--dsw-alias-bg-base);border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));color:var(--dsw-alias-label-secondary,#666);font-size:12px;line-height:1.4}
.dst-title{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border:none;background:transparent;border-radius:var(--dsw-radius-md,6px);color:var(--dsw-alias-label-secondary,#666);font-size:12px;cursor:pointer}
.dst-title:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dst-title:focus-visible,.dst-btn:focus-visible,.dst-seg button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#2f7cf6);outline-offset:1px}
.dst-title svg{display:block;opacity:.75}
.dst-stat{display:inline-flex;align-items:baseline;gap:6px;white-space:nowrap}
.dst-stat-label{color:var(--dsw-alias-label-tertiary,#999)}
.dst-stat-value{color:var(--dsw-alias-label-primary,#333);font-variant-numeric:tabular-nums;font-weight:600}
.dst-spacer{flex:1 1 auto}
.dst-badge{padding:1px 6px;border-radius:var(--dsw-radius-sm,4px);background:var(--dsw-alias-state-warning-soft,rgba(210,150,0,.12));color:var(--dsw-alias-state-warning-primary,#b58105);font-size:11px}
.dst-error{color:var(--dsw-alias-state-error-primary,#e5484d);font-size:11px}
.dst-btn{padding:2px 8px;border-radius:var(--dsw-radius-md,6px);border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:11px;cursor:pointer}
.dst-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dst-btn[aria-expanded=true]{color:var(--dsw-alias-label-primary,#333);border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.2))}
.dst-detail{padding:6px 16px 8px;background:var(--dsw-alias-bg-base);border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06));display:flex;flex-direction:column;gap:2px;max-height:208px;overflow-y:auto}
.dst-day{display:grid;grid-template-columns:88px minmax(80px,220px) 72px;align-items:center;gap:10px;padding:1px 0}
.dst-day-date{color:var(--dsw-alias-label-tertiary,#999);font-variant-numeric:tabular-nums}
.dst-day-track{position:relative;height:8px;border-radius:4px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05));overflow:hidden}
.dst-day-fill{position:absolute;inset:0 auto 0 0;border-radius:4px;background:var(--dsw-alias-accent-primary,#2f7cf6);opacity:.75;min-width:2px}
.dst-day-total{text-align:right;color:var(--dsw-alias-label-primary,#333);font-variant-numeric:tabular-nums}
.dst-day:hover .dst-day-breakdown{display:block}
.dst-day-breakdown{display:none;grid-column:1/-1;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;padding:0 0 2px}
.dst-foot{display:flex;gap:12px;align-items:center;padding-top:4px;color:var(--dsw-alias-label-tertiary,#999);font-size:11px}
.dst-page{padding:20px 24px 32px;color:var(--dsw-alias-label-primary,#333);font-size:13px;overflow-y:auto;height:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base)}
.dst-page-inner{max-width:960px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.dst-page-head{display:flex;align-items:center;gap:12px}
.dst-page-title{font-size:22px;font-weight:700;margin:0;color:var(--dsw-alias-label-primary,#333)}
.dst-page-badge{padding:2px 10px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#666);font-size:12px}
.dst-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:12px}
.dst-card{padding:14px 16px;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04));border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06));display:flex;flex-direction:column;gap:6px;min-width:0}
.dst-card-value{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#333);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dst-card-label{font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}
.dst-card-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#aaa)}
.dst-section{padding:16px;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04));border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06));display:flex;flex-direction:column;gap:12px}
.dst-section-head{display:flex;align-items:center;gap:12px}
.dst-section-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#333)}
.dst-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:var(--dsw-radius-md,8px);overflow:hidden;margin-left:auto}
.dst-seg button{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:12px;padding:3px 10px;cursor:pointer}
.dst-seg button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dst-seg button[aria-pressed=true]{background:var(--dsw-alias-accent-primary,#2f7cf6);color:#fff}
.dst-empty{padding:28px 12px;text-align:center;color:var(--dsw-alias-label-tertiary,#999);border:1px dashed var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:var(--dsw-radius-md,8px)}
.dst-empty-title{font-size:13px;color:var(--dsw-alias-label-secondary,#666);margin-bottom:4px}
.dst-chart-wrap{position:relative;width:100%}
.dst-chart{width:100%;height:auto;display:block}
.dst-chart-tip{position:absolute;top:4px;z-index:2;pointer-events:none;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.98));border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));box-shadow:0 4px 14px rgba(0,0,0,.14);color:var(--dsw-alias-label-primary,#333);font-size:12px;line-height:1.5;white-space:nowrap}
.dst-chart-tip-date{color:var(--dsw-alias-label-tertiary,#999);font-size:11px}
.dst-chart-tip-total{font-weight:600;font-variant-numeric:tabular-nums}
.dst-chart-tip-sub{color:var(--dsw-alias-label-tertiary,#999);font-size:11px}
.dst-models{display:flex;flex-direction:column;gap:10px}
.dst-model{display:grid;grid-template-columns:minmax(120px,220px) 1fr 88px;gap:10px;align-items:center}
.dst-model-name{font-size:12px;color:var(--dsw-alias-label-secondary,#666);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-model-track{position:relative;height:10px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));overflow:hidden}
.dst-model-fill{position:absolute;inset:0 auto 0 0;border-radius:5px;background:var(--dsw-alias-accent-primary,#2f7cf6);opacity:.8;min-width:2px}
.dst-model-total{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#333)}
.dst-model-sub{grid-column:1/-1;font-size:11px;color:var(--dsw-alias-label-tertiary,#999);margin-top:-6px}
.dst-crumbs{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}
.dst-crumbs-back{display:inline-flex}
.dst-crumb-link{padding:1px 6px;border:none;border-radius:var(--dsw-radius-sm,4px);background:transparent;color:var(--dsw-alias-label-secondary,#666);font:inherit;font-size:12px;cursor:pointer;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-crumb-link:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#333)}
.dst-crumb-link:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#2f7cf6);outline-offset:1px}
.dst-crumb-sep{opacity:.6}
.dst-crumb-current{color:var(--dsw-alias-label-primary,#333);font-weight:600;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-table{display:flex;flex-direction:column;gap:2px;min-width:0;overflow-x:auto;container-type:inline-size}
.dst-table-head,.dst-row{display:grid;grid-template-columns:minmax(120px,1.6fr) minmax(68px,92px) minmax(80px,104px) minmax(80px,104px) minmax(56px,88px) minmax(46px,68px) minmax(104px,1.3fr);gap:10px;align-items:center;min-width:0}
.dst-table-head{padding:0 8px 4px;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06))}
.dst-table-head span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-table-head .dst-num{text-align:right}
.dst-row{padding:5px 8px;border-radius:var(--dsw-radius-sm,6px);border:none;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:default;min-width:0}
button.dst-row{cursor:pointer}
button.dst-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
button.dst-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#2f7cf6);outline-offset:-1px}
.dst-row-name{display:flex;flex-direction:column;gap:1px;min-width:0}
.dst-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#333)}
.dst-row-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-row .dst-num{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#666);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-row .dst-num-strong{color:var(--dsw-alias-label-primary,#333);font-weight:600}
.dst-row .dst-time{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-row-skel{height:30px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));opacity:.7}
.dst-breakdown-foot{display:flex;align-items:center;gap:12px;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;flex-wrap:wrap}
.dst-breakdown-note{color:var(--dsw-alias-label-tertiary,#999)}
@container (max-width:640px){.dst-table-head,.dst-row{grid-template-columns:minmax(96px,1.4fr) minmax(56px,84px) minmax(72px,92px) minmax(72px,92px) minmax(48px,80px) minmax(40px,60px)}.dst-col-time{display:none}}
`;

    /**
     * Install (or refresh) the plugin stylesheet.
     *
     * Host HMR (`client-hmr`) tears a plugin fiber down and re-imports the
     * bundle in place, so an existing tag must be updated rather than skipped:
     * a CSS-only change would otherwise never reach an open page. `data-plugin`
     * marks ownership so the Host's `removeOwnedStyles` drops the tag together
     * with the old fiber; a tag left by an older generation without the
     * attribute is adopted here on first re-import.
     */
    function ensureStyle() {
      if (typeof document === 'undefined') return;
      let style = document.getElementById(STYLE_ID);
      if (style === null) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        document.head.appendChild(style);
      }
      style.setAttribute('data-plugin', NS);
      if (style.textContent !== styleText) style.textContent = styleText;
    }

    /** Fetch the Host summary; throws on non-2xx. */
    function fetchSummary() {
      return fetch(ROUTE, { credentials: 'same-origin', headers: { accept: 'application/json' } }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
    }

    /** Shared load-into-state effect: immediate + interval refresh. */
    function useSummary(refreshMs) {
      const [state, setState] = React.useState({ loading: true, data: null, error: null });
      const load = React.useCallback(() => {
        let cancelled = false;
        setState((previous) => ({ ...previous, loading: true }));
        Promise.resolve()
          .then(fetchSummary)
          .then((json) => {
            if (!cancelled) setState({ loading: false, data: json, error: null });
          })
          .catch((error) => {
            if (!cancelled) setState({ loading: false, data: null, error: String(error && error.message ? error.message : error) });
          });
        return () => {
          cancelled = true;
        };
      }, []);
      React.useEffect(() => {
        const cleanup = load();
        const timer = setInterval(load, refreshMs);
        return () => {
          cleanup();
          clearInterval(timer);
        };
      }, [load, refreshMs]);
      return [state, load];
    }

    /** The small day/week/month glyph. */
    function Glyph() {
      return h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true },
        h('rect', { x: 1.5, y: 9, width: 3.2, height: 5.5, rx: 1, fill: 'currentColor', opacity: '.55' }),
        h('rect', { x: 6.4, y: 5.5, width: 3.2, height: 9, rx: 1, fill: 'currentColor', opacity: '.8' }),
        h('rect', { x: 11.3, y: 2, width: 3.2, height: 12.5, rx: 1, fill: 'currentColor' }));
    }

    /** Segmented control used by heatmap modes and trend range. */
    function Segmented({ options, active, onSelect, label }) {
      return h('div', { className: 'dst-seg', role: 'group', 'aria-label': label },
        options.map((option) => h('button', {
          key: option.id,
          type: 'button',
          'aria-pressed': option.id === active,
          onClick: () => onSelect(option.id),
        }, option.label)));
    }

    function Stat({ t, lang, labelKey, period }) {
      return h('span', { className: 'dst-stat' },
        h('span', { className: 'dst-stat-label' }, t(labelKey)),
        h('span', { className: 'dst-stat-value' }, formatCount(period && period.total, lang)));
    }

    // ---- bottom bar ---------------------------------------------------------
    function UsageBar({ t, lang, ctx }) {
      const [state, load] = useSummary(REFRESH_MS);
      const [expanded, setExpanded] = React.useState(false);
      const { data } = state;
      const openPanel = () => {
        try {
          if (ctx.layout && typeof ctx.layout.selectPanel === 'function') ctx.layout.selectPanel(PANEL_ID);
        } catch (error) {
          console.warn('token-usage-stats: selectPanel failed', error);
        }
      };
      return h('div', { className: 'dst-root' },
        h('div', { className: 'dst-bar', role: 'group', 'aria-label': t('bar.label') },
          h('button', {
            type: 'button',
            className: 'dst-title',
            'aria-expanded': expanded,
            'aria-label': t('bar.label'),
            onClick: () => setExpanded((value) => !value),
          }, h(Glyph), t('bar.title')),
          data
            ? h(React.Fragment, null,
                h(Stat, { t, lang, labelKey: 'period.today', period: data.today }),
                h(Stat, { t, lang, labelKey: 'period.week', period: data.week }),
                h(Stat, { t, lang, labelKey: 'period.month', period: data.month }))
            : h('span', { className: 'dst-stat-label' }, state.error ? t('state.error') : t('state.loading')),
          data && data.persisted === false ? h('span', { className: 'dst-badge', title: t('state.memoryOnly') }, t('state.memoryOnly')) : null,
          state.error ? h('span', { className: 'dst-error' }, state.error) : null,
          h('span', { className: 'dst-spacer' }),
          data ? h('span', { className: 'dst-stat-label' }, interpolate(t('allTime'), { total: formatCount(data.allTime && data.allTime.total, lang) })) : null,
          h('button', { type: 'button', className: 'dst-btn', onClick: openPanel }, t('action.panel')),
          h('button', {
            type: 'button',
            className: 'dst-btn',
            onClick: () => setExpanded((value) => !value),
            'aria-expanded': expanded,
            'aria-controls': 'dst-detail',
          }, expanded ? t('action.collapse') : t('action.detail')),
          h('button', { type: 'button', className: 'dst-btn', onClick: load, disabled: state.loading }, t('action.refresh'))),
        expanded
          ? h('div', { className: 'dst-detail', id: 'dst-detail' },
              data && data.recent && data.recent.length > 0
                ? (() => {
                    const max = maxOf(data.recent);
                    return data.recent.slice().reverse().map((day) => h('div', { className: 'dst-day', key: day.date },
                    h('span', { className: 'dst-day-date' }, day.date),
                    h('span', { className: 'dst-day-track', title: formatExact(day.total) },
                      h('span', { className: 'dst-day-fill', style: { width: `${max > 0 ? Math.max(day.total > 0 ? 2 : 0, (day.total / max) * 100) : 0}%` } })),
                    h('span', { className: 'dst-day-total' }, formatExact(day.total)),
                    h('span', { className: 'dst-day-breakdown' }, interpolate(t('detail.breakdown'), {
                      input: formatExact(day.input),
                      output: formatExact(day.output),
                      cacheRead: formatExact(day.cacheRead),
                      cacheWrite: formatExact(day.cacheWrite),
                      settlements: formatExact(day.settlements),
                    }))));
                  })()
                : h('div', { className: 'dst-day-breakdown', style: { display: 'block' } }, t('detail.empty')),
              data ? h('div', { className: 'dst-foot' },
                h('span', null, interpolate(t('detail.recent'), { count: data.recent ? data.recent.length : 0 })),
                h('span', null, data.timeZone || '')) : null)
          : null);
    }

    function maxOf(rows) {
      return rows.reduce((max, row) => Math.max(max, row.total), 0);
    }

    // ---- dashboard ----------------------------------------------------------
    function Cards({ t, lang, stats, allTime }) {
      const card = (value, labelKey, sub) => h('div', { className: 'dst-card' },
        h('div', { className: 'dst-card-value' }, value),
        h('div', { className: 'dst-card-label' }, t(labelKey)),
        sub ? h('div', { className: 'dst-card-sub' }, sub) : null);
      return h('div', { className: 'dst-cards' },
        card(formatCount(allTime && allTime.total, lang), 'card.total'),
        card(formatCount(stats && stats.peak && stats.peak.total, lang), 'card.peak',
          stats && stats.peak && stats.peak.date ? interpolate(t('card.peakSub'), { date: stats.peak.date }) : null),
        card(formatDuration(stats && stats.longestTurnMs, lang), 'card.longest'),
        card(interpolate(t('card.days'), { count: stats ? stats.currentStreak : 0 }), 'card.streak'),
        card(interpolate(t('card.days'), { count: stats ? stats.longestStreak : 0 }), 'card.streakLongest'));
    }

    /** Compact SVG area+line trend chart over the selected range, with an
     *  interactive hover: any x position highlights the nearest day, draws a
     *  guide line, and shows a floating tooltip with the exact date, total,
     *  and input/output/cache/call breakdown. */
    function TrendChart({ t, lang, rows }) {
      const [range, setRange] = React.useState(7);
      const [hover, setHover] = React.useState(null);
      const slice = (rows || []).slice(-range);
      const hasData = slice.some((row) => row.total > 0);
      const pickRange = (id) => {
        setRange(Number(id));
        setHover(null);
      };
      return h('div', null,
        h('div', { className: 'dst-section-head' },
          h('div', { className: 'dst-section-title' }, t('trend.title')),
          h(Segmented, {
            label: t('range.title'),
            active: String(range),
            onSelect: pickRange,
            options: [
              { id: '7', label: t('range.d7') },
              { id: '30', label: t('range.d30') },
            ],
          })),
        hasData
          ? trendChartBody(slice, hover, setHover, t, lang)
          : h('div', { className: 'dst-empty' },
              h('div', { className: 'dst-empty-title' }, t('trend.empty')),
              h('div', null, t('trend.emptyHint'))));
    }

    function trendChartBody(rows, hover, setHover, t, lang) {
      const width = 640;
      const height = 200;
      const pad = { left: 56, right: 12, top: 16, bottom: 26 };
      const chartW = width - pad.left - pad.right;
      const chartH = height - pad.top - pad.bottom;
      const max = Math.max(1, maxOf(rows));
      const x = (index) => pad.left + (rows.length === 1 ? chartW / 2 : (index / (rows.length - 1)) * chartW);
      const y = (value) => pad.top + chartH - (value / max) * chartH;
      const step = rows.length > 1 ? chartW / (rows.length - 1) : chartW;
      const line = rows.map((row, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(row.total).toFixed(1)}`).join(' ');
      const area = `${line} L${x(rows.length - 1).toFixed(1)},${(pad.top + chartH).toFixed(1)} L${x(0).toFixed(1)},${(pad.top + chartH).toFixed(1)} Z`;
      const ticks = [0, max / 2, max];
      const labelIndexes = rows.length <= 7 ? rows.map((_, index) => index) : [0, Math.floor((rows.length - 1) / 2), rows.length - 1];
      const clampedHover = hover === null ? null : Math.max(0, Math.min(rows.length - 1, hover));
      const hoveredRow = clampedHover === null ? null : rows[clampedHover];
      // Pointer -> nearest index: convert client pixels back into viewBox
      // units (the SVG scales freely with the container width).
      const onMove = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width) return;
        const viewX = (event.clientX - rect.left) * (width / rect.width);
        const index = Math.round((viewX - pad.left) / step);
        setHover(Math.max(0, Math.min(rows.length - 1, index)));
      };
      // Keep the tooltip inside the container near either edge.
      const tipPercent = hoveredRow === null ? 0 : Math.min(90, Math.max(10, (x(clampedHover) / width) * 100));
      const tipTransform = clampedHover === null ? 'translateX(-50%)'
        : x(clampedHover) < width * 0.18 ? 'translateX(-15%)'
        : x(clampedHover) > width * 0.82 ? 'translateX(-85%)'
        : 'translateX(-50%)';
      return h('div', { className: 'dst-chart-wrap' },
        h('svg', { className: 'dst-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': t('trend.title') },
          ticks.map((tick, index) => h('g', { key: `t${index}` },
            h('line', { x1: pad.left, x2: width - pad.right, y1: y(tick), y2: y(tick), stroke: 'var(--dsw-alias-border-l2,rgba(0,0,0,.08))', 'stroke-dasharray': index === 0 ? '' : '3 3' }),
            h('text', { x: pad.left - 6, y: y(tick) + 4, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--dsw-alias-label-tertiary,#999)' }, formatCount(Math.round(tick), lang)))),
          h('path', { d: area, fill: 'var(--dsw-alias-accent-primary,#2f7cf6)', opacity: '.12' }),
          h('path', { d: line, fill: 'none', stroke: 'var(--dsw-alias-accent-primary,#2f7cf6)', 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
          rows.map((row, index) => row.total > 0
            ? h('circle', {
                key: row.date,
                cx: x(index),
                cy: y(row.total),
                r: index === clampedHover ? (rows.length <= 7 ? 4.5 : 3.5) : (rows.length <= 7 ? 3 : 2),
                fill: 'var(--dsw-alias-accent-primary,#2f7cf6)',
                stroke: 'var(--dsw-alias-bg-base,#fff)',
                'stroke-width': 1,
              })
            : null),
          clampedHover !== null
            ? h('line', {
                x1: x(clampedHover),
                x2: x(clampedHover),
                y1: pad.top,
                y2: pad.top + chartH,
                stroke: 'var(--dsw-alias-accent-primary,#2f7cf6)',
                'stroke-width': 1,
                'stroke-dasharray': '3 3',
                opacity: '.55',
              })
            : null,
          labelIndexes.map((index) => h('text', {
            key: `x${index}`,
            x: x(index),
            y: height - 8,
            'text-anchor': index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle',
            'font-size': 10,
            fill: 'var(--dsw-alias-label-tertiary,#999)',
          }, rows[index].date.slice(5))),
          // Full-height hit strip: the whole chart is hoverable, not just dots.
          h('rect', {
            x: pad.left,
            y: pad.top,
            width: chartW,
            height: chartH,
            fill: 'transparent',
            style: { cursor: 'crosshair' },
            onMouseMove: onMove,
            onMouseLeave: () => setHover(null),
          })),
        hoveredRow
          ? h('div', { className: 'dst-chart-tip', style: { left: `${tipPercent}%`, transform: tipTransform } },
              h('div', { className: 'dst-chart-tip-date' }, formatDateLabel(hoveredRow.date, lang)),
              h('div', { className: 'dst-chart-tip-total' }, `${formatExact(hoveredRow.total)} tokens`),
              h('div', { className: 'dst-chart-tip-sub' }, interpolate(t('detail.breakdown'), {
                input: formatExact(hoveredRow.input),
                output: formatExact(hoveredRow.output),
                cacheRead: formatExact(hoveredRow.cacheRead),
                cacheWrite: formatExact(hoveredRow.cacheWrite),
                settlements: formatExact(hoveredRow.settlements),
              })))
          : null);
    }

    /** Per-model usage breakdown. */
    function ModelUsage({ t, lang, models }) {
      if (!models || models.length === 0) {
        return h('div', { className: 'dst-empty' }, t('models.empty'));
      }
      const max = Math.max(1, models[0].total);
      return h('div', { className: 'dst-models' },
        models.slice(0, 12).map((row) => h('div', { className: 'dst-model', key: row.id },
          h('span', { className: 'dst-model-name', title: row.id }, row.id),
          h('span', { className: 'dst-model-track' },
            h('span', { className: 'dst-model-fill', style: { width: `${Math.max(2, (row.total / max) * 100)}%` } })),
          h('span', { className: 'dst-model-total' }, formatCount(row.total, lang)),
          h('span', { className: 'dst-model-sub' }, interpolate(t('detail.breakdown'), {
            input: formatExact(row.input),
            output: formatExact(row.output),
            cacheRead: formatExact(row.cacheRead),
            cacheWrite: formatExact(row.cacheWrite),
            settlements: formatExact(row.settlements),
          })))));
    }

    // ---- project / session / turn breakdown ---------------------------------
    const BREAKDOWN_LIMIT = 50;

    /** Fetch one breakdown page; throws on non-2xx. */
    function fetchBreakdown(level) {
      const search = new URLSearchParams();
      search.set('by', level.by);
      search.set('limit', String(BREAKDOWN_LIMIT));
      if (level.project) search.set('project', level.project);
      if (level.session) search.set('session', level.session);
      return fetch(`${BREAKDOWN_ROUTE}?${search.toString()}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
    }

    /** Load one drill-down level; `enabled` false means "use the summary rows". */
    function useBreakdown(level, enabled, revision) {
      const key = enabled ? `${level.by}|${level.project || ''}|${level.session || ''}` : '';
      const [state, setState] = React.useState({ key: '', loading: false, rows: [], totals: null, error: null });
      const load = React.useCallback(() => {
        if (!enabled) {
          setState({ key, loading: false, rows: [], totals: null, error: null });
          return undefined;
        }
        let cancelled = false;
        setState({ key, loading: true, rows: [], totals: null, error: null });
        Promise.resolve()
          .then(() => fetchBreakdown(level))
          .then((json) => {
            if (cancelled) return;
            setState({
              key,
              loading: false,
              rows: json && Array.isArray(json.rows) ? json.rows : [],
              totals: (json && json.totals) || null,
              error: null,
            });
          })
          .catch((error) => {
            if (cancelled) return;
            setState({ key, loading: false, rows: [], totals: null, error: String(error && error.message ? error.message : error) });
          });
        return () => {
          cancelled = true;
        };
      }, [enabled, key]);
      React.useEffect(() => {
        const cleanup = load();
        return () => {
          if (typeof cleanup === 'function') cleanup();
        };
      }, [load, revision]);
      // A level switch must never render the previous level's rows.
      if (state.key !== key) return [{ key, loading: enabled, rows: [], totals: null, error: null }, load];
      return [state, load];
    }

    /** Root rows come from the summary payload; missing arrays read as empty. */
    function rootBreakdownRows(data, dimension) {
      const field = BREAKDOWN_FIELD[dimension];
      const rows = data ? data[field] : null;
      return Array.isArray(rows) ? rows : [];
    }

    /** True only when the host payload carries the v3 breakdown fields. */
    function hasBreakdown(data) {
      if (!data || typeof data !== 'object') return false;
      return Array.isArray(data.projects) || Array.isArray(data.sessions) || Array.isArray(data.turns);
    }

    function totalsOfRows(rows) {
      const totals = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
      for (const row of rows || []) {
        for (const key of Object.keys(totals)) {
          if (typeof row[key] === 'number' && Number.isFinite(row[key])) totals[key] += row[key];
        }
      }
      return totals;
    }

    /** Totals for the current level: host totals when fetched, else local sums.
     *  Only the complete project list may reuse the all-time totals; the
     *  summary's session/turn arrays are top-N, so they sum locally. */
    function breakdownTotals(level, data, rows, fetchedTotals) {
      if (fetchedTotals) return fetchedTotals;
      if (level.root && level.by === 'project') {
        const allTime = data && data.allTime;
        if (allTime && typeof allTime.total === 'number') {
          return {
            requests: typeof data.requestCount === 'number' ? data.requestCount : null,
            input: allTime.input,
            cacheRead: allTime.cacheRead,
            cacheWrite: allTime.cacheWrite,
            output: allTime.output,
            total: allTime.total,
          };
        }
      }
      return totalsOfRows(rows);
    }

    function breakdownRowKey(row, dimension) {
      if (dimension === 'project') return `p:${row.id}`;
      if (dimension === 'session') return `s:${row.id}`;
      return `t:${row.sessionId}:${row.turn}:${row.startTs}`;
    }

    function breakdownRowName(row, dimension, t) {
      if (dimension === 'project') return row.title || row.id || t('breakdown.untitled');
      if (dimension === 'session') return row.title || row.id || t('breakdown.untitledSession');
      return interpolate(t('breakdown.turnLabel'), { turn: row.turn === undefined || row.turn === null ? '—' : row.turn });
    }

    function breakdownRowSub(row, dimension, t) {
      if (dimension === 'project') {
        const count = typeof row.sessions === 'number' ? row.sessions : null;
        return count === null ? (row.id || null) : interpolate(t('breakdown.sessionCount'), { count });
      }
      if (dimension === 'session') return row.projectTitle || row.project || null;
      return row.sessionTitle || row.projectTitle || row.sessionId || null;
    }

    function BreakdownRow({ row, dimension, t, lang, onDrill }) {
      const name = breakdownRowName(row, dimension, t);
      const sub = breakdownRowSub(row, dimension, t);
      const time = rowTimeLabel(row, lang, dimension);
      const children = [
        h('span', { className: 'dst-row-name', key: 'name' },
          h('span', { className: 'dst-row-title', title: name }, name),
          sub ? h('span', { className: 'dst-row-sub', title: sub }, sub) : null),
        h('span', { className: 'dst-num dst-num-strong', key: 'total', title: formatExact(row.total) }, formatCount(row.total, lang)),
        h('span', { className: 'dst-num', key: 'cacheRead', title: formatExact(row.cacheRead) }, formatCount(row.cacheRead, lang)),
        h('span', { className: 'dst-num', key: 'input', title: formatExact(row.input) }, formatCount(row.input, lang)),
        h('span', { className: 'dst-num', key: 'output', title: formatExact(row.output) }, formatCount(row.output, lang)),
        h('span', { className: 'dst-num', key: 'requests', title: formatExact(row.requests) }, formatExact(row.requests)),
        h('span', { className: 'dst-time dst-col-time', key: 'time', title: time }, time),
      ];
      if (typeof onDrill !== 'function') return h('div', { className: 'dst-row' }, children);
      return h('button', {
        type: 'button',
        className: 'dst-row',
        'aria-label': `${name} · ${t('breakdown.col.total')} ${formatExact(row.total)}`,
        title: dimension === 'project' ? t('breakdown.drillProject') : t('breakdown.drillSession'),
        onClick: () => onDrill(row),
      }, children);
    }

    function BreakdownHead({ t }) {
      return h('div', { className: 'dst-table-head', 'aria-hidden': true },
        h('span', null, t('breakdown.col.name')),
        h('span', { className: 'dst-num' }, t('breakdown.col.total')),
        h('span', { className: 'dst-num' }, t('breakdown.col.cacheRead')),
        h('span', { className: 'dst-num' }, t('breakdown.col.input')),
        h('span', { className: 'dst-num' }, t('breakdown.col.output')),
        h('span', { className: 'dst-num' }, t('breakdown.col.requests')),
        h('span', { className: 'dst-time dst-col-time' }, t('breakdown.col.time')));
    }

    /** 项目 / 会话 / 对话 table with project -> session -> turn drill-down. */
    function BreakdownSection({ t, lang, data }) {
      const [dimension, setDimension] = React.useState('project');
      const [stack, setStack] = React.useState([]);
      const level = stack.length > 0 ? stack[stack.length - 1] : { by: dimension, root: true };
      const revision = data ? data.now : null;
      const [fetched, reload] = useBreakdown(level, !level.root, revision);
      const rows = level.root ? rootBreakdownRows(data, dimension) : fetched.rows;
      const totals = breakdownTotals(level, data, rows, level.root ? null : fetched.totals);

      const pickDimension = (id) => {
        setDimension(id);
        setStack([]);
      };
      const drill = (row) => {
        if (level.by === 'project') {
          setStack([...stack, { by: 'session', project: row.id, label: breakdownRowName(row, 'project', t) }]);
        } else if (level.by === 'session') {
          setStack([...stack, { by: 'turn', session: row.id, label: breakdownRowName(row, 'session', t) }]);
        }
      };
      const back = () => setStack(stack.slice(0, -1));
      const goTo = (depth) => setStack(stack.slice(0, depth));

      const crumbs = [];
      if (stack.length > 0) {
        crumbs.push(h('span', { key: 'back', className: 'dst-crumbs-back' },
          h('button', { type: 'button', className: 'dst-btn', onClick: back }, t('breakdown.back'))));
        crumbs.push(h('button', {
          key: 'root',
          type: 'button',
          className: 'dst-crumb-link',
          onClick: () => goTo(0),
        }, t('breakdown.root')));
        stack.forEach((frame, index) => {
          crumbs.push(h('span', { key: `sep${index}`, className: 'dst-crumb-sep', 'aria-hidden': true }, '/'));
          if (index === stack.length - 1) {
            crumbs.push(h('span', { key: `crumb${index}`, className: 'dst-crumb-current', title: frame.label }, frame.label));
          } else {
            crumbs.push(h('button', {
              key: `crumb${index}`,
              type: 'button',
              className: 'dst-crumb-link',
              title: frame.label,
              onClick: () => goTo(index + 1),
            }, frame.label));
          }
        });
      }

      const body = (() => {
        if (!level.root && fetched.loading && rows.length === 0) {
          return h('div', { className: 'dst-table', 'aria-busy': true, 'aria-label': t('breakdown.loading') },
            h('div', { className: 'dst-stat-label' }, t('breakdown.loading')),
            [0, 1, 2].map((index) => h('div', { className: 'dst-row-skel', key: `skel${index}` })));
        }
        if (!level.root && fetched.error) {
          return h('div', { className: 'dst-empty' },
            h('div', { className: 'dst-empty-title' }, t('breakdown.error')),
            h('div', null, fetched.error),
            h('button', { type: 'button', className: 'dst-btn', style: { marginTop: '10px' }, onClick: reload }, t('breakdown.retry')));
        }
        if (rows.length === 0) {
          return h('div', { className: 'dst-empty' },
            h('div', { className: 'dst-empty-title' }, t('breakdown.empty')),
            h('div', null, t('breakdown.emptyHint')));
        }
        const canDrill = level.by !== 'turn';
        return h('div', { className: 'dst-table' },
          h(BreakdownHead, { t }),
          rows.map((row) => h(BreakdownRow, {
            key: breakdownRowKey(row, level.by),
            row,
            dimension: level.by,
            t,
            lang,
            onDrill: canDrill ? drill : null,
          })));
      })();

      const note = level.root && dimension !== 'project' && rows.length > 0
        ? interpolate(t('breakdown.topN'), { count: rows.length })
        : (!level.root && rows.length >= BREAKDOWN_LIMIT ? interpolate(t('breakdown.topN'), { count: rows.length }) : null);

      return h('div', { className: 'dst-section' },
        h('div', { className: 'dst-section-head' },
          h('div', { className: 'dst-section-title' }, t('breakdown.title')),
          h(Segmented, {
            label: t('breakdown.tabs'),
            active: dimension,
            onSelect: pickDimension,
            options: [
              { id: 'project', label: t('breakdown.tab.project') },
              { id: 'session', label: t('breakdown.tab.session') },
              { id: 'turn', label: t('breakdown.tab.turn') },
            ],
          })),
        crumbs.length > 0 ? h('div', { className: 'dst-crumbs' }, crumbs) : null,
        body,
        rows.length > 0
          ? h('div', { className: 'dst-breakdown-foot' },
              h('span', null, interpolate(t('breakdown.totals'), {
                total: formatCount(totals && totals.total, lang),
                requests: formatExact(totals && totals.requests),
              })),
              note ? h('span', { className: 'dst-breakdown-note' }, note) : null)
          : null);
    }

    /** The full dashboard page (registered as a `main` panel). */
    function UsageDashboard({ t, lang, ctx }) {
      const [state, load] = useSummary(REFRESH_MS);
      const { data } = state;
      const back = () => {
        try {
          if (ctx.layout && typeof ctx.layout.selectPanel === 'function') ctx.layout.selectPanel(null);
        } catch (error) {
          console.warn('token-usage-stats: selectPanel(null) failed', error);
        }
      };
      return h('div', { className: 'dst-page' },
        h('div', { className: 'dst-page-inner' },
          h('div', { className: 'dst-page-head' },
            h('h1', { className: 'dst-page-title' }, t('page.title')),
            h('span', { className: 'dst-page-badge' }, t('page.badge')),
            h('span', { className: 'dst-spacer' }),
            data && data.persisted === false ? h('span', { className: 'dst-badge' }, t('state.memoryOnly')) : null,
            state.error ? h('span', { className: 'dst-error' }, state.error) : null,
            h('button', { type: 'button', className: 'dst-btn', onClick: load, disabled: state.loading }, t('action.refresh')),
            h('button', { type: 'button', className: 'dst-btn', onClick: back }, t('action.back'))),
          !data && !state.error ? h('div', { className: 'dst-stat-label' }, t('state.loading')) : null,
          data ? h(React.Fragment, null,
            h(Cards, { t, lang, stats: data.stats, allTime: data.allTime }),
            h('div', { className: 'dst-section' },
              h(TrendChart, { t, lang, rows: data.trend })),
            h('div', { className: 'dst-section' },
              h('div', { className: 'dst-section-head' },
                h('div', { className: 'dst-section-title' }, t('models.title'))),
              h(ModelUsage, { t, lang, models: data.models })),
            hasBreakdown(data) ? h(BreakdownSection, { t, lang, data }) : null,
            h('div', { className: 'dst-foot' }, interpolate(t('footer.hint'), { tz: data.timeZone || 'local' })))
          : null));
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ensureStyle();
        const t = createT(ctx);
        const lang = languageOf(ctx);
        ctx.slots.inject('shell.bottom', () => ctx.slots.register({
          name: 'shell.bottom',
          id: 'token-usage-stats-bar',
          order: 10,
        }, () => h(UsageBar, { t, lang, ctx })));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, () => h(UsageDashboard, { t, lang, ctx })));
      },
    };
  },
});

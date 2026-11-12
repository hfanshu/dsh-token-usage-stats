/**
 * dsh-token-usage-stats — Client half of the bundle (v3 breakdown edition).
 *
 * Generation note: package.json exports "./client" -> "./client.v8.js", an
 * identical served copy. The export PATH is the browser module identity, so
 * bumping it (client.v8.js -> client.v9.js, …) is how a changed client picks
 * up a fresh module generation without an app restart. After editing this
 * file, copy it over the current served generation and update the export.
 *
 * Three surfaces, one data source (the Host's same-origin /api/token-stats):
 *   1. A slim always-visible strip in the root `shell.bottom` slot with
 *      today / week / month totals and a button that opens the dashboard.
 *   2. A full "使用统计" dashboard registered as a global `main` panel
 *      (key `token-usage-stats`): summary cards, a GitHub-style token
 *      activity heatmap with 每日/每周/累计 modes, a 7/30-day trend chart,
 *      a 12-month token bar chart (aggregated from the heatmap window),
 *      a per-model usage breakdown, a 工作空间活跃分布 ranking (workspaces or
 *      sessions, tokens or session counts, search + 2X, 30-day daily strip),
 *      four analytics charts (day x hour heat grid, 0–24h by model, daily
 *      model mix, request-size percentiles), and a 项目/会话/对话 breakdown with
 *      drill-down (project -> sessions -> turns) plus breadcrumb navigation;
 *      the breakdown and session-turn lists paginate client-side, 10 per page.
 *   3. A "用量" conversation-view tab in the session tab strip, immediately
 *      after 轨迹 / trajectory: cards and a per-turn table for the open
 *      session only. It reuses the breakdown route
 *      (`by=turn&session=<id>`), so no new Host route (and no Host restart)
 *      is involved.
 *
 * All data arrives over HTTP; the browser never touches storage or session
 * logs. Styling inherits the host theme through --dsw-alias-* tokens.
 */
window.__ModuleLoader__.load({
  // Must equal the package.json `name`: the Host keys the boot-graph row by the
  // package name, and a bundle that registers under any other id is never
  // associated with its row (the module simply never arrives).
  id: '@h643560027/dsh-token-usage-stats',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'dsh-token-usage-stats';
    const ROUTE = '/api/token-stats';
    const BREAKDOWN_ROUTE = '/api/token-stats/breakdown';
    const ACTIVITY_ROUTE = '/api/token-stats/activity';
    const INSIGHTS_ROUTE = '/api/token-stats/insights';
    const REFRESH_MS = 30000;
    const PANEL_ID = 'token-usage-stats';
    // Session tab: `conversation.view` orders are chat=0, trajectory=10,
    // context=20, fleet=30, savings=40 — 15 sits right after 轨迹.
    const SESSION_TAB_ID = 'token-usage-stats-session';
    const SESSION_TAB_ORDER = 15;
    // One session is normally a few dozen turns; the route caps at 500 and
    // returns whole-session totals regardless of the row limit.
    const SESSION_TURNS_LIMIT = 200;
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
        'months.title': '每月 Token 用量',
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
        'pager.prev': '上一页',
        'pager.next': '下一页',
        'pager.info': '第 {{page}} / {{pages}} 页',
        'pager.rows': '共 {{count}} 条',
        'breakdown.drillProject': '查看该项目的会话',
        'breakdown.drillSession': '查看该会话的对话',
        'footer.hint': '统计自插件激活起累计 · 本地时区 {{tz}} · 每 30 秒自动刷新',
        'tab.session': '用量',
        'session.title': '本会话 Token 用量',
        'session.badge': '仅当前会话',
        'session.openPanel': '统计面板',
        'session.meta.project': '项目',
        'session.meta.session': '会话',
        'session.card.total': '累计 Token',
        'session.card.input': '未命中输入',
        'session.card.cacheRead': '命中缓存',
        'session.card.cacheWrite': '缓存写入',
        'session.card.output': '输出',
        'session.card.requests': '计费请求',
        'session.card.turns': '对话轮数',
        'session.loading': '正在读取本会话用量…',
        'session.error': '本会话用量加载失败',
        'session.retry': '重试',
        'session.empty': '本会话还没有用量记录',
        'session.emptyHint': '在本会话中发起一次对话后，这里会汇总它每一次计费请求的 token。',
        'session.turns.title': '逐轮明细',
        'session.col.turn': '对话',
        'session.col.total': '总 Token',
        'session.col.cacheRead': '命中缓存',
        'session.col.input': '未命中输入',
        'session.col.output': '输出',
        'session.col.requests': '请求',
        'session.turnLabel': '#{{turn}}',
        'session.topN': '仅展示最近 {{count}} 轮',
        'session.footer': '只统计当前会话 · 每 30 秒自动刷新',
        'activity.title': '工作空间活跃分布',
        'activity.byWorkspace': '按工作空间',
        'activity.bySession': '按会话',
        'activity.metricToken': '按 Token',
        'activity.metricSessions': '按会话数',
        'activity.metricRequests': '按请求数',
        'activity.search': '搜索…',
        'activity.sessions': '{{count}} 会话',
        'activity.requests': '{{count}} 请求',
        'activity.zoom': '2X',
        'activity.zoomHint': '放大活跃条',
        'activity.window': '近 30 天',
        'activity.loading': '活跃数据加载中…',
        'activity.error': '活跃数据加载失败',
        'activity.retry': '重试',
        'activity.empty': '窗口期内没有活跃记录',
        'activity.emptyHint': '最近 30 天的按日 Token 用量会显示在这里。',
        'activity.noMatch': '没有匹配的名称',
        'activity.noMatchHint': '换个关键词再试试。',
        'activity.truncated': '仅展示前 {{count}} 个会话',
        'activity.footer': '合计 {{total}} · {{days}} 天窗口',
        'insights.loading': '图表加载中…',
        'insights.error': '图表加载失败',
        'insights.retry': '重试',
        'insights.title': '用量分析',
        'insights.tab.hourly': '日活分布',
        'insights.tab.modelHour': '0–24 时 · 按模型',
        'insights.tab.dailyModel': '每日模型用量',
        'insights.tab.sizes': '请求大小分布',
        'hourly.title': '日活分布',
        'hourly.window': '近 14 天',
        'hourly.low': '低',
        'hourly.high': '高',
        'hourly.hourTick': '{{hour}}时',
        'bucket.night': '凌晨',
        'bucket.morning': '上午',
        'bucket.afternoon': '下午',
        'bucket.evening': '晚间',
        'modelHour.title': '0–24 时分布 · 按模型',
        'dailyModel.title': '每日模型用量比例',
        'dailyModel.other': '其他',
        'sizes.title': '单次请求大小分布',
        'sizes.model': '模型',
        'sizes.count': '次数',
        'sizes.p50': '50%',
        'sizes.p90': '90%',
        'sizes.total': 'TOP {{models}} 模型 · 共 {{count}} 次',
        'sizes.note': '每行独立分布（各自归一化）；竖线 = 50%，圆点 = 90%',
        'sizes.empty': '暂无请求样本',
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
        'months.title': 'Monthly token usage',
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
        'pager.prev': 'Previous',
        'pager.next': 'Next',
        'pager.info': 'Page {{page}} of {{pages}}',
        'pager.rows': '{{count}} rows',
        'breakdown.drillProject': 'View this project’s sessions',
        'breakdown.drillSession': 'View this session’s turns',
        'footer.hint': 'Counted since activation · timezone {{tz}} · refreshes every 30s',
        'tab.session': 'Usage',
        'session.title': 'This session’s token usage',
        'session.badge': 'This session only',
        'session.openPanel': 'Dashboard',
        'session.meta.project': 'Project',
        'session.meta.session': 'Session',
        'session.card.total': 'Total tokens',
        'session.card.input': 'Uncached input',
        'session.card.cacheRead': 'Cached input',
        'session.card.cacheWrite': 'Cache write',
        'session.card.output': 'Output',
        'session.card.requests': 'Billed calls',
        'session.card.turns': 'Turns',
        'session.loading': 'Loading this session’s usage…',
        'session.error': 'Failed to load this session’s usage',
        'session.retry': 'Retry',
        'session.empty': 'No usage recorded for this session yet',
        'session.emptyHint': 'Run a turn in this session and every billed request is summed here.',
        'session.turns.title': 'Per-turn detail',
        'session.col.turn': 'Turn',
        'session.col.total': 'Total tokens',
        'session.col.cacheRead': 'Cached input',
        'session.col.input': 'Uncached input',
        'session.col.output': 'Output',
        'session.col.requests': 'Calls',
        'session.turnLabel': '#{{turn}}',
        'session.topN': 'Latest {{count}} turns only',
        'session.footer': 'This session only · refreshes every 30s',
        'activity.title': 'Workspace activity',
        'activity.byWorkspace': 'Workspaces',
        'activity.bySession': 'Sessions',
        'activity.metricToken': 'Tokens',
        'activity.metricSessions': 'Sessions',
        'activity.metricRequests': 'Calls',
        'activity.search': 'Search…',
        'activity.sessions': '{{count}} sessions',
        'activity.requests': '{{count}} calls',
        'activity.zoom': '2X',
        'activity.zoomHint': 'Enlarge the activity bars',
        'activity.window': 'Last 30 days',
        'activity.loading': 'Loading activity…',
        'activity.error': 'Failed to load activity',
        'activity.retry': 'Retry',
        'activity.empty': 'No activity in this window',
        'activity.emptyHint': 'Daily token usage for the last 30 days appears here.',
        'activity.noMatch': 'No matching name',
        'activity.noMatchHint': 'Try a different keyword.',
        'activity.truncated': 'Top {{count}} sessions only',
        'activity.footer': 'Total {{total}} · {{days}}-day window',
        'insights.loading': 'Loading charts…',
        'insights.error': 'Failed to load charts',
        'insights.retry': 'Retry',
        'insights.title': 'Usage analytics',
        'insights.tab.hourly': 'Hourly activity',
        'insights.tab.modelHour': '0–24h by model',
        'insights.tab.dailyModel': 'Daily model mix',
        'insights.tab.sizes': 'Request size',
        'hourly.title': 'Hourly activity',
        'hourly.window': 'Last 14 days',
        'hourly.low': 'Low',
        'hourly.high': 'High',
        'hourly.hourTick': '{{hour}}h',
        'bucket.night': 'Night',
        'bucket.morning': 'Morning',
        'bucket.afternoon': 'Afternoon',
        'bucket.evening': 'Evening',
        'modelHour.title': '0–24h by model',
        'dailyModel.title': 'Daily model mix',
        'dailyModel.other': 'Other',
        'sizes.title': 'Request size distribution',
        'sizes.model': 'Model',
        'sizes.count': 'Calls',
        'sizes.p50': '50%',
        'sizes.p90': '90%',
        'sizes.total': 'Top {{models}} models · {{count}} calls',
        'sizes.note': 'Per-model distribution (each row normalized); line = 50%, dot = 90%',
        'sizes.empty': 'No request samples yet',
      },
    };

    /**
     * Resolve one dictionary entry. The inline dictionaries are flat maps whose
     * keys contain dots (`'bar.title'`), so an exact key always wins; the dotted
     * traversal stays as a fallback for genuinely nested shapes.
     */
    function lookup(dict, path) {
      if (dict !== null && typeof dict === 'object' && Object.prototype.hasOwnProperty.call(dict, path)) return dict[path];
      return path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), dict);
    }

    function interpolate(template, vars) {
      if (typeof template !== 'string') return template;
      return template.replace(/\{\{(\w+)\}\}/g, (match, name) => (vars && vars[name] !== undefined ? String(vars[name]) : match));
    }

    /**
     * Bind the plugin's translations.
     *
     * The dictionary registration is owned by an effect so an HMR teardown or a
     * plugin unload releases it. A previous generation may still own the
     * namespace (older bundles registered outside an effect), in which case
     * `register` throws "already has locale" — that is benign: the bound lookup
     * below still resolves, and the inline dictionaries cover the rest. A
     * registration failure must never take the whole bundle down with it.
     */
    function createT(ctx) {
      const register = () => {
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') return ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en });
        } catch (error) {
          console.warn('token-usage-stats: locale registration skipped', error);
        }
        return undefined;
      };
      try {
        if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-token-usage-stats: dictionaries');
        else register();
      } catch (error) {
        console.warn('token-usage-stats: locale registration effect failed', error);
      }

      const dict = languageOf(ctx) === 'zh' ? DICT.zh : DICT.en;
      const localize = (key) => {
        const value = lookup(dict, key);
        return typeof value === 'string' ? value : key;
      };

      try {
        if (ctx.locale && typeof ctx.locale.bind === 'function') {
          const bound = ctx.locale.bind(NS);
          if (typeof bound === 'function') {
            return (key, vars) => {
              const value = bound(key);
              // The locale service returns the key itself when the namespace (or
              // that key) is unknown: treat an identical string as a miss.
              return interpolate(typeof value === 'string' && value !== key ? value : localize(key), vars);
            };
          }
        }
      } catch (error) {
        console.warn('token-usage-stats: locale bind failed', error);
      }
      return (key, vars) => interpolate(localize(key), vars);
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

    const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    /** Tooltip date label: 2026年10月19日 / Oct 19, 2026. */
    function formatDateLabel(dateKey, lang) {
      const [year, month, day] = dateKey.split('-').map(Number);
      if (lang === 'zh') return `${year}年${month}月${day}日`;
      return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
    }

    /** Tooltip month label: 2026年11月 / Nov 2026. */
    function formatMonthLabel(monthKey, lang) {
      const [year, month] = monthKey.split('-').map(Number);
      if (lang === 'zh') return `${year}年${month}月`;
      return `${MONTH_NAMES[month - 1]} ${year}`;
    }

    /** Axis tick for one month key: 11月 / Nov. */
    function monthTickLabel(monthKey, lang) {
      const month = Number(monthKey.slice(5, 7));
      return lang === 'zh' ? `${month}月` : MONTH_NAMES[month - 1];
    }

    /**
     * Aggregate the host's zero-filled 365-day `heatmap` window into the last
     * MONTHS_SHOWN calendar months (ascending, zero-filled), one bar per month
     * for the monthly chart. The last heatmap date anchors "now", so the
     * window stays consistent with the host's local days.
     */
    const MONTHS_SHOWN = 12;

    function monthRowsOf(dayRows) {
      const buckets = new Map();
      let anchor = null;
      for (const row of dayRows || []) {
        if (typeof row.date !== 'string' || row.date.length < 7) continue;
        anchor = row.date;
        const month = row.date.slice(0, 7);
        const bucket = buckets.get(month) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, settlements: 0 };
        bucket.input += row.input || 0;
        bucket.output += row.output || 0;
        bucket.cacheRead += row.cacheRead || 0;
        bucket.cacheWrite += row.cacheWrite || 0;
        bucket.settlements += row.settlements || 0;
        buckets.set(month, bucket);
      }
      if (anchor === null) return [];
      const anchorYear = Number(anchor.slice(0, 4));
      const anchorMonth = Number(anchor.slice(5, 7));
      const rows = [];
      for (let index = MONTHS_SHOWN - 1; index >= 0; index -= 1) {
        const absolute = anchorYear * 12 + (anchorMonth - 1) - index;
        const key = `${Math.floor(absolute / 12)}-${pad2((absolute % 12) + 1)}`;
        const bucket = buckets.get(key) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, settlements: 0 };
        rows.push({ month: key, ...bucket, total: bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite });
      }
      return rows;
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
.dst-bar{display:flex;align-items:center;gap:12px;padding:5px 16px;min-height:32px;box-sizing:border-box;background:var(--dsw-alias-bg-base);border-top:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#666);font-size:12px;line-height:1.4}
.dst-title{display:inline-flex;align-items:center;gap:6px;padding:3px 10px 3px 8px;border:none;background:transparent;border-radius:var(--dsw-radius-md,6px);color:var(--dsw-alias-label-secondary,#666);font-size:12px;font-weight:600;cursor:pointer;transition:background .12s,color .12s}
.dst-title:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#333)}
.dst-title:focus-visible,.dst-btn:focus-visible,.dst-seg button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#2f7cf6);outline-offset:1px}
.dst-title svg{display:block;color:var(--dsw-alias-accent-primary,#2f7cf6)}
.dst-stat{display:inline-flex;align-items:baseline;gap:6px;white-space:nowrap;padding-left:14px;border-left:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.06))}
.dst-stat-label{color:var(--dsw-alias-label-tertiary,#999)}
.dst-stat-value{color:var(--dsw-alias-label-primary,#333);font-variant-numeric:tabular-nums;font-weight:600}
.dst-spacer{flex:1 1 auto}
.dst-badge{padding:2px 8px;border-radius:999px;background:var(--dsw-alias-state-warning-soft,rgba(210,150,0,.12));color:var(--dsw-alias-state-warning-primary,#b58105);font-size:11px}
.dst-error{color:var(--dsw-alias-state-error-primary,#e5484d);font-size:11px}
.dst-btn{padding:3px 10px;border-radius:var(--dsw-radius-md,6px);border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:11px;cursor:pointer;transition:background .12s,color .12s,border-color .12s}
.dst-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#333)}
.dst-btn[aria-expanded=true]{color:var(--dsw-alias-label-primary,#333);border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.2))}
.dst-btn:disabled{opacity:.45;cursor:default}
.dst-btn:disabled:hover{background:transparent;color:var(--dsw-alias-label-secondary,#666)}
.dst-detail{padding:8px 16px 10px;background:var(--dsw-alias-bg-base);border-top:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.06));display:flex;flex-direction:column;gap:2px;max-height:240px;overflow-y:auto}
.dst-day{display:grid;grid-template-columns:88px minmax(80px,220px) 76px;align-items:center;gap:10px;padding:2px 0}
.dst-day-date{color:var(--dsw-alias-label-tertiary,#999);font-variant-numeric:tabular-nums}
.dst-day-track{position:relative;height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));overflow:hidden}
.dst-day-fill{position:absolute;inset:0 auto 0 0;border-radius:3px;background:var(--dsw-alias-accent-primary,#2f7cf6);min-width:2px}
.dst-day-total{text-align:right;color:var(--dsw-alias-label-primary,#333);font-variant-numeric:tabular-nums;font-weight:600}
.dst-day:hover .dst-day-breakdown{display:block}
.dst-day-breakdown{display:none;grid-column:1/-1;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;padding:0 0 2px}
.dst-foot{display:flex;gap:12px;align-items:center;padding-top:4px;color:var(--dsw-alias-label-tertiary,#999);font-size:11px}
.dst-page{padding:24px 28px 40px;color:var(--dsw-alias-label-primary,#333);font-size:13px;overflow-y:auto;height:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base)}
.dst-page-inner{max-width:1040px;margin:0 auto;display:flex;flex-direction:column;gap:20px}
.dst-page-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.dst-page-title{font-size:24px;font-weight:700;letter-spacing:-.01em;margin:0;color:var(--dsw-alias-label-primary,#333)}
.dst-page-badge{padding:3px 10px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.06));border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#666);font-size:12px}
.dst-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.dst-card{padding:14px 16px;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-surface-default,var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04)));border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.06));display:flex;flex-direction:column;gap:5px;min-width:0;transition:border-color .15s,box-shadow .15s,transform .15s}
.dst-card:hover{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.12));box-shadow:0 2px 6px rgba(0,0,0,.04),0 10px 24px rgba(0,0,0,.06);transform:translateY(-1px)}
.dst-card-value{font-size:22px;font-weight:700;letter-spacing:-.01em;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#333);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dst-card-label{font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}
.dst-card-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#aaa)}
.dst-card-hero{background:var(--dsw-alias-accent-primary-soft,rgba(47,124,246,.09))}
.dst-card-hero .dst-card-value{font-size:26px}
.dst-card-hero .dst-card-label{color:var(--dsw-alias-accent-primary,#2f7cf6);font-weight:600}
.dst-card-tone-success .dst-card-value{color:var(--dsw-alias-state-success-primary,#1a7f37)}
.dst-card-tone-warning .dst-card-value{color:var(--dsw-alias-state-warning-primary,#b58105)}
.dst-section{padding:18px 20px;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-surface-default,var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04)));border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.06));display:flex;flex-direction:column;gap:12px}
.dst-section-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.dst-section-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#333)}
.dst-seg{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.06));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04));margin-left:auto}
.dst-seg button{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:12px;padding:3px 12px;border-radius:var(--dsw-radius-sm,6px);cursor:pointer;transition:background .12s,color .12s}
.dst-seg button:hover{color:var(--dsw-alias-label-primary,#333)}
.dst-seg button[aria-pressed=true]{background:var(--dsw-alias-surface-raised,#fff);color:var(--dsw-alias-label-primary,#333);box-shadow:0 1px 3px rgba(0,0,0,.1)}
.dst-empty{padding:32px 16px;text-align:center;color:var(--dsw-alias-label-tertiary,#999);border:1px dashed var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:var(--dsw-radius-md,8px)}
.dst-empty-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#666);margin-bottom:4px}
.dst-chart-wrap{position:relative;width:100%}
.dst-chart{width:100%;height:auto;display:block}
.dst-chart-tip{position:absolute;top:4px;z-index:2;pointer-events:none;padding:8px 12px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-surface-raised,rgba(255,255,255,.98));border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));box-shadow:0 2px 6px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.14);color:var(--dsw-alias-label-primary,#333);font-size:12px;line-height:1.5;white-space:nowrap}
.dst-chart-tip-date{color:var(--dsw-alias-label-tertiary,#999);font-size:11px}
.dst-chart-tip-total{font-weight:600;font-variant-numeric:tabular-nums}
.dst-chart-tip-sub{color:var(--dsw-alias-label-tertiary,#999);font-size:11px}
.dst-models{display:flex;flex-direction:column;gap:12px}
.dst-model{display:grid;grid-template-columns:minmax(120px,220px) 1fr 88px;gap:12px;align-items:center}
.dst-model-name{font-size:12px;color:var(--dsw-alias-label-secondary,#666);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-model-track{position:relative;height:8px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));overflow:hidden}
.dst-model-fill{position:absolute;inset:0 auto 0 0;border-radius:4px;background:var(--dsw-alias-accent-primary,#2f7cf6);min-width:2px}
.dst-model-total{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#333);font-weight:600}
.dst-model-sub{grid-column:1/-1;font-size:11px;color:var(--dsw-alias-label-tertiary,#999);margin-top:-6px}
.dst-activity-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto;min-width:0}
.dst-activity-tools .dst-seg{margin-left:0}
.dst-activity-search{width:150px;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#333);font:inherit;font-size:12px}
.dst-activity-search::placeholder{color:var(--dsw-alias-label-tertiary,#999)}
.dst-activity-search:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#2f7cf6);outline-offset:1px}
.dst-activity-list{display:flex;flex-direction:column;gap:2px;max-height:380px;overflow-y:auto;min-width:0;padding-right:4px}
.dst-activity-row{display:grid;grid-template-columns:minmax(110px,1.5fr) minmax(70px,100px) minmax(96px,130px) minmax(160px,2.2fr);gap:12px;align-items:center;padding:5px 8px;border-radius:var(--dsw-radius-sm,6px);min-width:0}
.dst-activity-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dst-activity-name{display:flex;flex-direction:column;gap:1px;min-width:0}
.dst-activity-value{text-align:right;font-variant-numeric:tabular-nums;font-weight:600;color:var(--dsw-alias-label-primary,#333);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-activity-meta{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-activity-spark{display:flex;align-items:stretch;gap:2px;height:14px;min-width:0}
.dst-activity-spark.is-2x{height:26px}
.dst-spark-cell{flex:1 1 0;min-width:1px;border-radius:2px;background:var(--dsw-alias-accent-primary,#2f7cf6);opacity:.08}
.dst-activity-empty{padding:18px 8px;text-align:center;color:var(--dsw-alias-label-tertiary,#999);font-size:12px}
.dst-activity-empty-title{color:var(--dsw-alias-label-secondary,#666);margin-bottom:4px}
.dst-legend{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;min-width:0}
.dst-legend-label{white-space:nowrap}
.dst-legend-swatch{width:12px;height:8px;border-radius:2px;background:var(--dsw-alias-accent-primary,#2f7cf6);display:inline-block}
.dst-legend-item{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;max-width:220px;overflow:hidden}
.dst-legend-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
.dst-legend-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-legend-value{color:var(--dsw-alias-label-secondary,#666);font-variant-numeric:tabular-nums}
.dst-note{color:var(--dsw-alias-label-tertiary,#999);font-size:11px}
.dst-buckets{display:flex;gap:10px;flex-wrap:wrap}
.dst-bucket{flex:1 1 150px;display:flex;align-items:baseline;gap:10px;padding:2px 4px;min-width:0}
.dst-bucket-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap}
.dst-bucket-share{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#333);font-variant-numeric:tabular-nums;margin-left:auto}
.dst-hourgrid{display:flex;flex-direction:column;gap:2px;min-width:0;overflow-x:auto}
.dst-hourgrid-row{display:grid;grid-template-columns:44px repeat(24,minmax(12px,1fr));gap:2px;align-items:center;min-width:520px}
.dst-hourgrid-head{color:var(--dsw-alias-label-tertiary,#999);font-size:10px}
.dst-hourgrid-hour{text-align:center}
.dst-hourgrid-day{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);font-variant-numeric:tabular-nums}
.dst-hourgrid-cell{height:14px;border-radius:2px;background:var(--dsw-alias-accent-primary,#2f7cf6);opacity:.07;min-width:8px}
.dst-area-chart{width:100%;height:auto;display:block;overflow:visible}
.dst-chart-axis{stroke:var(--dsw-alias-border-l2,rgba(0,0,0,.12));stroke-width:1}
.dst-chart-axis-text{fill:var(--dsw-alias-label-tertiary,#999);font-size:10px;font-variant-numeric:tabular-nums}
.dst-dailymix{display:flex;flex-direction:column;gap:4px;min-width:0}
.dst-dailymix-bars{display:flex;align-items:flex-end;gap:3px;height:150px;padding:0 2px}
.dst-dailymix-col{flex:1 1 0;min-width:2px;height:100%;display:flex;align-items:flex-end}
.dst-dailymix-stack{width:100%;display:flex;flex-direction:column-reverse;border-radius:2px 2px 0 0;overflow:hidden}
.dst-dailymix-seg{display:block;width:100%;min-height:1px}
.dst-dailymix-axis{display:flex;color:var(--dsw-alias-label-tertiary,#999);font-size:10px}
.dst-dailymix-tick{flex:1 1 0;min-width:0;text-align:center;white-space:nowrap;overflow:hidden}
.dst-sizes{display:flex;flex-direction:column;gap:2px;min-width:0}
.dst-size-row{display:grid;grid-template-columns:minmax(120px,1.2fr) 70px 76px 76px minmax(180px,2fr);gap:10px;align-items:center;padding:4px 8px;border-radius:var(--dsw-radius-sm,6px);min-width:0}
.dst-size-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dst-size-row-head{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;padding-bottom:2px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06));border-radius:0}
.dst-size-model{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#333);font-size:12px}
.dst-size-count,.dst-size-p{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#666);font-size:11px;white-space:nowrap}
.dst-size-chart{color:var(--dsw-alias-accent-primary,#2f7cf6);min-width:0}
.dst-size-chart svg{width:100%;height:38px;display:block}
.dst-size-area{fill:currentColor;opacity:.3}
.dst-size-line{stroke:currentColor;stroke-width:.8;opacity:.55}
.dst-size-dot{fill:currentColor}
.dst-sizes-axis{display:flex;justify-content:space-between;padding:0 8px;color:var(--dsw-alias-label-tertiary,#999);font-size:10px;font-variant-numeric:tabular-nums}
.dst-insights{min-height:240px}
.dst-insights .dst-seg{margin-left:0;flex-wrap:wrap}
.dst-insights .dst-seg button{white-space:nowrap}
.dst-chart-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-width:0}
.dst-chart-toolbar.dst-end{justify-content:flex-end}
.dst-crumbs{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}
.dst-crumbs-back{display:inline-flex}
.dst-crumb-link{padding:2px 8px;border:none;border-radius:var(--dsw-radius-sm,4px);background:transparent;color:var(--dsw-alias-label-secondary,#666);font:inherit;font-size:12px;cursor:pointer;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:background .12s,color .12s}
.dst-crumb-link:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#333)}
.dst-crumb-link:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#2f7cf6);outline-offset:1px}
.dst-crumb-sep{opacity:.55}
.dst-crumb-current{color:var(--dsw-alias-label-primary,#333);font-weight:600;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-table{display:flex;flex-direction:column;gap:2px;min-width:0;overflow-x:auto;container-type:inline-size}
.dst-table-head,.dst-row{display:grid;grid-template-columns:minmax(120px,1.6fr) minmax(68px,92px) minmax(80px,104px) minmax(80px,104px) minmax(56px,88px) minmax(46px,68px) minmax(104px,1.3fr);gap:10px;align-items:center;min-width:0}
.dst-table-head{padding:0 8px 6px;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06))}
.dst-table-head span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-table-head .dst-num{text-align:right}
.dst-row{padding:6px 8px;border-radius:var(--dsw-radius-sm,6px);border:none;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:default;min-width:0;transition:background .12s}
button.dst-row{cursor:pointer}
button.dst-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
button.dst-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#2f7cf6);outline-offset:-1px}
.dst-row-name{display:flex;flex-direction:column;gap:1px;min-width:0}
.dst-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#333)}
.dst-row-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-row .dst-num{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#666);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-row .dst-num-strong{color:var(--dsw-alias-label-primary,#333);font-weight:600}
.dst-row .dst-num-cache{color:var(--dsw-alias-state-success-primary,#1a7f37)}
.dst-row .dst-time{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-row-skel{height:32px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));animation:dst-skel 1.5s ease-in-out infinite}
@keyframes dst-skel{0%,100%{opacity:.6}50%{opacity:.25}}
.dst-breakdown-foot{display:flex;align-items:center;gap:12px;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;flex-wrap:wrap}
.dst-breakdown-note{color:var(--dsw-alias-label-tertiary,#999)}
.dst-pager{display:flex;align-items:center;gap:6px;margin-left:auto}
.dst-pager-info{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dst-session-meta{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--dsw-alias-label-tertiary,#999);font-size:12px}
.dst-session-meta b{color:var(--dsw-alias-label-primary,#333);font-weight:600}
.dst-table.dst-session-table .dst-table-head,.dst-table.dst-session-table .dst-row{grid-template-columns:minmax(132px,1.7fr) repeat(5,minmax(58px,88px))}
@container (max-width:640px){.dst-table-head,.dst-row{grid-template-columns:minmax(96px,1.4fr) minmax(56px,84px) minmax(72px,92px) minmax(72px,92px) minmax(48px,80px) minmax(40px,60px)}.dst-col-time{display:none}}
@media (prefers-reduced-motion:reduce){.dst-card,.dst-btn,.dst-title,.dst-seg button,.dst-row,.dst-crumb-link{transition:none}.dst-row-skel{animation:none}}
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

    /**
     * Client-side pager: 上一页 / 第 n / m 页 / 下一页. Rendered only when the
     * list actually spans pages; `page` is already clamped by the caller.
     */
    function Pager({ t, page, pages, onPage }) {
      return h('div', { className: 'dst-pager' },
        h('button', {
          type: 'button',
          className: 'dst-btn',
          disabled: page <= 1,
          'aria-label': t('pager.prev'),
          onClick: () => onPage(page - 1),
        }, t('pager.prev')),
        h('span', { className: 'dst-pager-info' }, interpolate(t('pager.info'), { page, pages })),
        h('button', {
          type: 'button',
          className: 'dst-btn',
          disabled: page >= pages,
          'aria-label': t('pager.next'),
          onClick: () => onPage(page + 1),
        }, t('pager.next')));
    }

    /** 1-based clamped page for a row count. */
    function clampedPage(page, rows) {
      const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      return { pages, page: Math.min(page, pages) };
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
      const card = (value, labelKey, sub, extra) => h('div', { className: extra ? `dst-card ${extra}` : 'dst-card' },
        h('div', { className: 'dst-card-value' }, value),
        h('div', { className: 'dst-card-label' }, t(labelKey)),
        sub ? h('div', { className: 'dst-card-sub' }, sub) : null);
      return h('div', { className: 'dst-cards' },
        card(formatCount(allTime && allTime.total, lang), 'card.total', null, 'dst-card-hero'),
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
          h('defs', null,
            h('linearGradient', { id: 'dst-trend-fill', x1: 0, y1: 0, x2: 0, y2: 1 },
              h('stop', { offset: '0%', 'stop-color': 'var(--dsw-alias-accent-primary,#2f7cf6)', 'stop-opacity': '.24' }),
              h('stop', { offset: '100%', 'stop-color': 'var(--dsw-alias-accent-primary,#2f7cf6)', 'stop-opacity': '.02' }))),
          ticks.map((tick, index) => h('g', { key: `t${index}` },
            h('line', { x1: pad.left, x2: width - pad.right, y1: y(tick), y2: y(tick), stroke: index === 0 ? 'var(--dsw-alias-border-l2,rgba(0,0,0,.08))' : 'var(--dsw-alias-border-subtle,rgba(0,0,0,.06))', 'stroke-dasharray': index === 0 ? '' : '3 3' }),
            h('text', { x: pad.left - 6, y: y(tick) + 4, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--dsw-alias-label-tertiary,#999)' }, formatCount(Math.round(tick), lang)))),
          h('path', { d: area, fill: 'url(#dst-trend-fill)' }),
          h('path', { d: line, fill: 'none', stroke: 'var(--dsw-alias-accent-primary,#2f7cf6)', 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
          rows.map((row, index) => row.total > 0
            ? h('circle', {
                key: row.date,
                cx: x(index),
                cy: y(row.total),
                r: index === clampedHover ? (rows.length <= 7 ? 4.5 : 3.5) : (rows.length <= 7 ? 3 : 2),
                // Ringed dots read as measurements; the hovered one inverts
                // to a solid accent with a surface-colored ring.
                fill: index === clampedHover ? 'var(--dsw-alias-accent-primary,#2f7cf6)' : 'var(--dsw-alias-bg-base,#fff)',
                stroke: 'var(--dsw-alias-accent-primary,#2f7cf6)',
                'stroke-width': 1.5,
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

    /** Monthly token bar chart over the aggregated heatmap window. */
    function MonthlyChart({ t, lang, days }) {
      const [hover, setHover] = React.useState(null);
      const rows = monthRowsOf(days);
      const hasData = rows.some((row) => row.total > 0);
      if (!Array.isArray(days)) return null;
      return h('div', null,
        h('div', { className: 'dst-section-head' },
          h('div', { className: 'dst-section-title' }, t('months.title'))),
        hasData
          ? monthlyChartBody(rows, hover, setHover, t, lang)
          : h('div', { className: 'dst-empty' },
              h('div', { className: 'dst-empty-title' }, t('trend.empty')),
              h('div', null, t('trend.emptyHint'))));
    }

    function monthlyChartBody(rows, hover, setHover, t, lang) {
      const width = 640;
      const height = 220;
      const pad = { left: 56, right: 12, top: 16, bottom: 26 };
      const chartW = width - pad.left - pad.right;
      const chartH = height - pad.top - pad.bottom;
      const max = Math.max(1, ...rows.map((row) => row.total));
      const band = chartW / rows.length;
      const barW = Math.min(40, band * 0.55);
      const y = (value) => pad.top + chartH - (value / max) * chartH;
      const ticks = [0, max / 2, max];
      const clampedHover = hover === null ? null : Math.max(0, Math.min(rows.length - 1, hover));
      const hoveredRow = clampedHover === null ? null : rows[clampedHover];
      // Rounded-top bar; the radius yields to short bars instead of inverting.
      const barPath = (index, row) => {
        const barH = (row.total / max) * chartH;
        if (barH <= 0) return null;
        const x0 = pad.left + index * band + (band - barW) / 2;
        const y0 = pad.top + chartH - barH;
        const base = pad.top + chartH;
        const r = Math.min(4, barW / 2, barH);
        return `M${x0},${y0 + r} a${r},${r} 0 0 1 ${r},-${r} L${x0 + barW - r},${y0} a${r},${r} 0 0 1 ${r},${r} L${x0 + barW},${base} L${x0},${base} Z`;
      };
      // Pointer -> month index, mirroring the trend chart's hit strip.
      const onMove = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width) return;
        const viewX = (event.clientX - rect.left) * (width / rect.width);
        const index = Math.floor((viewX - pad.left) / band);
        setHover(Math.max(0, Math.min(rows.length - 1, index)));
      };
      const barCenter = (index) => pad.left + index * band + band / 2;
      const tipPercent = clampedHover === null ? 0 : Math.min(90, Math.max(10, (barCenter(clampedHover) / width) * 100));
      const tipTransform = clampedHover === null ? 'translateX(-50%)'
        : barCenter(clampedHover) < width * 0.18 ? 'translateX(-15%)'
        : barCenter(clampedHover) > width * 0.82 ? 'translateX(-85%)'
        : 'translateX(-50%)';
      return h('div', { className: 'dst-chart-wrap' },
        h('svg', { className: 'dst-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': t('months.title') },
          ticks.map((tick, index) => h('g', { key: `t${index}` },
            h('line', { x1: pad.left, x2: width - pad.right, y1: y(tick), y2: y(tick), stroke: index === 0 ? 'var(--dsw-alias-border-l2,rgba(0,0,0,.08))' : 'var(--dsw-alias-border-subtle,rgba(0,0,0,.06))', 'stroke-dasharray': index === 0 ? '' : '3 3' }),
            h('text', { x: pad.left - 6, y: y(tick) + 4, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--dsw-alias-label-tertiary,#999)' }, formatCount(Math.round(tick), lang)))),
          rows.map((row, index) => {
            const d = barPath(index, row);
            if (d === null) return null;
            return h('path', {
              key: row.month,
              d,
              fill: 'var(--dsw-alias-accent-primary,#2f7cf6)',
              opacity: clampedHover === null || index === clampedHover ? '1' : '.5',
            });
          }),
          rows.map((row, index) => h('text', {
            key: `x${index}`,
            x: barCenter(index),
            y: height - 8,
            'text-anchor': 'middle',
            'font-size': 10,
            fill: index === clampedHover ? 'var(--dsw-alias-label-secondary,#666)' : 'var(--dsw-alias-label-tertiary,#999)',
          }, monthTickLabel(row.month, lang))),
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
              h('div', { className: 'dst-chart-tip-date' }, formatMonthLabel(hoveredRow.month, lang)),
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

    // ---- workspace activity distribution -------------------------------------
    // The Host serves the ranked workspaces/sessions with a zero-filled daily
    // token series; this section renders the ranking, the share and the strip.
    const ACTIVITY_REFRESH_MS = 60000;

    /** Fetch the activity distribution; throws on non-2xx. */
    function fetchActivity() {
      return fetch(ACTIVITY_ROUTE, { credentials: 'same-origin', headers: { accept: 'application/json' } }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
    }

    /** Shared load-into-state effect for the activity route. */
    function useActivity(refreshMs) {
      const [state, setState] = React.useState({ loading: true, data: null, error: null });
      const load = React.useCallback(() => {
        let cancelled = false;
        setState((previous) => ({ ...previous, loading: true }));
        Promise.resolve()
          .then(fetchActivity)
          .then((json) => {
            if (!cancelled) setState({ loading: false, data: json, error: null });
          })
          .catch((error) => {
            if (!cancelled) {
              setState((previous) => ({
                loading: false,
                data: previous.data,
                error: String(error && error.message ? error.message : error),
              }));
            }
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

    /**
     * Workspace / session activity ranking with a per-day token strip.
     * `按工作空间` ranks projects (sessions metric = session count); `按会话`
     * ranks sessions (sessions metric = billed requests, since one session is
     * one row). The strip always encodes daily tokens, so a quiet row means the
     * identity is old rather than idle.
     */
    function WorkspaceActivity({ t, lang }) {
      const [state, reload] = useActivity(ACTIVITY_REFRESH_MS);
      const [mode, setMode] = React.useState('workspace');
      const [metric, setMetric] = React.useState('token');
      const [query, setQuery] = React.useState('');
      const [zoom, setZoom] = React.useState(false);
      const data = state.data;
      const isWorkspace = mode === 'workspace';
      const effectiveMetric = metric === 'sessions' && !isWorkspace ? 'requests' : metric;
      const metricKey = effectiveMetric === 'token' ? 'total' : (isWorkspace ? 'sessions' : 'requests');
      const rawRows = data ? (isWorkspace ? data.workspaces : data.sessions) || [] : [];
      const denominator = (() => {
        if (!data) return 0;
        if (isWorkspace) return effectiveMetric === 'token' ? data.workspaceTotal : data.workspaceSessions;
        return effectiveMetric === 'token' ? data.sessionTotal : data.sessionRequests;
      })();
      const needle = query.trim().toLowerCase();
      const rows = rawRows
        .filter((row) => needle.length === 0
          || String(row.title || '').toLowerCase().includes(needle)
          || String(row.projectTitle || '').toLowerCase().includes(needle))
        .slice()
        .sort((a, b) => (b[metricKey] || 0) - (a[metricKey] || 0));
      const maxDay = rows.reduce((max, row) => {
        for (const value of row.series || []) if (value > max) max = value;
        return max;
      }, 0);
      const days = data && Array.isArray(data.days) ? data.days : [];
      // Two workspaces can share a final path segment (same folder name in two
      // parents or drives); qualify only those, with the shortest unique path
      // suffix, so the common case keeps its short name.
      const segmentsOf = (id) => String(id).split(/[\\/]+/).filter((part) => part.length > 0);
      const duplicateGroups = new Map();
      if (isWorkspace) {
        for (const row of rawRows) {
          const key = row.title || '';
          const group = duplicateGroups.get(key);
          if (group === undefined) duplicateGroups.set(key, [row]);
          else group.push(row);
        }
      }
      const nameOf = (row) => {
        const base = row.title || (isWorkspace ? t('breakdown.untitled') : t('breakdown.untitledSession'));
        const group = isWorkspace ? duplicateGroups.get(row.title || '') : undefined;
        if (group === undefined || group.length < 2) return base;
        const parts = segmentsOf(row.id);
        const others = group.filter((other) => other.id !== row.id).map((other) => segmentsOf(other.id));
        for (let length = 2; length <= parts.length; length += 1) {
          const suffix = parts.slice(-length).join('/');
          if (others.every((other) => other.slice(-length).join('/') !== suffix)) return suffix;
        }
        return parts.join('/');
      };
      const metaOf = (row) => {
        const share = denominator > 0 ? `${(((row[metricKey] || 0) / denominator) * 100).toFixed(1)}%` : '—';
        const count = isWorkspace
          ? interpolate(t('activity.sessions'), { count: formatExact(row.sessions) })
          : interpolate(t('activity.requests'), { count: formatExact(row.requests) });
        return `${share} · ${count}`;
      };
      const spark = (row) => h('span', { className: `dst-activity-spark${zoom ? ' is-2x' : ''}`, 'aria-hidden': true },
        days.map((day, index) => {
          const value = Array.isArray(row.series) && row.series[index] ? row.series[index] : 0;
          const level = value > 0 && maxDay > 0 ? Math.max(0.2, Math.min(1, Math.sqrt(value / maxDay))) : 0;
          return h('span', {
            key: day,
            className: 'dst-spark-cell',
            style: level === 0 ? undefined : { opacity: level },
            title: `${day} · ${formatCount(value, lang)}`,
          });
        }));

      let body;
      if (!data && state.loading) {
        body = h('div', { className: 'dst-activity-empty' }, t('activity.loading'));
      } else if (!data && state.error) {
        body = h('div', { className: 'dst-activity-empty' },
          h('div', { className: 'dst-activity-empty-title' }, t('activity.error')),
          h('div', null, state.error),
          h('button', { type: 'button', className: 'dst-btn', style: { marginTop: '8px' }, onClick: reload }, t('activity.retry')));
      } else if (rows.length === 0) {
        const noMatch = needle.length > 0;
        body = h('div', { className: 'dst-activity-empty' },
          h('div', { className: 'dst-activity-empty-title' }, noMatch ? t('activity.noMatch') : t('activity.empty')),
          h('div', null, noMatch ? t('activity.noMatchHint') : t('activity.emptyHint')));
      } else {
        body = h('div', { className: 'dst-activity-list' },
          rows.map((row) => h('div', {
            key: `${isWorkspace ? 'w' : 's'}:${row.id}`,
            className: 'dst-activity-row',
            title: row.id,
          },
            h('div', { className: 'dst-activity-name' },
              h('span', { className: 'dst-row-title' }, nameOf(row)),
              !isWorkspace ? h('span', { className: 'dst-row-sub' }, row.projectTitle || row.project || '') : null),
            h('span', { className: 'dst-activity-value' },
              effectiveMetric === 'token' ? formatCount(row.total, lang) : formatExact(row[metricKey])),
            h('span', { className: 'dst-activity-meta' }, metaOf(row)),
            spark(row))));
      }

      return h('div', { className: 'dst-section' },
        h('div', { className: 'dst-section-head' },
          h('div', { className: 'dst-section-title' }, t('activity.title')),
          h('span', { className: 'dst-badge' }, t('activity.window')),
          h('div', { className: 'dst-activity-tools' },
            h(Segmented, {
              label: t('activity.title'),
              active: mode,
              onSelect: (next) => setMode(next),
              options: [
                { id: 'session', label: t('activity.bySession') },
                { id: 'workspace', label: t('activity.byWorkspace') },
              ],
            }),
            h('input', {
              className: 'dst-activity-search',
              type: 'search',
              value: query,
              placeholder: t('activity.search'),
              'aria-label': t('activity.search'),
              onChange: (event) => setQuery(event.target.value),
            }),
            h(Segmented, {
              label: t('activity.metricToken'),
              active: effectiveMetric,
              onSelect: (next) => setMetric(next),
              options: [
                { id: 'token', label: t('activity.metricToken') },
                isWorkspace
                  ? { id: 'sessions', label: t('activity.metricSessions') }
                  : { id: 'requests', label: t('activity.metricRequests') },
              ],
            }),
            h('button', {
              type: 'button',
              className: 'dst-btn',
              'aria-pressed': zoom,
              title: t('activity.zoomHint'),
              onClick: () => setZoom((value) => !value),
            }, t('activity.zoom')),
            h('button', { type: 'button', className: 'dst-btn', onClick: reload, disabled: state.loading }, t('action.refresh')))),
        body,
        data && rows.length > 0
          ? h('div', { className: 'dst-breakdown-foot' },
              h('span', null, interpolate(t('activity.footer'), {
                total: formatCount(denominator, lang),
                days: days.length,
              })),
              !isWorkspace && data.truncatedSessions ? h('span', { className: 'dst-breakdown-note' },
                interpolate(t('activity.truncated'), { count: formatExact(data.sessions.length) })) : null,
              state.error ? h('span', { className: 'dst-error' }, state.error) : null)
          : null);
    }

    // ---- hourly / model / request-size charts --------------------------------
    const INSIGHTS_REFRESH_MS = 60000;
    const CHART_COLORS = ['#2f7cf6', '#f0a23a', '#3fae7a', '#d477b0', '#8c7ae6', '#e0603f', '#8a9a5b', '#6b7a8f', '#b9c2cf'];

    /** Fetch the hourly / model / size analytics; throws on non-2xx. */
    function fetchInsights() {
      return fetch(INSIGHTS_ROUTE, { credentials: 'same-origin', headers: { accept: 'application/json' } }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
    }

    /** Shared load-into-state effect for the insights route. */
    function useInsights(refreshMs) {
      const [state, setState] = React.useState({ loading: true, data: null, error: null });
      const load = React.useCallback(() => {
        let cancelled = false;
        setState((previous) => ({ ...previous, loading: true }));
        Promise.resolve()
          .then(fetchInsights)
          .then((json) => {
            if (!cancelled) setState({ loading: false, data: json, error: null });
          })
          .catch((error) => {
            if (!cancelled) {
              setState((previous) => ({
                loading: false,
                data: previous.data,
                error: String(error && error.message ? error.message : error),
              }));
            }
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

    /** "低 ■■■■■ 高" swatch legend for the hour grid. */
    function ShadeLegend({ t }) {
      return h('span', { className: 'dst-legend', 'aria-hidden': true },
        h('span', { className: 'dst-legend-label' }, t('hourly.low')),
        [0.15, 0.35, 0.55, 0.75, 1].map((level) => h('span', { key: level, className: 'dst-legend-swatch', style: { opacity: level } })),
        h('span', { className: 'dst-legend-label' }, t('hourly.high')));
    }

    /** Day x hour token grid plus the four time-of-day shares (tab body). */
    function HourlyHeatmapBody({ t, lang, hourly }) {
      const rows = (hourly.byDay || []).slice().reverse();
      const max = rows.reduce((peak, row) => {
        for (const value of row.hours) if (value > peak) peak = value;
        return peak;
      }, 0);
      const buckets = hourly.buckets || [];
      const toolbar = h('div', { className: 'dst-chart-toolbar dst-end' },
        h('span', { className: 'dst-badge' }, t('hourly.window')),
        h(ShadeLegend, { t }));
      const bucketRow = h('div', { className: 'dst-buckets' },
        buckets.map((bucket) => h('div', { key: bucket.id, className: 'dst-bucket' },
          h('span', { className: 'dst-bucket-label' }, `${t('bucket.' + bucket.id)} ${bucket.from}-${bucket.to}`),
          h('span', { className: 'dst-bucket-share' }, `${(bucket.share * 100).toFixed(1)}%`))));
      const grid = h('div', { className: 'dst-hourgrid' },
        h('div', { className: 'dst-hourgrid-row dst-hourgrid-head' },
          h('span', { className: 'dst-hourgrid-day' }),
          Array.from({ length: 24 }, (_, hour) => h('span', { key: hour, className: 'dst-hourgrid-hour' }, hour))),
        rows.map((row) => h('div', { key: row.day, className: 'dst-hourgrid-row' },
          h('span', { className: 'dst-hourgrid-day' }, row.day.slice(5)),
          row.hours.map((value, hour) => h('span', {
            key: hour,
            className: 'dst-hourgrid-cell',
            title: `${row.day} ${pad2(hour)}:00 · ${formatCount(value, lang)}`,
            style: value > 0 && max > 0 ? { opacity: Math.max(0.18, Math.min(1, Math.sqrt(value / max))) } : undefined,
          })))));
      return h(React.Fragment, null, toolbar, bucketRow, grid);
    }

    /** One translucent area per model over the 24-hour axis (tab body). */
    function ModelHourlyBody({ t, lang, hourly, colorOf }) {
      const models = hourly.byModel || [];
      const peak = models.reduce((max, row) => Math.max(max, ...row.hours), 0) || 1;
      const width = 760;
      const height = 180;
      const left = 46;
      const bottom = 22;
      const top = 10;
      const x = (hour) => left + (hour / 23) * (width - left - 8);
      const y = (value) => top + (1 - value / peak) * (height - top - bottom);
      const areaOf = (hours) => {
        const points = hours.map((value, hour) => `${x(hour).toFixed(1)},${y(value).toFixed(1)}`);
        return `M${points.join(' L')} L${x(23).toFixed(1)},${height - bottom} L${x(0).toFixed(1)},${height - bottom} Z`;
      };
      const ticks = [0, 4, 8, 12, 16, 20];
      const toolbar = h('div', { className: 'dst-chart-toolbar' },
        h('span', { className: 'dst-legend' },
          models.map((row) => h('span', { key: row.model, className: 'dst-legend-item' },
            h('span', { className: 'dst-legend-dot', style: { background: colorOf(row.model) } }),
            h('span', { className: 'dst-legend-text' }, row.model)))));
      const chart = h('svg', { className: 'dst-area-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': t('modelHour.title') },
        h('line', { x1: left, y1: height - bottom, x2: width - 8, y2: height - bottom, className: 'dst-chart-axis' }),
        models.map((row) => h('path', {
          key: row.model,
          d: areaOf(row.hours),
          fill: colorOf(row.model),
          opacity: 0.18,
          stroke: colorOf(row.model),
          strokeWidth: 1,
        })),
        h('text', { x: left - 6, y: top + 8, className: 'dst-chart-axis-text', textAnchor: 'end' }, formatCount(peak, lang)),
        ticks.map((hour) => h('text', {
          key: hour,
          x: x(hour),
          y: height - 6,
          className: 'dst-chart-axis-text',
          textAnchor: 'middle',
        }, t('hourly.hourTick', { hour }))));
      return h(React.Fragment, null, toolbar, chart);
    }

    /** Stacked bars: one column per day, segments per model (tab body). */
    function DailyModelBarsBody({ t, lang, daily, colorOf }) {
      const days = daily.days || [];
      const legend = daily.models || [];
      const totals = days.map((row) => legend.reduce((sum, entry) => sum + (row.models[entry.id] || 0), 0));
      const peak = totals.reduce((max, value) => Math.max(max, value), 0) || 1;
      const toolbar = h('div', { className: 'dst-chart-toolbar' },
        h('span', { className: 'dst-legend' },
          legend.map((entry) => h('span', { key: entry.id, className: 'dst-legend-item' },
            h('span', { className: 'dst-legend-dot', style: { background: colorOf(entry.id) } }),
            h('span', { className: 'dst-legend-text' },
              entry.id === 'other' ? t('dailyModel.other') : entry.id),
            h('span', { className: 'dst-legend-value' }, formatCount(entry.total, lang))))));
      const bars = h('div', { className: 'dst-dailymix' },
        h('div', { className: 'dst-dailymix-bars' },
          days.map((row, index) => h('div', {
            key: row.day,
            className: 'dst-dailymix-col',
            title: `${row.day} · ${formatCount(totals[index], lang)}`,
          }, h('div', { className: 'dst-dailymix-stack', style: { height: `${(totals[index] / peak) * 100}%` } },
            legend.map((entry) => {
              const value = row.models[entry.id] || 0;
              return value > 0
                ? h('span', { key: entry.id, className: 'dst-dailymix-seg', style: { flexGrow: value, background: colorOf(entry.id) } })
                : null;
            }))))),
        h('div', { className: 'dst-dailymix-axis' },
          days.map((row, index) => h('span', { key: row.day, className: 'dst-dailymix-tick' },
            (days.length - 1 - index) % 5 === 0 ? row.day.slice(5) : ''))));
      return h(React.Fragment, null, toolbar, bars);
    }

    /** Per-model request size distribution with 50% line and 90% dot (tab body). */
    function RequestSizesBody({ t, lang, sizes }) {
      const models = sizes.models || [];
      const axisMax = sizes.axisMax || 1;
      const width = 260;
      const height = 34;
      const pos = (value) => Math.min(width - 1, (value / axisMax) * width);
      // Each row normalizes to its own peak, matching the reference footnote:
      // the shape is readable even for models with far fewer requests.
      const areaOf = (buckets) => {
        const peak = buckets.reduce((max, value) => Math.max(max, value), 0) || 1;
        const step = width / buckets.length;
        const points = buckets.map((count, index) => `${(index * step + step / 2).toFixed(1)},${(height - 2 - (count / peak) * (height - 6)).toFixed(1)}`);
        return `M0,${height - 2} L${points.join(' L')} L${width},${height - 2} Z`;
      };
      const toolbar = h('div', { className: 'dst-chart-toolbar dst-end' },
        h('span', { className: 'dst-note' }, interpolate(t('sizes.total'), {
          models: formatExact(models.length),
          count: formatExact(sizes.total),
        })));
      const table = models.length === 0
        ? h('div', { className: 'dst-activity-empty' }, t('sizes.empty'))
        : h('div', { className: 'dst-sizes' },
            h('div', { className: 'dst-size-row dst-size-row-head' },
              h('span', { className: 'dst-size-model' }, t('sizes.model')),
              h('span', { className: 'dst-size-count' }, t('sizes.count')),
              h('span', { className: 'dst-size-p' }, t('sizes.p50')),
              h('span', { className: 'dst-size-p' }, t('sizes.p90')),
              h('span', { className: 'dst-size-chart' })),
            models.map((row) => h('div', { key: row.model, className: 'dst-size-row' },
              h('span', { className: 'dst-size-model', title: row.model }, row.model),
              h('span', { className: 'dst-size-count' }, formatExact(row.count)),
              h('span', { className: 'dst-size-p' }, formatCount(row.p50, lang)),
              h('span', { className: 'dst-size-p' }, formatCount(row.p90, lang)),
              h('span', { className: 'dst-size-chart' },
                h('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', 'aria-hidden': true },
                  h('path', { d: areaOf(row.buckets), className: 'dst-size-area' }),
                  h('line', { x1: pos(row.p50), x2: pos(row.p50), y1: 2, y2: height - 2, className: 'dst-size-line' }),
                  h('circle', { cx: pos(row.p90), cy: 3, r: 2, className: 'dst-size-dot' }))))),
            h('div', { className: 'dst-sizes-axis' },
              [0, 0.25, 0.5, 0.75, 1].map((fraction) => h('span', { key: fraction }, formatCount(axisMax * fraction, lang)))),
            h('div', { className: 'dst-note' }, t('sizes.note')));
      return h(React.Fragment, null, toolbar, table);
    }

    /** The four analytics charts share one fetch and one tabbed card. */
    function Insights({ t, lang }) {
      const [state, reload] = useInsights(INSIGHTS_REFRESH_MS);
      const [tab, setTab] = React.useState('hourly');
      const data = state.data;
      const tabs = [
        { id: 'hourly', label: t('insights.tab.hourly') },
        { id: 'modelHour', label: t('insights.tab.modelHour') },
        { id: 'dailyModel', label: t('insights.tab.dailyModel') },
        { id: 'sizes', label: t('insights.tab.sizes') },
      ];
      const head = h('div', { className: 'dst-section-head' },
        h('div', { className: 'dst-section-title' }, t('insights.title')),
        h('span', { className: 'dst-spacer' }),
        h(Segmented, { label: t('insights.title'), active: tab, onSelect: setTab, options: tabs }));
      if (!data) {
        return h('div', { className: 'dst-section dst-insights' },
          head,
          state.error
            ? h('div', { className: 'dst-activity-empty' },
                h('div', { className: 'dst-activity-empty-title' }, t('insights.error')),
                h('div', null, state.error),
                h('button', { type: 'button', className: 'dst-btn', style: { marginTop: '8px' }, onClick: reload }, t('insights.retry')))
            : h('div', { className: 'dst-activity-empty' }, t('insights.loading')));
      }
      const colorMap = new Map();
      for (const entry of data.daily.models || []) colorMap.set(entry.id, CHART_COLORS[colorMap.size % CHART_COLORS.length]);
      for (const entry of data.hourly.byModel || []) {
        if (!colorMap.has(entry.model)) colorMap.set(entry.model, CHART_COLORS[colorMap.size % CHART_COLORS.length]);
      }
      const colorOf = (id) => colorMap.get(id) || CHART_COLORS[CHART_COLORS.length - 1];
      const body = tab === 'modelHour'
        ? h(ModelHourlyBody, { t, lang, hourly: data.hourly, colorOf })
        : tab === 'dailyModel'
          ? h(DailyModelBarsBody, { t, lang, daily: data.daily, colorOf })
          : tab === 'sizes'
            ? h(RequestSizesBody, { t, lang, sizes: data.sizes })
            : h(HourlyHeatmapBody, { t, lang, hourly: data.hourly });
      return h('div', { className: 'dst-section dst-insights' },
        head,
        body,
        state.error ? h('div', { className: 'dst-note dst-error' }, state.error) : null);
    }

    // ---- project / session / turn breakdown ---------------------------------
    // Fetch cap for drill-down levels; the route accepts up to 500 and returns
    // whole-dimension totals regardless of the row limit. The table paginates
    // client-side, so a deeper window (200) gives the pager room to move.
    const BREAKDOWN_LIMIT = 200;
    // Rows per page of the paginated lists (breakdown table, session turns).
    const PAGE_SIZE = 10;

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
        h('span', { className: 'dst-num dst-num-cache', key: 'cacheRead', title: formatExact(row.cacheRead) }, formatCount(row.cacheRead, lang)),
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
      const [page, setPage] = React.useState(1);
      const level = stack.length > 0 ? stack[stack.length - 1] : { by: dimension, root: true };
      const revision = data ? data.now : null;
      const [fetched, reload] = useBreakdown(level, !level.root, revision);
      const rows = level.root ? rootBreakdownRows(data, dimension) : fetched.rows;
      const totals = breakdownTotals(level, data, rows, level.root ? null : fetched.totals);
      // Pagination is client-side over the fetched window; the drill-down
      // handlers below reset it so a new level always opens at page 1.
      const { pages, page: safePage } = clampedPage(page, rows);
      const visible = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

      const pickDimension = (id) => {
        setDimension(id);
        setStack([]);
        setPage(1);
      };
      const drill = (row) => {
        if (level.by === 'project') {
          setStack([...stack, { by: 'session', project: row.id, label: breakdownRowName(row, 'project', t) }]);
        } else if (level.by === 'session') {
          setStack([...stack, { by: 'turn', session: row.id, label: breakdownRowName(row, 'session', t) }]);
        }
        setPage(1);
      };
      const back = () => {
        setStack(stack.slice(0, -1));
        setPage(1);
      };
      const goTo = (depth) => {
        setStack(stack.slice(0, depth));
        setPage(1);
      };

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
          visible.map((row) => h(BreakdownRow, {
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
              note ? h('span', { className: 'dst-breakdown-note' }, note) : null,
              h('span', { className: 'dst-breakdown-note' }, interpolate(t('pager.rows'), { count: rows.length })),
              pages > 1 ? h(Pager, { t, page: safePage, pages, onPage: setPage }) : null)
          : null);
    }

    // ---- current-session tab (conversation.view) ---------------------------
    /** Fetch the open session's turns; the route also returns whole-session totals. */
    function fetchSessionTurns(sessionId) {
      const search = new URLSearchParams();
      search.set('by', 'turn');
      search.set('session', sessionId);
      search.set('limit', String(SESSION_TURNS_LIMIT));
      return fetch(`${BREAKDOWN_ROUTE}?${search.toString()}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
    }

    /**
     * One session's usage. A session switch clears the rows immediately (never
     * show another session's numbers); a periodic refresh keeps them on screen
     * and only flips `loading`. A late response for the previous session is
     * dropped by the `cancelled` flag and by the sessionId identity check.
     */
    function useSessionUsage(sessionId, refreshMs) {
      const [state, setState] = React.useState({ sessionId: null, loading: true, data: null, error: null });
      const load = React.useCallback(() => {
        if (!sessionId) {
          setState({ sessionId: null, loading: false, data: null, error: null });
          return () => {};
        }
        let cancelled = false;
        setState((previous) => (previous.sessionId === sessionId
          ? { ...previous, loading: true }
          : { sessionId, loading: true, data: null, error: null }));
        Promise.resolve()
          .then(() => fetchSessionTurns(sessionId))
          .then((json) => {
            if (!cancelled) setState({ sessionId, loading: false, data: json, error: null });
          })
          .catch((error) => {
            if (!cancelled) setState({ sessionId, loading: false, data: null, error: String(error && error.message ? error.message : error) });
          });
        return () => {
          cancelled = true;
        };
      }, [sessionId]);
      React.useEffect(() => {
        const cleanup = load();
        const timer = setInterval(load, refreshMs);
        return () => {
          cleanup();
          clearInterval(timer);
        };
      }, [load, refreshMs]);
      if (state.sessionId !== sessionId) return [{ sessionId, loading: true, data: null, error: null }, load];
      return [state, load];
    }

    /** One labelled card of the session summary; `exact` is the hover title,
     *  `extra` a modifier class (`dst-card-hero` / tone classes). */
    function SessionCard({ label, value, exact, extra }) {
      return h('div', { className: extra ? `dst-card ${extra}` : 'dst-card', title: exact },
        h('div', { className: 'dst-card-value' }, value),
        h('div', { className: 'dst-card-label' }, label));
    }

    /** One row of the per-turn table. */
    function SessionTurnRow({ row, t, lang }) {
      const start = formatTimestamp(row.startTs);
      const span = formatSpan(row.durationMs, lang);
      const sub = span === '—' ? start : `${start} · ${span}`;
      const turn = row.turn === undefined || row.turn === null ? '—' : row.turn;
      return h('div', { className: 'dst-row' },
        h('span', { className: 'dst-row-name' },
          h('span', { className: 'dst-row-title' }, interpolate(t('session.turnLabel'), { turn })),
          h('span', { className: 'dst-row-sub' }, sub)),
        h('span', { className: 'dst-num dst-num-strong', title: formatExact(row.total) }, formatCount(row.total, lang)),
        h('span', { className: 'dst-num dst-num-cache', title: formatExact(row.cacheRead) }, formatCount(row.cacheRead, lang)),
        h('span', { className: 'dst-num', title: formatExact(row.input) }, formatCount(row.input, lang)),
        h('span', { className: 'dst-num', title: formatExact(row.output) }, formatCount(row.output, lang)),
        h('span', { className: 'dst-num', title: formatExact(row.requests) }, formatExact(row.requests)));
    }

    /**
     * The `conversation.view` tab body. The slot is session-scoped, so
     * `props.sessionId` is the open session and this view never aggregates
     * anything outside it.
     */
    function SessionUsage({ t, lang, sessionId, ctx }) {
      const [state, load] = useSessionUsage(sessionId, REFRESH_MS);
      const payload = state.data;
      const rows = payload && Array.isArray(payload.rows) ? payload.rows : [];
      const totals = (payload && payload.totals) || null;
      const sample = rows.length > 0 ? rows[0] : null;
      const projectTitle = sample ? sample.projectTitle || sample.project || null : null;
      const sessionTitle = sample ? sample.sessionTitle || null : null;
      const empty = totals !== null && !(totals.requests > 0);
      const truncated = rows.length >= SESSION_TURNS_LIMIT;
      // Turns paginate client-side (PAGE_SIZE per page); a session switch
      // resets to page 1 — adjusted during render so no effect is needed.
      const [page, setPage] = React.useState(1);
      const [pageSession, setPageSession] = React.useState(sessionId);
      if (pageSession !== sessionId) {
        setPageSession(sessionId);
        setPage(1);
      }
      const { pages, page: safePage } = clampedPage(page, rows);
      const visible = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

      const openPanel = () => {
        try {
          if (ctx.layout && typeof ctx.layout.selectPanel === 'function') ctx.layout.selectPanel(PANEL_ID);
        } catch (error) {
          console.warn('token-usage-stats: selectPanel failed', error);
        }
      };

      const meta = projectTitle || sessionTitle
        ? h('div', { className: 'dst-session-meta' },
            projectTitle ? h('span', { key: 'project' }, `${t('session.meta.project')} `, h('b', null, projectTitle)) : null,
            sessionTitle ? h('span', { key: 'session' }, `${t('session.meta.session')} `, h('b', null, sessionTitle)) : null)
        : null;

      const cards = totals !== null && !empty
        ? h('div', { className: 'dst-cards' },
            h(SessionCard, { label: t('session.card.total'), value: formatCount(totals.total, lang), exact: formatExact(totals.total), extra: 'dst-card-hero' }),
            h(SessionCard, { label: t('session.card.input'), value: formatCount(totals.input, lang), exact: formatExact(totals.input) }),
            // Cache hits are savings (success hue), cache writes the prepaid
            // cost (warning hue) — the same encoding the tables use below.
            h(SessionCard, { label: t('session.card.cacheRead'), value: formatCount(totals.cacheRead, lang), exact: formatExact(totals.cacheRead), extra: 'dst-card-tone-success' }),
            h(SessionCard, { label: t('session.card.cacheWrite'), value: formatCount(totals.cacheWrite, lang), exact: formatExact(totals.cacheWrite), extra: 'dst-card-tone-warning' }),
            h(SessionCard, { label: t('session.card.output'), value: formatCount(totals.output, lang), exact: formatExact(totals.output) }),
            h(SessionCard, { label: t('session.card.requests'), value: formatExact(totals.requests) }),
            h(SessionCard, { label: t('session.card.turns'), value: formatExact(rows.length) }))
        : null;

      const turnsTable = rows.length === 0
        ? null
        : h('div', { className: 'dst-section' },
            h('div', { className: 'dst-section-head' },
              h('div', { className: 'dst-section-title' }, t('session.turns.title'))),
            h('div', { className: 'dst-table dst-session-table' },
              h('div', { className: 'dst-table-head', 'aria-hidden': true },
                h('span', null, t('session.col.turn')),
                h('span', { className: 'dst-num' }, t('session.col.total')),
                h('span', { className: 'dst-num' }, t('session.col.cacheRead')),
                h('span', { className: 'dst-num' }, t('session.col.input')),
                h('span', { className: 'dst-num' }, t('session.col.output')),
                h('span', { className: 'dst-num' }, t('session.col.requests'))),
              visible.map((row) => h(SessionTurnRow, {
                key: `${String(row.turn)}:${String(row.startTs)}`,
                row,
                t,
                lang,
              }))),
            h('div', { className: 'dst-breakdown-foot' },
              h('span', null, interpolate(t('pager.rows'), { count: rows.length })),
              truncated ? h('span', { className: 'dst-breakdown-note' }, interpolate(t('session.topN'), { count: rows.length })) : null,
              pages > 1 ? h(Pager, { t, page: safePage, pages, onPage: setPage }) : null));

      const body = (() => {
        if (state.error) {
          return h('div', { className: 'dst-empty' },
            h('div', { className: 'dst-empty-title' }, t('session.error')),
            h('div', null, state.error),
            h('button', { type: 'button', className: 'dst-btn', style: { marginTop: '10px' }, onClick: load }, t('session.retry')));
        }
        if (payload === null) return h('div', { className: 'dst-stat-label' }, t('session.loading'));
        if (empty) {
          return h('div', { className: 'dst-empty' },
            h('div', { className: 'dst-empty-title' }, t('session.empty')),
            h('div', null, t('session.emptyHint')));
        }
        return null;
      })();

      return h('div', { className: 'dst-page' },
        h('div', { className: 'dst-page-inner' },
          h('div', { className: 'dst-page-head' },
            h('h1', { className: 'dst-page-title' }, t('session.title')),
            h('span', { className: 'dst-page-badge' }, t('session.badge')),
            h('span', { className: 'dst-spacer' }),
            h('button', { type: 'button', className: 'dst-btn', onClick: load, disabled: state.loading }, t('action.refresh')),
            h('button', { type: 'button', className: 'dst-btn', onClick: openPanel }, t('session.openPanel'))),
          meta,
          body,
          cards,
          turnsTable,
          h('div', { className: 'dst-foot' }, t('session.footer'))));
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
            // The 365-day heatmap window is the only long-range payload the
            // v3 summary carries; hide the whole section on older hosts.
            Array.isArray(data.heatmap) ? h('div', { className: 'dst-section' },
              h(MonthlyChart, { t, lang, days: data.heatmap })) : null,
            h('div', { className: 'dst-section' },
              h('div', { className: 'dst-section-head' },
                h('div', { className: 'dst-section-title' }, t('models.title'))),
              h(ModelUsage, { t, lang, models: data.models })),
            hasBreakdown(data) ? h(WorkspaceActivity, { t, lang }) : null,
            hasBreakdown(data) ? h(Insights, { t, lang }) : null,
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
        // Session tab strip: `label` is the tab text, the render function gets
        // the scoped `sessionId` of the open conversation.
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: SESSION_TAB_ID,
          order: SESSION_TAB_ORDER,
          locale: NS,
          label: () => t('tab.session'),
        }, (props) => h(SessionUsage, {
          t,
          lang,
          sessionId: props && props.sessionId,
          ctx,
        })));
      },
    };
  },
});

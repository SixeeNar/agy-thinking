/**
 * 侧边栏 UI 与内嵌 Shadow DOM 共用的纯渲染辅助函数、DSH 过程分组引擎与图标，
 * 确保两端在分组边界、活动分类、4 档策略、思考摘要与 Markdown 渲染上完全一致。
 */

export const SHARED_RENDER_SOURCE = `
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatInline(line) {
  let out = escapeHtml(line);
  const inlineCodes = [];
  out = out.replace(/\`([^\`]+)\`/g, function (_m, code) {
    const idx = inlineCodes.length;
    inlineCodes.push('<code>' + code + '</code>');
    return '\\u0000IC_' + idx + '\\u0000';
  });
  out = out.replace(/\\*\\*((?:[^*]|\\*(?!\\*))+)\\*\\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\\w])\\*([^\\s*](?:[^*]*?[^\\s*])?)\\*(?![*\\w.])/g, '$1<em>$2</em>');
  if (inlineCodes.length > 0) {
    out = out.replace(/\\u0000IC_(\\d+)\\u0000/g, function (_m, i) {
      return inlineCodes[Number(i)] || '';
    });
  }
  return out;
}

function renderMarkdown(raw) {
  if (!raw) return '';
  const codeBlocks = [];
  let text = String(raw).replace(/\\r\\n/g, '\\n');
  text = text.replace(/(^|\\n)[\\t ]*\`\`\`[^\\n]*\\n([\\s\\S]*?\\n)?[\\t ]*\`\`\`[\\t ]*(?=\\n|$)/g, function (_m, lead, code) {
    const idx = codeBlocks.length;
    codeBlocks.push('<pre><code>' + escapeHtml((code || '').replace(/\\n$/, '')) + '</code></pre>');
    return (lead || '') + '\\n\\u0000CB_' + idx + '\\u0000\\n';
  });
  // 流式未闭合代码块兜底渲染（仅匹配行首围栏，避免行内三反引号吞掉后文）
  text = text.replace(/(^|\\n)[\\t ]*\`\`\`[^\\n]*\\n([\\s\\S]*)$/, function (_m, lead, code) {
    const idx = codeBlocks.length;
    codeBlocks.push('<pre><code>' + escapeHtml((code || '').replace(/\\n$/, '')) + '</code></pre>');
    return (lead || '') + '\\n\\u0000CB_' + idx + '\\u0000\\n';
  });

  const lines = text.split('\\n');
  const out = [];
  let listType = '';
  let listItems = [];
  let quoteLines = [];
  let paraLines = [];

  function flushPara() {
    if (paraLines.length > 0) {
      out.push('<p>' + formatInline(paraLines.join('\\n')).replace(/\\n/g, '<br>') + '</p>');
      paraLines = [];
    }
  }
  function flushList() {
    if (listItems.length > 0) {
      out.push('<' + listType + '>' + listItems.map(function (it) { return '<li>' + formatInline(it) + '</li>'; }).join('') + '</' + listType + '>');
      listItems = [];
      listType = '';
    }
  }
  function flushQuote() {
    if (quoteLines.length > 0) {
      out.push('<blockquote>' + quoteLines.map(formatInline).join('<br>') + '</blockquote>');
      quoteLines = [];
    }
  }
  function flushAll() {
    flushPara();
    flushList();
    flushQuote();
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushAll();
      continue;
    }

    const cbMatch = trimmed.match(/^\\u0000CB_(\\d+)\\u0000$/);
    if (cbMatch) {
      flushAll();
      out.push(codeBlocks[Number(cbMatch[1])] || '');
      continue;
    }

    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushAll();
      out.push('<hr>');
      continue;
    }

    const headMatch = trimmed.match(/^(#{1,6})\\s+(.+)$/);
    if (headMatch) {
      flushAll();
      const lvl = Math.min(4, headMatch[1].length);
      out.push('<h' + (lvl + 2) + ' class="md-h">' + formatInline(headMatch[2]) + '</h' + (lvl + 2) + '>');
      continue;
    }

    const ulMatch = trimmed.match(/^[-*+]\\s+(.+)$/);
    if (ulMatch) {
      flushPara();
      flushQuote();
      if (listType && listType !== 'ul') flushList();
      listType = 'ul';
      listItems.push(ulMatch[1]);
      continue;
    }

    const olMatch = trimmed.match(/^\\d+\\.\\s+(.+)$/);
    if (olMatch) {
      flushPara();
      flushQuote();
      if (listType && listType !== 'ol') flushList();
      listType = 'ol';
      listItems.push(olMatch[1]);
      continue;
    }

    const qMatch = trimmed.match(/^>\\s?(.*)$/);
    if (qMatch) {
      flushPara();
      flushList();
      quoteLines.push(qMatch[1]);
      continue;
    }

    flushList();
    flushQuote();
    paraLines.push(line);
  }

  flushAll();
  return out.join('').replace(/\\u0000CB_(\\d+)\\u0000/g, function (_m, i) {
    return codeBlocks[Number(i)] || '';
  });
}

function parseThinkingSteps(raw) {
  if (!raw) return null;
  const text = String(raw).replace(/\\r\\n/g, '\\n');
  const lines = text.split('\\n');
  const steps = [];
  let inFence = false;
  let current = null;
  const leadLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^\`{3,}/.test(trimmed)) {
      inFence = !inFence;
      if (current) current.body.push(line);
      else leadLines.push(line);
      continue;
    }
    if (!inFence) {
      const isIndentedSubItem = /^(?:\\t| {2,})/.test(line);
      let m = null;
      if (!isIndentedSubItem) {
        m = trimmed.match(/^(?:[-*+]|\\d+[.)])\\s+\\*\\*((?:[^*]|\\*(?!\\*))+)\\*\\*\\s*(?:[：:\\-—]\\s*(.*))?$/);
        if (!m) {
          m = trimmed.match(/^#{1,4}\\s+(.+)$/);
          if (m) {
            m = [m[0], m[1].replace(/\\*\\*/g, '').trim(), ''];
          }
        }
        if (!m) {
          m = trimmed.match(/^\\*\\*((?:[^*]|\\*(?!\\*)){2,32})\\*\\*\\s*(?:[：:]\\s*(.*))?$/);
        }
      }
      if (m) {
        const title = String(m[1] || '').trim();
        const rest = String(m[2] || '').trim();
        if (title) {
          current = { title, body: rest ? [rest] : [] };
          steps.push(current);
          continue;
        }
      }
    }
    if (current) current.body.push(line);
    else if (trimmed) leadLines.push(line);
  }

  if (steps.length === 0) return null;
  if (leadLines.length > 0) {
    steps.unshift({ title: '思路概览', body: leadLines });
  }
  return steps;
}

function countThinkingSteps(raw) {
  const steps = parseThinkingSteps(raw);
  return steps ? steps.length : 0;
}

function renderThinkingSteps(raw, preferSteps) {
  if (!raw) return '';
  if (preferSteps !== false) {
    const steps = parseThinkingSteps(raw);
    if (steps && steps.length > 0) {
      const nodes = steps.map(function (st, idx) {
        const descRaw = st.body.join('\\n').trim();
        const descHtml = descRaw ? ('<div class="tstep-desc">' + renderMarkdown(descRaw) + '</div>') : '';
        return (
          '<div class="tstep-node">' +
            '<span class="tstep-idx">' + (idx + 1) + '</span>' +
            '<div class="tstep-body">' +
              '<div class="tstep-title">' + formatInline(st.title) + '</div>' +
              descHtml +
            '</div>' +
          '</div>'
        );
      });
      return '<div class="tstep-list">' + nodes.join('') + '</div>';
    }
  }
  return renderMarkdown(raw);
}

function isFenceLine(trimmed) {
  return /^\`{3,}/.test(trimmed);
}

function firstLine(text) {
  const lines = String(text || '').split(/\\r?\\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed && !isFenceLine(trimmed)) return trimmed;
  }
  return '';
}

/**
 * DSH ReasoningRow 流式预览规则：
 * 仅取「最近一个首行已经遇到换行符 \\n 的段落首行」，未完成首行时不提前闪现半行字。
 */
function latestCompletedParagraphFirstLine(text) {
  const str = String(text || '').replace(/^(?:[\\t ]*\\r?\\n)+/, '');
  let summary = '';
  let start = 0;
  const sep = /\\r?\\n(?:[\\t ]*\\r?\\n)+/g;
  while (true) {
    const next = sep.exec(str);
    const end = next === null ? str.length : next.index + next[0].indexOf('\\n');
    const nl = str.indexOf('\\n', start);
    if (nl !== -1 && nl <= end) {
      const cand = str.slice(start, nl).trim();
      if (cand && !isFenceLine(cand)) summary = cand;
    }
    if (next === null) return summary;
    start = next.index + next[0].length;
  }
}

function latestParagraphFirstLine(text) {
  return latestCompletedParagraphFirstLine(text) || firstLine(text);
}

function stripSummaryDecor(line) {
  return String(line || '')
    .replace(/^#{1,6}\\s+/, '')
    .replace(/^(?:[-*+]|\\d+[.)])\\s+/, '')
    .replace(/\\*\\*/g, '')
    .replace(/\`/g, '')
    .replace(/\\s+/g, ' ')
    .trim();
}

function thinkSummary(text, running) {
  const line = running ? latestCompletedParagraphFirstLine(text) : firstLine(text);
  return stripSummaryDecor(line);
}

function shortModelName(model) {
  if (!model) return '';
  if (model === 'cache') return '缓存';
  if (model === 'native-zh') return '原生中文';
  const parts = String(model).split('/');
  return parts[parts.length - 1] || model;
}

function formatDurationHuman(sec, running) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '';
  const whole = Math.max(1, Math.round(sec));
  if (whole >= 3600) {
    const hrs = Math.floor(whole / 3600);
    const mins = Math.floor((whole % 3600) / 60);
    return mins > 0 ? (hrs + '小时' + mins + '分') : (hrs + '小时');
  }
  if (whole >= 60) {
    const mins = Math.floor(whole / 60);
    const rem = whole % 60;
    return rem > 0 ? (mins + '分' + rem + '秒') : (mins + '分');
  }
  if (running) return whole + '秒';
  return (sec < 10 ? (Math.round(sec * 10) / 10) : whole) + '秒';
}

function formatDurationParts(sec, running) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return [];
  const whole = Math.max(1, Math.round(sec));
  if (whole >= 3600) {
    const hrs = Math.floor(whole / 3600);
    const mins = Math.floor((whole % 3600) / 60);
    const parts = [{ text: String(hrs), numeric: true }, { text: '小时', numeric: false }];
    if (mins > 0) parts.push({ text: String(mins), numeric: true }, { text: '分', numeric: false });
    return parts;
  }
  if (whole >= 60) {
    const mins = Math.floor(whole / 60);
    const rem = whole % 60;
    const parts = [{ text: String(mins), numeric: true }, { text: '分', numeric: false }];
    if (rem > 0) parts.push({ text: String(rem), numeric: true }, { text: '秒', numeric: false });
    return parts;
  }
  const s = running ? String(whole) : String(sec < 10 ? (Math.round(sec * 10) / 10) : whole);
  return [{ text: s, numeric: true }, { text: '秒', numeric: false }];
}

/**
 * 极简 2 档展示策略（专注观察思考，砍掉冗余模式）：
 * - focus:    思考直出在主时间线，连续工具自动合并为单行胶囊，回答结束后整轮自动收起（默认）
 * - expanded: 同上，但回答结束后保持整轮展开，方便连续复盘
 */
function getPresentationPolicy(settings) {
  const raw = settings?.displayLevel;
  const mode = (raw === 'expanded' || raw === 'verbose') ? 'expanded' : 'focus';
  return {
    mode,
    foldCompletedTurns: mode !== 'expanded',
    liveProcessDetail: true,
    settledReasoningPreview: true,
  };
}

/**
 * DSH 13 类工具活动分类器（同时兼容 Antigravity 工具名与 DSH/常见 Agent 工具名）
 */
function classifyToolActivity(item) {
  const name = String(item?.toolName || '').trim();
  const lower = name.toLowerCase();
  if (lower === 'read' || lower === 'read_file' || lower === 'view_file' || lower === 'view_file_outline' || lower === 'view_code_item') return 'read';
  if (lower === 'read_image' || lower === 'view_image') return 'readImage';
  if (lower === 'grep' || lower === 'grep_search' || lower === 'glob' || lower === 'find_by_name' || lower === 'list_dir' || lower.endsWith('_inspect')) return 'search';
  if (lower === 'write' || lower === 'write_file' || lower === 'write_to_file') return 'write';
  if (lower === 'edit' || lower === 'edit_file' || lower === 'apply_patch' || lower === 'replace_file_content' || lower === 'multi_replace_file_content') return 'edit';
  if (['bash', 'pwsh', 'exec_command', 'write_stdin', 'run_command', 'send_command_input', 'command_status'].includes(lower) || lower.startsWith('terminal_')) return 'commands';
  if (lower === 'run_code' || lower === 'run_workflow') return 'code';
  if (lower === 'web_search' || lower === 'search_web') return 'webSearch';
  if (lower === 'web_fetch' || lower === 'read_url_content' || lower === 'fetch_url') return 'webFetch';
  if (lower === 'subagent' || lower.startsWith('subagent_') || lower === 'invoke_subagent' || lower === 'define_subagent' || lower === 'manage_subagents' || lower === 'swarm') return 'subagents';
  if (['todo_write', 'create_goal', 'update_goal', 'get_goal', 'update_steps', 'update_focus'].includes(lower)) return 'plan';
  if (lower === 'ask_user_question' || lower === 'request_user_input' || lower === 'ask_question') return 'questions';

  if (item?.kind === 'cmd') return 'commands';
  if (item?.kind === 'search') return 'webSearch';
  if (item?.kind === 'file') {
    if (item.label === '读取文件') return 'read';
    if (item.label === '写入文件') return 'write';
    return 'edit';
  }
  return 'tools';
}

function activityIconKey(act) {
  if (act === 'thinking') return 'think';
  if (act === 'read' || act === 'readImage') return 'read';
  if (act === 'search') return 'search';
  if (act === 'write' || act === 'edit') return 'edit';
  if (act === 'commands') return 'cmd';
  if (act === 'code') return 'code';
  if (act === 'webSearch') return 'webSearch';
  if (act === 'webFetch') return 'webFetch';
  if (act === 'subagents') return 'subagents';
  if (act === 'plan') return 'plan';
  if (act === 'questions') return 'questions';
  return 'tool';
}

const STEP_LIVE_LABELS = {
  thinking: '正在分析请求',
  read: '正在读取文件',
  readImage: '正在读取图片',
  write: '正在写入文件',
  search: '正在搜索代码',
  edit: '正在编辑文件',
  commands: '正在运行命令',
  code: '正在运行代码',
  webSearch: '正在搜索网页',
  webFetch: '正在访问网页',
  subagents: '正在协调子智能体',
  plan: '正在更新计划',
  questions: '等待你的操作',
  tools: '正在调用工具',
};

const STEP_DONE_LABELS = {
  thinking: '已完成分析',
  read: '已读取文件',
  readImage: '已读取图片',
  write: '已写入文件',
  search: '已搜索代码',
  edit: '修改了文件',
  commands: '执行了命令',
  code: '运行了代码',
  webSearch: '已搜索网页',
  webFetch: '已访问网页',
  subagents: '已协调子智能体',
  plan: '更新了计划',
  questions: '向用户提出了问题',
  tools: '已调用工具',
};

function normalizeDetailText(raw) {
  const clean = String(raw || '').replace(/\\*\\*/g, '').replace(/\\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > 160 ? clean.slice(0, 159).trimEnd() + '…' : clean;
}

function liveReasoningDetailFromMembers(members, displayMode, summaryEnabled) {
  for (let i = members.length - 1; i >= 0; i--) {
    const it = members[i];
    if (it.kind !== 'think') continue;
    const isLive = it.status === 'generating' || (displayMode !== 'raw' && it.translateStatus === 'translating');
    if (!isLive) continue;
    const text = displayMode !== 'raw'
      ? ((summaryEnabled !== false && it.narrativeSummary) || it.translatedThinking || it.thinking || '')
      : (it.thinking || '');
    const paragraphs = String(text).split(/\\r?\\n[\\t ]*\\r?\\n/);
    for (let p = paragraphs.length - 1; p >= 0; p--) {
      const detail = normalizeDetailText(paragraphs[p]);
      if (detail) return detail;
    }
  }
  return '';
}

function computeGroupSummary(members, closed, displayMode, summaryEnabled) {
  const countMap = new Map();
  let running;
  let runningDetail = '';
  let runningTime = -Infinity;

  for (let i = 0; i < members.length; i++) {
    const it = members[i];
    if (it.kind === 'think') continue;
    const act = classifyToolActivity(it);
    countMap.set(act, (countMap.get(act) || 0) + 1);
    if (!closed && it.status === 'running') {
      const t = typeof it.startedAtMs === 'number' ? it.startedAtMs : i;
      if (t >= runningTime) {
        runningTime = t;
        running = act;
        runningDetail = normalizeDetailText(it.liveDetail || it.summary || it.toolName || '');
      }
    }
  }

  const counts = [];
  let totalCount = 0;
  for (const [kind, count] of countMap.entries()) {
    counts.push({ kind, count });
    totalCount += count;
  }
  counts.sort(function (a, b) { return b.count - a.count; });

  if (closed) {
    return { counts, totalCount, running: undefined, runningDetail: '' };
  }
  if (!running) {
    runningDetail = liveReasoningDetailFromMembers(members, displayMode, summaryEnabled);
  }
  return { counts, totalCount, running, runningDetail };
}

/**
 * 连续工具胶囊标题组合规则：
 * - 运行中：显示当前实时动作与详情
 * - 已结束：取次数最多的前 2~3 类动作，并附带总步数（如「修改了文件并更新了计划 · 5 项」）
 */
function formatProcessGroupTitle(summary, closed, showDetail) {
  if (!closed) {
    const act = summary?.running || 'thinking';
    const label = STEP_LIVE_LABELS[act] || STEP_LIVE_LABELS.thinking;
    const detail = showDetail && summary?.runningDetail ? summary.runningDetail : '';
    return {
      activity: act,
      iconKey: activityIconKey(act),
      label,
      detail,
      title: detail ? (label + ' · ' + detail) : label,
    };
  }
  const counts = summary?.counts || [];
  const top = counts.slice(0, 3).map(function (c) { return STEP_DONE_LABELS[c.kind] || STEP_DONE_LABELS.tools; });
  const leadAct = counts[0]?.kind || 'thinking';
  let label = STEP_DONE_LABELS.thinking;
  if (top.length === 1) {
    label = top[0];
  } else if (top.length === 2) {
    const shared = top[0].startsWith('已') && top[1].startsWith('已');
    label = top[0] + '并' + (shared ? top[1].slice(1) : top[1]);
  } else if (top.length >= 3) {
    label = top.join('，') + (counts.length > 3 ? '等' : '');
  }
  const total = summary?.totalCount || 0;
  const fullTitle = total > 1 ? (label + ' · ' + total + ' 项') : label;
  return {
    activity: leadAct,
    iconKey: activityIconKey(leadAct),
    label,
    detail: '',
    title: fullTitle,
  };
}

/**
 * 聚焦思考的时间线分组引擎：
 * - 每条思考永远直接展现在主时间线上（grouped: false），彻底消除套娃折叠
 * - 单条工具直接单行展示（grouped: false），不套多余外壳
 * - 连续 2 条及以上工具自动聚合成一行可展开的轻量工具胶囊（grouped: true），不把思考冲散
 */
function buildProcessGroups(items, turnIsRunning, displayMode, summaryEnabled) {
  const groups = [];
  let toolBurst = [];

  function flushTools(forceClosed) {
    if (toolBurst.length === 0) return;
    const anyRunning = !forceClosed && toolBurst.some(function (it) { return it.status === 'running'; });
    const closed = !anyRunning;
    const hasError = toolBurst.some(function (it) { return it.status === 'error'; });
    const firstId = toolBurst[0].id || ('t' + groups.length);
    const summary = computeGroupSummary(toolBurst, closed, displayMode, summaryEnabled);
    groups.push({
      key: (toolBurst.length > 1 ? 'tc:' : 'tl:') + firstId,
      kind: toolBurst.length > 1 ? 'tool-cluster' : 'tool',
      grouped: toolBurst.length > 1,
      members: toolBurst,
      closed,
      hasError,
      summary,
    });
    toolBurst = [];
  }

  const list = Array.isArray(items) ? items : [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it) continue;
    if (it.kind === 'reply-boundary') {
      flushTools(true);
      continue;
    }
    if (it.kind === 'think') {
      const hasText = Boolean(String(it.thinking || '').trim());
      if (!hasText && it.status !== 'generating') continue;
      flushTools(true);
      const isLive = it.status === 'generating' && turnIsRunning;
      groups.push({
        key: 'th:' + (it.id || ('k' + groups.length)),
        kind: 'think',
        grouped: false,
        members: [it],
        closed: !isLive,
        hasError: false,
        summary: { counts: [], totalCount: 0, running: isLive ? 'thinking' : undefined, runningDetail: '' },
      });
      continue;
    }
    toolBurst.push(it);
  }
  flushTools(!turnIsRunning);
  return groups;
}

function clipBarText(raw, maxLen) {
  const clean = stripSummaryDecor(raw);
  if (!clean) return '';
  return clean.length > maxLen ? (clean.slice(0, maxLen - 1).trimEnd() + '…') : clean;
}

function isAwaitingFirstZh(item, effectiveMode, settings, activeZh) {
  if (!item || item.kind !== 'think') return false;
  if (effectiveMode === 'raw' || settings?.translateEnabled === false) return false;
  if (activeZh) return false;
  const st = item.translateStatus || '';
  if (st === 'off' || st === 'no-key' || st === 'no-model' || st === 'error') return false;
  return item.status === 'generating' || st === 'translating';
}

function isTurnTranslating(turn, settings) {
  if (!turn || settings?.translateEnabled === false || settings?.displayMode === 'raw') return false;
  const items = Array.isArray(turn.items) ? turn.items : [];
  return items.some(function (it) {
    return it && it.kind === 'think' && it.translateStatus === 'translating';
  });
}

function formatTurnBarLabel(turn, settings, numClass) {
  const mode = settings?.displayMode || 'zh';
  const summaryEnabled = settings?.summaryEnabled === true;
  const items = Array.isArray(turn?.items)
    ? turn.items.filter(function (it) { return it && it.kind !== 'reply-boundary'; })
    : [];
  const totalSteps = items.length;
  const translating = isTurnTranslating(turn, settings);

  let durNum = turn?.durationSec;
  if (turn?.isRunning && turn?.startedAtMs) {
    durNum = Math.max(1, (Date.now() - turn.startedAtMs) / 1000);
  }
  const parts = typeof durNum === 'number' ? formatDurationParts(durNum, Boolean(turn?.isRunning)) : [];
  const durHtml = parts.map(function (p) {
    return p.numeric
      ? ('<span class="' + numClass + '">' + escapeHtml(p.text) + '</span>')
      : escapeHtml(p.text);
  }).join('');
  const durPlain = parts.map(function (p) { return p.text; }).join('');

  function pickThinkSnippet(it, running) {
    const raw = it.thinking || '';
    const zh = it.translatedThinking || '';
    const summaryText = summaryEnabled ? (it.narrativeSummary || '') : '';
    if (isAwaitingFirstZh(it, mode, settings, summaryText || zh)) return '';
    const text = mode !== 'raw'
      ? (summaryText || zh || raw)
      : raw;
    if (!text) return '';
    const steps = parseThinkingSteps(text);
    if (steps && steps.length > 0) {
      const targetStep = running ? steps[steps.length - 1] : steps[0];
      if (targetStep && targetStep.title && targetStep.title !== '思路概览') {
        return clipBarText(targetStep.title, 22);
      }
    }
    return clipBarText(thinkSummary(text, running) || firstLine(text), 22);
  }

  let mainText = '';
  let fullTitle = '';

  if (turn?.isRunning) {
    let activeIdx = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind !== 'think' && items[i].status === 'running') { activeIdx = i; break; }
    }
    if (activeIdx === -1) {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind === 'think' && items[i].status === 'generating') { activeIdx = i; break; }
      }
    }
    if (activeIdx === -1 && translating) {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind === 'think' && items[i].translateStatus === 'translating') { activeIdx = i; break; }
      }
    }

    if (activeIdx !== -1) {
      const cur = items[activeIdx];
      const stepNo = activeIdx + 1;
      if (cur.kind === 'think') {
        const snip = pickThinkSnippet(cur, true);
        mainText = snip ? ('步骤 ' + stepNo + ' · 思考：' + snip) : ('步骤 ' + stepNo + ' · 正在深度思考');
        fullTitle = mainText;
      } else {
        const act = classifyToolActivity(cur);
        const actLabel = STEP_LIVE_LABELS[act] || cur.label || '正在调用工具';
        const rawDetail = cur.liveDetail || cur.summary || cur.toolName || '';
        const detail = clipBarText(rawDetail, 22);
        mainText = detail ? ('步骤 ' + stepNo + ' · ' + actLabel + '：' + detail) : ('步骤 ' + stepNo + ' · ' + actLabel);
        fullTitle = rawDetail ? ('步骤 ' + stepNo + ' · ' + actLabel + '：' + rawDetail) : ('步骤 ' + stepNo + ' · ' + actLabel);
      }
    } else if (totalSteps > 0) {
      mainText = '已完成 ' + totalSteps + ' 步 · 正在继续思考';
      fullTitle = mainText;
    } else {
      mainText = '正在深度思考';
      fullTitle = mainText;
    }
    const html = durHtml ? (escapeHtml(mainText) + ' · ' + durHtml) : (escapeHtml(mainText) + ' ···');
    return { html, title: durPlain ? (fullTitle + ' · ' + durPlain) : fullTitle, active: true };
  }

  if (translating) {
    const distilling = items.some(function (it) { return it.kind === 'think' && it.translatePhase === 'distilling'; });
    const phaseTxt = distilling ? '正在整理思路脉络' : '正在同步中文译文';
    mainText = totalSteps > 0 ? ('共 ' + totalSteps + ' 步 · ' + phaseTxt) : phaseTxt;
    const html = durHtml ? (escapeHtml(mainText) + ' · ' + durHtml) : escapeHtml(mainText);
    return { html, title: durPlain ? (mainText + ' · ' + durPlain) : mainText, active: true };
  }

  if (turn?.hasError) {
    let errIdx = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].status === 'error') { errIdx = i; break; }
    }
    if (errIdx !== -1) {
      const errItem = items[errIdx];
      mainText = '步骤 ' + (errIdx + 1) + ' 异常（' + (errItem.label || '工具调用') + '）';
    } else {
      mainText = totalSteps > 0 ? ('处理异常 · 共 ' + totalSteps + ' 步') : '处理异常';
    }
    const html = durHtml ? (escapeHtml(mainText) + '，用时 ' + durHtml) : escapeHtml(mainText);
    return { html, title: durPlain ? (mainText + '，用时 ' + durPlain) : mainText, active: false };
  }

  let lastDesc = '';
  if (totalSteps > 0) {
    const last = items[totalSteps - 1];
    if (last.kind === 'think') {
      lastDesc = pickThinkSnippet(last, false);
    } else {
      const act = classifyToolActivity(last);
      lastDesc = STEP_DONE_LABELS[act] || last.label || '';
    }
  }
  mainText = totalSteps > 0 ? ('已完成 · 共 ' + totalSteps + ' 步') : '已完成';
  fullTitle = lastDesc ? (mainText + '（最后：' + lastDesc + '）') : mainText;
  const html = durHtml ? (escapeHtml(mainText) + '，用时 ' + durHtml) : escapeHtml(mainText);
  return { html, title: durPlain ? (fullTitle + '，用时 ' + durPlain) : fullTitle, active: false };
}

const COLOR_THEMES = {
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    label: '蓝紫极光 · Gemini 经典三色',
    dark: {
      c1: '77, 163, 255', c2: '155, 114, 203', c3: '232, 121, 168',
      think: '#b392f0', btnFg: '#ffffff',
      icons: { think: '#b392f0', file: '#60a5fa', edit: '#c084fc', cmd: '#2dd4bf', code: '#818cf8', search: '#38bdf8', sub: '#f472b6', plan: '#34d399', tool: '#e879a8' },
    },
    light: {
      c1: '66, 133, 244', c2: '139, 92, 246', c3: '217, 101, 112',
      think: '#7c3aed', btnFg: '#ffffff',
      icons: { think: '#7c3aed', file: '#2563eb', edit: '#9333ea', cmd: '#0d9488', code: '#4f46e5', search: '#0284c7', sub: '#db2777', plan: '#059669', tool: '#e11d48' },
    },
  },
  mono: {
    id: 'mono',
    name: 'Silver',
    label: '极简冷银 · 黑白高对比',
    dark: {
      c1: '241, 245, 249', c2: '176, 190, 210', c3: '118, 132, 154',
      think: '#f1f5f9', btnFg: '#0f172a',
      icons: { think: '#f1f5f9', file: '#cbd5e1', edit: '#e2e8f0', cmd: '#9fc5be', code: '#b8c6e2', search: '#9ac2d6', sub: '#d6c2d2', plan: '#adcbb6', tool: '#94a3b8' },
    },
    light: {
      c1: '30, 41, 59', c2: '71, 85, 105', c3: '120, 136, 160',
      think: '#1e293b', btnFg: '#ffffff',
      icons: { think: '#1e293b', file: '#475569', edit: '#334155', cmd: '#35665e', code: '#425078', search: '#336076', sub: '#6d5168', plan: '#38634a', tool: '#64748b' },
    },
  },
  amber: {
    id: 'amber',
    name: 'Amber',
    label: '暖金琥珀 · 柔和日落',
    dark: {
      c1: '251, 191, 36', c2: '249, 142, 58', c3: '244, 114, 132',
      think: '#fbbf24', btnFg: '#1a1106',
      icons: { think: '#fbbf24', file: '#fcd34d', edit: '#fb923c', cmd: '#a3c96e', code: '#f59e0b', search: '#e6b87c', sub: '#f47284', plan: '#7dd3a0', tool: '#fda4af' },
    },
    light: {
      c1: '217, 119, 6', c2: '234, 88, 12', c3: '225, 75, 102',
      think: '#d97706', btnFg: '#ffffff',
      icons: { think: '#d97706', file: '#b45309', edit: '#ea580c', cmd: '#4d7c0f', code: '#c2410c', search: '#9a6715', sub: '#e11d48', plan: '#15803d', tool: '#be123c' },
    },
  },
  emerald: {
    id: 'emerald',
    name: 'Jade',
    label: '青翠流光 · 清透冷绿',
    dark: {
      c1: '45, 212, 191', c2: '16, 185, 129', c3: '56, 189, 248',
      think: '#2dd4bf', btnFg: '#041d17',
      icons: { think: '#2dd4bf', file: '#38bdf8', edit: '#34d399', cmd: '#a3e635', code: '#67e8f9', search: '#22d3ee', sub: '#6ee7b7', plan: '#4ade80', tool: '#5eead4' },
    },
    light: {
      c1: '13, 148, 136', c2: '5, 150, 105', c3: '2, 132, 199',
      think: '#0d9488', btnFg: '#ffffff',
      icons: { think: '#0d9488', file: '#0284c7', edit: '#059669', cmd: '#4d7c0f', code: '#0891b2', search: '#0369a1', sub: '#0f766e', plan: '#16a34a', tool: '#047857' },
    },
  },
  sakura: {
    id: 'sakura',
    name: 'Sakura',
    label: '柔粉樱紫 · 轻盈绯光',
    dark: {
      c1: '249, 168, 212', c2: '244, 114, 182', c3: '192, 132, 252',
      think: '#f472b6', btnFg: '#240718',
      icons: { think: '#f472b6', file: '#c084fc', edit: '#fb7185', cmd: '#a5b4fc', code: '#e879f9', search: '#f9a8d4', sub: '#fda4af', plan: '#d8b4fe', tool: '#f0abfc' },
    },
    light: {
      c1: '236, 72, 153', c2: '219, 39, 119', c3: '147, 51, 234',
      think: '#db2777', btnFg: '#ffffff',
      icons: { think: '#db2777', file: '#9333ea', edit: '#e11d48', cmd: '#4f46e5', code: '#c026d3', search: '#be185d', sub: '#f43f5e', plan: '#7e22ce', tool: '#a21caf' },
    },
  },
  host: {
    id: 'host',
    name: 'System',
    label: '跟随客户端 · 自动取主题色',
    dark: {
      c1: '148, 163, 184', c2: '186, 198, 218', c3: '125, 145, 174',
      think: '#cbd5e1', btnFg: '#0f172a',
      icons: { think: '#cbd5e1', file: '#93c5fd', edit: '#c4b5fd', cmd: '#5eead4', code: '#a5b4fc', search: '#7dd3fc', sub: '#f9a8d4', plan: '#6ee7b7', tool: '#94a3b8' },
    },
    light: {
      c1: '71, 85, 105', c2: '100, 116, 139', c3: '51, 65, 85',
      think: '#475569', btnFg: '#ffffff',
      icons: { think: '#475569', file: '#2563eb', edit: '#7c3aed', cmd: '#0d9488', code: '#4f46e5', search: '#0284c7', sub: '#db2777', plan: '#059669', tool: '#64748b' },
    },
  },
};

function clampRgb(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToRgb(h, s, l) {
  const hn = (((h % 360) + 360) % 360) / 360;
  const sn = Math.max(0, Math.min(100, s)) / 100;
  const ln = Math.max(0, Math.min(100, l)) / 100;
  if (sn === 0) {
    const v = clampRgb(ln * 255);
    return [v, v, v];
  }
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const hue2rgb = function (t) {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [clampRgb(hue2rgb(hn + 1 / 3) * 255), clampRgb(hue2rgb(hn) * 255), clampRgb(hue2rgb(hn - 1 / 3) * 255)];
}

function hslToCss(h, s, l) {
  const rgb = hslToRgb(h, s, l);
  return 'rgb(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ')';
}

function resolveColorThemePalette(themeId, isLight, hostAccentRgb) {
  const mode = isLight ? 'light' : 'dark';
  if (themeId === 'host' && Array.isArray(hostAccentRgb) && hostAccentRgb.length >= 3) {
    const base = [clampRgb(hostAccentRgb[0]), clampRgb(hostAccentRgb[1]), clampRgb(hostAccentRgb[2])];
    const [h, sRaw, lRaw] = rgbToHsl(base[0], base[1], base[2]);
    const s = sRaw < 12 ? 16 : Math.min(82, Math.max(46, sRaw));
    const lMain = isLight ? Math.min(46, Math.max(34, lRaw)) : Math.min(72, Math.max(58, lRaw));
    const c1Arr = hslToRgb(h - 24, Math.min(88, s + 6), isLight ? lMain + 4 : lMain + 6);
    const c2Arr = hslToRgb(h, s, lMain);
    const c3Arr = hslToRgb(h + 28, Math.min(86, s + 4), isLight ? lMain - 2 : lMain + 2);
    const toStr = function (a) { return a[0] + ', ' + a[1] + ', ' + a[2]; };
    const lum2 = (0.2126 * c2Arr[0] + 0.7152 * c2Arr[1] + 0.0722 * c2Arr[2]) / 255;
    const icoS = sRaw < 12 ? 26 : Math.min(76, Math.max(48, s));
    const icoL = isLight ? 40 : 70;
    return {
      c1: toStr(c1Arr),
      c2: toStr(c2Arr),
      c3: toStr(c3Arr),
      think: 'rgb(' + toStr(c2Arr) + ')',
      btnFg: lum2 > 0.56 ? '#0f172a' : '#ffffff',
      icons: {
        think: hslToCss(h, icoS, icoL),
        file: hslToCss(h - 34, icoS, icoL + (isLight ? -2 : 2)),
        edit: hslToCss(h + 24, icoS, icoL),
        cmd: hslToCss(h + 112, Math.max(42, icoS - 6), icoL - (isLight ? 2 : 0)),
        code: hslToCss(h - 58, icoS, icoL + (isLight ? -1 : 3)),
        search: hslToCss(h - 14, Math.min(84, icoS + 6), icoL + (isLight ? 0 : 4)),
        sub: hslToCss(h + 52, icoS, icoL + (isLight ? -1 : 2)),
        plan: hslToCss(h + 84, Math.max(44, icoS - 4), icoL - (isLight ? 2 : 1)),
        tool: hslToCss(h + 32, icoS, icoL),
      },
    };
  }
  const entry = COLOR_THEMES[themeId] || COLOR_THEMES.gemini;
  return entry[mode] || entry.dark;
}

const ICONS = {
  star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L14.4 9.6L22 12L14.4 14.4L12 22L9.6 14.4L2 12L9.6 9.6L12 2Z"/></svg>',
  think: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M2.5 12h3M18.5 12h3M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>',
  read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8.5Z"/><polyline points="14 2.5 14 8.5 19.5 8.5"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8.5Z"/><polyline points="14 2.5 14 8.5 19.5 8.5"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  cmd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3.5"/><polyline points="7.5 10 10.5 12.5 7.5 15"/><line x1="12.5" y1="15" x2="16.5" y2="15"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.8"/><line x1="20" y1="20" x2="16" y2="16"/></svg>',
  webSearch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18"/></svg>',
  webFetch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  subagents: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3 19.5a6 6 0 0 1 12 0"/><circle cx="17.5" cy="9.5" r="2.4"/><path d="M16 19.5h5a4.5 4.5 0 0 0-4.2-4.5"/></svg>',
  plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><polyline points="4 6 5.2 7.2 7 5"/><polyline points="4 12 5.2 13.2 7 11"/><polyline points="4 18 5.2 19.2 7 17"/></svg>',
  questions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 0 1 5 .8c0 1.8-2.5 2.2-2.5 3.8"/><circle cx="12" cy="17.2" r="0.6" fill="currentColor"/></svg>',
  tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3L14.5 9.5L21 12L14.5 14.5L12 21L9.5 14.5L3 12L9.5 9.5Z"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  chevDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  chevUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>',
};
`;

export function buildSharedBrowserScript() {
  return `(() => {\n${SHARED_RENDER_SOURCE}\nwindow.__agyThinkingShared = { escapeHtml, formatInline, renderMarkdown, parseThinkingSteps, countThinkingSteps, renderThinkingSteps, firstLine, latestCompletedParagraphFirstLine, latestParagraphFirstLine, thinkSummary, shortModelName, formatDurationHuman, formatDurationParts, getPresentationPolicy, classifyToolActivity, activityIconKey, buildProcessGroups, formatProcessGroupTitle, isAwaitingFirstZh, isTurnTranslating, formatTurnBarLabel, COLOR_THEMES, resolveColorThemePalette, ICONS };\n})();\n`;
}

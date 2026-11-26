/**
 * 侧边栏 UI 与内嵌 Shadow DOM 共用的纯渲染辅助函数与图标，
 * 避免两处复制粘贴导致 Markdown 解析或摘要逻辑漂移。
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
  out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\\*([^\\s*][^*]*?)\\*(?!\\*)/g, '$1<em>$2</em>');
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
  text = text.replace(/\`\`\`[^\\n]*\\n([\\s\\S]*?)\`\`\`/g, function (_m, code) {
    const idx = codeBlocks.length;
    codeBlocks.push('<pre><code>' + escapeHtml(code.replace(/\\n$/, '')) + '</code></pre>');
    return '\\n\\u0000CB_' + idx + '\\u0000\\n';
  });
  // 流式未闭合代码块兜底渲染，避免半截代码被当普通段落乱切
  text = text.replace(/\`\`\`[^\\n]*\\n([\\s\\S]+)$/, function (_m, code) {
    const idx = codeBlocks.length;
    codeBlocks.push('<pre><code>' + escapeHtml(code.replace(/\\n$/, '')) + '</code></pre>');
    return '\\n\\u0000CB_' + idx + '\\u0000\\n';
  });

  const lines = text.split('\\n');
  const out = [];
  let listType = '';
  let listItems = [];
  let quoteLines = [];
  let paraLines = [];

  function flushPara() {
    if (paraLines.length > 0) {
      out.push('<p>' + paraLines.map(formatInline).join('<br>') + '</p>');
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

    const headMatch = trimmed.match(/^(#{1,4})\\s+(.+)$/);
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

function firstLine(text) {
  const lines = String(text || '').split(/\\r?\\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function latestParagraphFirstLine(text) {
  let summary = '';
  let start = 0;
  const sep = /\\r?\\n(?:[\\t ]*\\r?\\n)+/g;
  while (true) {
    const next = sep.exec(text);
    const end = next === null ? text.length : next.index + next[0].indexOf('\\n');
    const nl = text.indexOf('\\n', start);
    if (nl !== -1 && nl <= end) {
      const cand = text.slice(start, nl).trim();
      if (cand) summary = cand;
    } else if (next === null) {
      const tail = text.slice(start).trim();
      if (tail) summary = firstLine(tail);
    }
    if (next === null) return summary || firstLine(text);
    start = next.index + next[0].length;
  }
}

function thinkSummary(text, running) {
  const line = running ? latestParagraphFirstLine(text) : firstLine(text);
  return line
    .replace(/^#{1,6}\\s+/, '')
    .replace(/^[-*+]\\s+/, '')
    .replace(/\\*\\*/g, '')
    .replace(/\`/g, '')
    .trim() || '正在整理思路…';
}

function shortModelName(model) {
  if (!model) return '';
  if (model === 'cache') return '缓存';
  if (model === 'native-zh') return '原生中文';
  const parts = String(model).split('/');
  return parts[parts.length - 1] || model;
}

const ICONS = {
  star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L14.4 9.6L22 12L14.4 14.4L12 22L9.6 14.4L2 12L9.6 9.6L12 2Z"/></svg>',
  think: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M2 12h3M19 12h3M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12"/></svg>',
  cmd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.2" y2="16.2"/></svg>',
  tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.2 5.3L19.5 10l-5.3 1.7L12 17l-2.2-5.3L4.5 10l5.3-1.7Z"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
};
`;

export function buildSharedBrowserScript() {
  return `(() => {\n${SHARED_RENDER_SOURCE}\nwindow.__agyThinkingShared = { escapeHtml, formatInline, renderMarkdown, firstLine, latestParagraphFirstLine, thinkSummary, shortModelName, ICONS };\n})();\n`;
}

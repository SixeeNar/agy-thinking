import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { SHARED_RENDER_SOURCE } from './shared_render.mjs';

const PORT_FILE =
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort')
    : process.platform === 'win32'
      ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity', 'DevToolsActivePort')
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Antigravity', 'DevToolsActivePort');

const INSTANCE_TS = Date.now();

function sampleTextSig(str) {
  if (!str) return '0';
  return `${str.length}:${str.slice(0, 16)}:${str.slice(-24)}`;
}

function computeSlimSignature(slimData, publicSettings) {
  let sig = `${slimData.activeId}|${slimData.activeStatus}|${slimData.isGenerating}|${JSON.stringify(publicSettings)}|`;
  for (const turn of slimData.turns || []) {
    sig += `${turn.turnIndex}:${turn.items.length}:${turn.isRunning}:${turn.durationSec ?? ''}:`;
    for (const item of turn.items || []) {
      const len = item.kind === 'think' ? (item.thinking?.length || 0) : (item.detail?.length || 0);
      const tSig = sampleTextSig(item.translatedThinking);
      sig += `${item.id}/${item.status}/${len}/${tSig}/${item.translateStatus || ''}/${item.translateModel || ''}/${item.translateError || ''}/${item.thinkingTokens || 0}/${item.durationSec ?? ''};`;
    }
  }
  return sig;
}

function getClientBundle(owner) {
  const code = `(() => {
    const OWNER = ${owner};
    if (globalThis.__agyThinkingInline && globalThis.__agyThinkingInline.owner > OWNER) {
      return 'superseded';
    }
    if (globalThis.__agyThinkingInline && globalThis.__agyThinkingInline.owner === OWNER) {
      return true;
    }
    globalThis.__agyThinkingInline?.dispose?.();

    const openState = new Map();
    const userPinnedSet = new Set();
    const rawOverrideMap = new Map();
    const expandedFullMap = new Map();
    const streamShownMap = new Map(); // stepKey -> { text, shownLen, modeKey, stepEl, item, effectiveMode }
    const turnSettledMap = new Map();
    const pendingActions = [];
    let lastActiveConvId = '';
    let streamRaf = 0;
    let lastStreamTickAt = 0;
    let timerHandle = null;
    let lastData = null;
    let lastSettings = null;

    ${SHARED_RENDER_SOURCE}

    function detectTheme() {
      const bg = getComputedStyle(document.body).backgroundColor || '';
      const m = bg.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/i);
      if (!m) return 'dark';
      const lum = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
      return lum < 0.5 ? 'dark' : 'light';
    }

    function detectConversationId() {
      const pathMatch = location.pathname.match(/\\/c\\/([0-9a-f-]{36})/i);
      if (pathMatch) return pathMatch[1];
      const row = document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"]');
      const cid = row?.getAttribute('data-cascade-id');
      return cid || '';
    }

    const SHADOW_CSS = \`
      :host {
        display: block;
        margin: 4px 0 10px;
        font-family: "PingFang SC", "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif;
        --xx-fg: rgba(240, 244, 255, 0.94);
        --xx-muted: rgba(182, 196, 224, 0.82);
        --xx-dim: rgba(146, 165, 200, 0.62);
        --xx-surface: rgba(77, 163, 255, 0.048);
        --xx-surface-hover: rgba(155, 114, 203, 0.095);
        --xx-card: rgba(14, 19, 34, 0.56);
        --xx-border: rgba(138, 174, 242, 0.14);
        --xx-border-strong: rgba(155, 114, 203, 0.42);
        --xx-line: rgba(138, 174, 242, 0.24);
        --xx-code-bg: rgba(7, 10, 20, 0.42);
        --xx-accent: #4da3ff;
        --xx-accent-mid: #9b72cb;
        --xx-accent-2: #e879a8;
        --xx-think: #9b72cb;
        --xx-cmd: #34d399;
        --xx-file: #60a5fa;
        --xx-search: #38bdf8;
        --xx-tool: #f59e0b;
        --xx-err: #fb7185;
      }
      .xx-wrap[data-theme="light"] {
        --xx-fg: rgba(15, 23, 42, 0.92);
        --xx-muted: rgba(68, 84, 116, 0.86);
        --xx-dim: rgba(100, 116, 148, 0.72);
        --xx-surface: rgba(66, 133, 244, 0.045);
        --xx-surface-hover: rgba(139, 92, 246, 0.085);
        --xx-card: rgba(255, 255, 255, 0.82);
        --xx-border: rgba(66, 133, 244, 0.14);
        --xx-border-strong: rgba(139, 92, 246, 0.36);
        --xx-line: rgba(66, 133, 244, 0.2);
        --xx-code-bg: rgba(66, 133, 244, 0.06);
        --xx-accent: #4285f4;
        --xx-accent-mid: #8b5cf6;
        --xx-accent-2: #d96570;
        --xx-think: #7c3aed;
        --xx-cmd: #059669;
        --xx-file: #2563eb;
        --xx-search: #0284c7;
        --xx-tool: #d97706;
        --xx-err: #e11d48;
      }
      .xx-wrap, .xx-wrap * { box-sizing: border-box; }
      .xx-wrap {
        color: var(--xx-fg);
        font-size: 13px;
        line-height: 1.58;
      }
      .xx-wrap[data-font="sm"] { font-size: 12px; }
      .xx-wrap[data-font="sm"] .xx-think-md { font-size: 11.8px; line-height: 1.56; }
      .xx-wrap[data-font="lg"] { font-size: 14px; }
      .xx-wrap[data-font="lg"] .xx-think-md { font-size: 13.5px; line-height: 1.68; }
      .xx-wrap[data-compact="true"] .xx-steps { gap: 1px; margin: 4px 0 2px 10px; padding-left: 10px; }
      .xx-wrap[data-compact="true"] .xx-step-head { min-height: 24px; padding: 2px 7px; }
      .xx-wrap[data-compact="true"] .xx-step-body { padding: 2px 10px 8px 24px; }
      .xx-turn-bar {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        max-width: 100%;
        padding: 4px 12px 4px 9px;
        border-radius: 999px;
        border: 1px solid var(--xx-border);
        background: linear-gradient(135deg, rgba(255, 255, 255, 0.042), rgba(255, 255, 255, 0.018));
        color: var(--xx-muted);
        font: inherit;
        font-size: 12.2px;
        cursor: pointer;
        user-select: none;
        transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease, box-shadow 0.16s ease, transform 0.12s ease;
      }
      .xx-wrap[data-theme="light"] .xx-turn-bar {
        background: linear-gradient(135deg, rgba(15, 23, 42, 0.036), rgba(15, 23, 42, 0.014));
      }
      .xx-turn-bar:hover {
        background: var(--xx-surface-hover);
        border-color: var(--xx-border-strong);
        color: var(--xx-fg);
      }
      .xx-turn-bar:active { transform: scale(0.99); }
      .xx-wrap[data-turn-open="true"] .xx-turn-bar {
        background: var(--xx-surface);
        border-color: var(--xx-border);
        color: var(--xx-fg);
      }
      .xx-wrap[data-running="true"] .xx-turn-bar {
        border-color: var(--xx-border-strong);
        box-shadow: 0 0 0 1px rgba(139, 92, 246, 0.12), 0 4px 16px -6px rgba(139, 92, 246, 0.25);
      }
      .xx-turn-star {
        width: 12px;
        height: 12px;
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #22c55e;
        opacity: 0.85;
      }
      .xx-wrap[data-running="true"] .xx-turn-star {
        color: var(--xx-think);
        opacity: 1;
        animation: xx-star-pulse 1.5s ease-in-out infinite;
      }
      @keyframes xx-star-pulse {
        0%, 100% { transform: scale(1) rotate(0deg); opacity: 1; }
        50% { transform: scale(0.84) rotate(45deg); opacity: 0.55; }
      }
      .xx-turn-chev {
        width: 13px;
        height: 13px;
        flex: 0 0 auto;
        transition: transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
        opacity: 0.72;
      }
      .xx-wrap[data-turn-open="true"] .xx-turn-chev { transform: rotate(90deg); }
      .xx-turn-label { font-weight: 500; white-space: nowrap; }
      .xx-wrap[data-running="true"] .xx-turn-label {
        background: linear-gradient(90deg, var(--xx-accent) 0%, var(--xx-accent-mid) 45%, var(--xx-accent-2) 75%, var(--xx-accent) 100%);
        background-size: 220% auto;
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
        animation: xx-shimmer 2.1s linear infinite;
      }
      @keyframes xx-shimmer { to { background-position: 220% center; } }
      .xx-turn-counts { font-size: 11.5px; color: var(--xx-dim); white-space: nowrap; }

      /* 平滑 Grid 折叠容器 */
      .xx-steps-shell {
        display: grid;
        grid-template-rows: 0fr;
        opacity: 0;
        transition: grid-template-rows 0.2s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.18s ease;
      }
      .xx-wrap[data-turn-open="true"] .xx-steps-shell {
        grid-template-rows: 1fr;
        opacity: 1;
      }
      .xx-steps-inner { overflow: hidden; }
      .xx-steps {
        margin: 6px 0 4px 12px;
        padding: 2px 0 2px 12px;
        border-left: 1.5px solid var(--xx-line);
        display: flex;
        flex-direction: column;
        gap: 3px;
      }

      .xx-step {
        border-radius: 10px;
        border: 1px solid transparent;
        transition: background 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
      }
      .xx-step[data-open="true"] {
        background: linear-gradient(180deg, var(--xx-surface), var(--xx-card));
        border-color: var(--xx-border);
        box-shadow: 0 2px 10px -4px rgba(0, 0, 0, 0.22);
        margin: 3px 0;
      }
      .xx-wrap[data-theme="light"] .xx-step[data-open="true"] {
        box-shadow: 0 2px 10px -6px rgba(15, 23, 42, 0.12);
      }
      .xx-step[data-open="true"][data-running="true"] {
        border-color: var(--xx-border-strong);
        box-shadow: 0 0 0 1px rgba(139, 92, 246, 0.1), 0 4px 16px -6px rgba(139, 92, 246, 0.24);
      }
      .xx-step-head {
        display: flex;
        align-items: center;
        gap: 7px;
        width: 100%;
        min-height: 28px;
        padding: 4px 9px;
        border: none;
        border-radius: 9px;
        background: transparent;
        color: var(--xx-muted);
        font: inherit;
        font-size: 12.4px;
        text-align: left;
        cursor: pointer;
        user-select: none;
        transition: background 0.14s ease, color 0.14s ease;
      }
      .xx-step-head:hover { background: var(--xx-surface-hover); color: var(--xx-fg); }
      .xx-step[data-open="true"] .xx-step-head {
        padding-bottom: 3px;
      }
      .xx-step[data-kind="think"][data-open="true"][data-hide-sum="true"] .xx-step-sep {
        display: none;
      }
      .xx-step[data-kind="think"][data-open="true"][data-hide-sum="true"] .xx-step-sum {
        height: 0;
        overflow: hidden;
        color: transparent;
        user-select: none;
        pointer-events: none;
      }

      .xx-step-ico {
        width: 14px;
        height: 14px;
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--xx-dim);
      }
      .xx-step[data-kind="think"] .xx-step-ico { color: var(--xx-think); }
      .xx-step[data-kind="cmd"] .xx-step-ico { color: var(--xx-cmd); }
      .xx-step[data-kind="file"] .xx-step-ico { color: var(--xx-file); }
      .xx-step[data-kind="search"] .xx-step-ico { color: var(--xx-search); }
      .xx-step[data-kind="tool"] .xx-step-ico { color: var(--xx-tool); }
      .xx-step[data-status="error"] .xx-step-ico { color: var(--xx-err); }
      .xx-step[data-running="true"] .xx-step-ico { animation: xx-spin 2.2s linear infinite; }
      @keyframes xx-spin { to { transform: rotate(360deg); } }

      .xx-step-kind {
        flex: 0 0 auto;
        font-weight: 500;
        color: var(--xx-fg);
        opacity: 0.92;
        white-space: nowrap;
      }
      .xx-step-sep { width: 2.5px; height: 2.5px; border-radius: 50%; background: var(--xx-dim); flex: 0 0 auto; }
      .xx-step-sum {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        color: var(--xx-muted);
      }
      .xx-step[data-running="true"] .xx-step-sum {
        text-overflow: clip;
        -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 40px), transparent);
        mask-image: linear-gradient(to right, #000 calc(100% - 40px), transparent);
      }
      .xx-step-time {
        flex: 0 0 auto;
        font-size: 11px;
        color: var(--xx-dim);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .xx-step-chev {
        width: 12px;
        height: 12px;
        flex: 0 0 auto;
        color: var(--xx-dim);
        transition: transform 0.16s ease;
      }
      .xx-step[data-open="true"] .xx-step-chev { transform: rotate(90deg); }

      .xx-step-body-shell {
        display: grid;
        grid-template-rows: 0fr;
        transition: grid-template-rows 0.18s cubic-bezier(0.22, 1, 0.36, 1);
      }
      .xx-step[data-open="true"] .xx-step-body-shell { grid-template-rows: 1fr; }
      .xx-step-body-inner { overflow: hidden; }
      .xx-step-body { padding: 4px 12px 10px 28px; }

      .xx-think-md {
        padding-left: 12px;
        border-left: 2px solid var(--xx-line);
        color: var(--xx-fg);
        opacity: 0.9;
        font-size: 12.6px;
        line-height: 1.66;
        word-break: break-word;
        user-select: text;
      }
      .xx-wrap[data-think-height="sm"] .xx-step:not([data-full="true"]) .xx-think-md {
        max-height: 220px;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding-right: 6px;
      }
      .xx-wrap[data-think-height="md"] .xx-step:not([data-full="true"]) .xx-think-md {
        max-height: 360px;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding-right: 6px;
      }
      .xx-think-md::-webkit-scrollbar { width: 4px; }
      .xx-think-md::-webkit-scrollbar-thumb { background: rgba(138, 174, 242, 0.28); border-radius: 999px; }
      .xx-think-md::-webkit-scrollbar-track { background: transparent; }
      .xx-step[data-running="true"] .xx-think-md {
        border-left-color: transparent;
        border-image: linear-gradient(180deg, var(--xx-accent), var(--xx-accent-mid), var(--xx-accent-2)) 1;
      }
      .xx-think-md p { margin: 0 0 9px; }
      .xx-think-md p:last-child { margin-bottom: 0; }
      .xx-expand-bar {
        display: none;
        align-items: center;
        justify-content: center;
        margin-top: 6px;
      }
      .xx-wrap:not([data-think-height="full"]) .xx-step[data-overflow="true"] .xx-expand-bar,
      .xx-wrap:not([data-think-height="full"]) .xx-step[data-full="true"] .xx-expand-bar {
        display: flex;
      }
      .xx-expand-full-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 11px;
        border-radius: 999px;
        border: 1px solid var(--xx-border);
        background: var(--xx-surface);
        color: var(--xx-muted);
        font: inherit;
        font-size: 11px;
        cursor: pointer;
        transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
      }
      .xx-expand-full-btn:hover {
        background: var(--xx-surface-hover);
        border-color: var(--xx-border-strong);
        color: var(--xx-fg);
      }
      .xx-think-md .md-h { margin: 8px 0 4px; font-size: 12.5px; font-weight: 600; color: var(--xx-fg); }
      .xx-think-md .md-h:first-child { margin-top: 0; }
      .xx-think-md hr { border: none; border-top: 1px solid var(--xx-border); margin: 7px 0; }
      .xx-think-md strong { color: var(--xx-fg); font-weight: 600; }
      .xx-think-md code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11.5px;
        padding: 1px 5px;
        border-radius: 4px;
        background: var(--xx-code-bg);
        color: var(--xx-fg);
      }
      .xx-think-md pre, .xx-detail-pre {
        margin: 5px 0 0;
        padding: 8px 10px;
        border-radius: 7px;
        background: var(--xx-code-bg);
        overflow-x: auto;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11.5px;
        line-height: 1.5;
        color: var(--xx-fg);
        user-select: text;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .xx-think-md ul, .xx-think-md ol { margin: 4px 0 7px; padding-left: 18px; }
      .xx-think-md li { margin-bottom: 2px; }
      .xx-think-md blockquote { margin: 5px 0; padding-left: 9px; border-left: 2px solid var(--xx-border); opacity: 0.88; }

      .xx-cursor {
        display: inline-block;
        width: 5px;
        height: 13px;
        margin-left: 3px;
        vertical-align: -2px;
        border-radius: 2px;
        background: linear-gradient(180deg, var(--xx-accent), var(--xx-accent-2));
        animation: xx-blink 0.85s steps(2, start) infinite;
      }
      @keyframes xx-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.15; } }

      .xx-step-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 7px;
        font-size: 11px;
        color: var(--xx-dim);
      }
      .xx-foot-meta { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 5px; }
      .xx-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--xx-surface);
        border: 1px solid var(--xx-border);
        font-size: 10.5px;
        color: var(--xx-muted);
      }
      .xx-chip.live { color: var(--xx-think); border-color: var(--xx-border-strong); }
      .xx-chip.err { color: var(--xx-err); border-color: rgba(248, 113, 113, 0.35); }
      .xx-foot-actions { display: inline-flex; align-items: center; gap: 5px; }
      .xx-bilingual-raw {
        margin-top: 8px;
        padding-top: 7px;
        border-top: 1px dashed var(--xx-border);
        font-size: 11.5px;
        opacity: 0.72;
      }
      .xx-btn {
        padding: 1px 7px;
        border-radius: 5px;
        border: 1px solid var(--xx-border);
        background: transparent;
        color: var(--xx-muted);
        font-size: 11px;
        cursor: pointer;
        transition: background 0.14s ease, color 0.14s ease;
      }
      .xx-btn:hover { background: var(--xx-surface-hover); color: var(--xx-fg); }
    \`;

    function getTurnOpen(turnKey, turn, isLastTurn, settings) {
      if (openState.has(turnKey)) return openState.get(turnKey);
      if (turn.isRunning && settings.autoExpandRunningTurn !== false) {
        openState.set(turnKey, true);
        return true;
      }
      if (isLastTurn) {
        openState.set(turnKey, true);
        return true;
      }
      if (!turn.isRunning && settings.autoCollapseDoneTurn) return false;
      return false;
    }

    function getStepOpen(stepKey, item, settings) {
      if (openState.has(stepKey)) return openState.get(stepKey);
      const isLiveThink =
        item.kind === 'think' &&
        (item.status === 'generating' || item.translateStatus === 'translating') &&
        settings.autoExpandRunningThink !== false;
      if (isLiveThink) {
        openState.set(stepKey, true);
        return true;
      }
      return false;
    }

    function getBubblePromptForResponse(resp) {
      const turnEl = resp.closest('[data-turn-content]') || resp.parentElement?.parentElement;
      const bubble =
        turnEl?.querySelector('.agy-user-bubble') ||
        turnEl?.previousElementSibling?.querySelector?.('.agy-user-bubble');
      return (bubble?.innerText || '').replace(/\\s+/g, ' ').trim();
    }

    function pairResponsesToTurns(responses, turns) {
      if (responses.length === turns.length) {
        return responses.map((resp, i) => ({ resp, turn: turns[i] }));
      }
      const paired = new Array(responses.length);
      let cursor = turns.length - 1;
      for (let i = responses.length - 1; i >= 0; i--) {
        const bubbleTxt = getBubblePromptForResponse(responses[i]);
        let matched = null;
        if (bubbleTxt) {
          const prefix = bubbleTxt.slice(0, 22);
          for (let j = cursor; j >= 0; j--) {
            const p = (turns[j].prompt || '').replace(/\\s+/g, ' ').trim();
            if (p && (p.startsWith(prefix) || bubbleTxt.startsWith(p.slice(0, 22)))) {
              matched = turns[j];
              cursor = j - 1;
              break;
            }
          }
        }
        if (!matched && cursor >= 0) matched = turns[cursor--];
        paired[i] = { resp: responses[i], turn: matched };
      }
      return paired;
    }

    function formatTurnHeader(turn) {
      let dur = turn.durationSec;
      if (turn.isRunning && turn.startedAtMs) {
        dur = Math.max(0, (Date.now() - turn.startedAtMs) / 1000).toFixed(1);
      } else if (typeof dur === 'number') {
        dur = dur.toFixed(1);
      }
      const label = turn.isRunning
        ? (dur != null ? '实时思考中 · ' + dur + 's' : '实时思考中…')
        : (dur != null ? '思考完成 · ' + dur + 's' : '思考完成');
      const parts = [];
      if (turn.thinkCount > 0) parts.push(turn.thinkCount + ' 思考');
      if (turn.toolCount > 0) parts.push(turn.toolCount + ' 步骤');
      return { label, counts: parts.join(' · ') };
    }

    function buildFootChips(item, running) {
      const chips = [];
      if (item.thinkingTokens > 0) {
        chips.push('<span class="xx-chip">' + item.thinkingTokens + ' tok</span>');
      } else if (running) {
        chips.push('<span class="xx-chip live">流式思考中</span>');
      }
      if (item.translateStatus === 'translating') {
        chips.push('<span class="xx-chip live">实时译中</span>');
      } else if (item.translateStatus === 'no-key') {
        chips.push('<span class="xx-chip">待填翻译 Key</span>');
      } else if (item.translateStatus === 'error') {
        chips.push('<span class="xx-chip err" title="' + escapeHtml(item.translateError || '') + '">翻译异常</span>');
      } else if (item.translateModel) {
        chips.push('<span class="xx-chip">' + escapeHtml(shortModelName(item.translateModel)) + '</span>');
      }
      return chips.join('');
    }

    function syncThinkOverflow(stepEl, mdEl) {
      if (!stepEl || !mdEl) return;
      const isFull = stepEl.dataset.full === 'true';
      const hasOverflow = !isFull && mdEl.scrollHeight > mdEl.clientHeight + 8;
      stepEl.dataset.overflow = String(hasOverflow);
      const btn = stepEl.querySelector('.xx-expand-full-btn');
      if (btn) btn.textContent = isFull ? '收起高度' : '展开全文';
    }

    function updateStepThinkDisplay(stepEl, displayText, item, effectiveMode, running, isStreamingThink) {
      const sumEl = stepEl.querySelector('.xx-step-sum');
      const nextSum = thinkSummary(displayText || item.translatedThinking || item.thinking || '', isStreamingThink);
      if (sumEl && sumEl.textContent !== nextSum) sumEl.textContent = nextSum;

      if (stepEl.dataset.open !== 'true') return;
      const mdEl = stepEl.querySelector('.xx-think-md');
      if (!mdEl) return;

      const rawText = item.thinking || '';
      const zhText = item.translatedThinking || '';
      const cursor = isStreamingThink ? '<span class="xx-cursor"></span>' : '';
      const bilingualExtra =
        effectiveMode === 'bilingual' && zhText && zhText !== rawText
          ? '<div class="xx-bilingual-raw">' + renderMarkdown(rawText) + '</div>'
          : '';
      const mdHtml = (renderMarkdown(displayText) || '<p>正在酝酿思路…</p>') + cursor + bilingualExtra;
      if (mdEl._lastHtml !== mdHtml) {
        const nearBottom = mdEl.scrollHeight - mdEl.scrollTop - mdEl.clientHeight < 48;
        mdEl._lastHtml = mdHtml;
        mdEl.innerHTML = mdHtml;
        if (isStreamingThink && nearBottom && stepEl.dataset.full !== 'true') {
          mdEl.scrollTop = mdEl.scrollHeight;
        }
        syncThinkOverflow(stepEl, mdEl);
      }
    }

    function renderTurnIntoHost(host, turn, isLastTurn, settings, theme) {
      let shadow = host.shadowRoot;
      if (!shadow) {
        shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML =
          '<style>' + SHADOW_CSS + '</style>' +
          '<div class="xx-wrap">' +
            '<button class="xx-turn-bar" type="button"></button>' +
            '<div class="xx-steps-shell"><div class="xx-steps-inner"><div class="xx-steps"></div></div></div>' +
          '</div>';
        const wrap = shadow.querySelector('.xx-wrap');
        const bar = shadow.querySelector('.xx-turn-bar');
        const stepsBox = shadow.querySelector('.xx-steps');

        bar.addEventListener('click', () => {
          const key = host.dataset.turnKey;
          const next = wrap.dataset.turnOpen !== 'true';
          openState.set(key, next);
          userPinnedSet.add(key);
          wrap.dataset.turnOpen = String(next);
        });

        stepsBox.addEventListener('click', async (ev) => {
          const retryBtn = ev.target.closest('.xx-retry-btn');
          if (retryBtn) {
            const stepEl = retryBtn.closest('.xx-step');
            const item = stepEl?._itemData;
            if (item) {
              pendingActions.push({ type: 'retry', itemId: item.id, rawText: item.thinking || '' });
              retryBtn.textContent = '重译中…';
              setTimeout(() => { if (retryBtn.isConnected) retryBtn.textContent = '重译'; }, 1200);
            }
            return;
          }
          const toggleLangBtn = ev.target.closest('.xx-toggle-lang');
          if (toggleLangBtn) {
            const stepEl = toggleLangBtn.closest('.xx-step');
            const key = stepEl.dataset.stepKey;
            const cur = rawOverrideMap.get(key) === true;
            rawOverrideMap.set(key, !cur);
            streamShownMap.delete(key);
            stepEl.dataset.bodySig = '';
            stepEl.dataset.headSig = '';
            renderAll();
            return;
          }
          const expandBtn = ev.target.closest('.xx-expand-full-btn');
          if (expandBtn) {
            const stepEl = expandBtn.closest('.xx-step');
            const key = stepEl.dataset.stepKey;
            const nextFull = stepEl.dataset.full !== 'true';
            expandedFullMap.set(key, nextFull);
            stepEl.dataset.full = String(nextFull);
            const mdEl = stepEl.querySelector('.xx-think-md');
            syncThinkOverflow(stepEl, mdEl);
            return;
          }
          const copyBtn = ev.target.closest('.xx-copy-btn');
          if (copyBtn) {
            const stepEl = copyBtn.closest('.xx-step');
            const raw = stepEl?._copyText || '';
            try {
              await navigator.clipboard.writeText(raw);
              copyBtn.textContent = '已复制';
              setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = '复制'; }, 1200);
            } catch {}
            return;
          }
          const head = ev.target.closest('.xx-step-head');
          if (!head) return;
          const stepEl = head.closest('.xx-step');
          const key = stepEl.dataset.stepKey;
          const next = stepEl.dataset.open !== 'true';
          openState.set(key, next);
          stepEl.dataset.open = String(next);
          if (next && stepEl._renderBody) {
            stepEl._renderBody();
            setTimeout(() => {
              if (stepEl.isConnected && stepEl.dataset.open === 'true') {
                syncThinkOverflow(stepEl, stepEl.querySelector('.xx-think-md'));
              }
            }, 210);
          }
        });
      }

      const turnKey = (lastData?.activeId || 'conv') + ':turn:' + turn.turnIndex;
      host.dataset.turnKey = turnKey;
      host._turnData = turn;

      const wrap = shadow.querySelector('.xx-wrap');
      const bar = shadow.querySelector('.xx-turn-bar');
      const stepsBox = shadow.querySelector('.xx-steps');

      wrap.dataset.theme = theme;
      wrap.dataset.running = String(Boolean(turn.isRunning));
      wrap.dataset.compact = String(Boolean(settings.compactMode));
      wrap.dataset.font = settings.fontSize || 'md';
      wrap.dataset.thinkHeight = settings.thinkHeightMode || 'md';

      if (
        settings.autoCollapseDoneTurn &&
        !turn.isRunning &&
        !isLastTurn &&
        !userPinnedSet.has(turnKey) &&
        !turnSettledMap.has(turnKey)
      ) {
        turnSettledMap.set(turnKey, true);
        openState.set(turnKey, false);
      }

      wrap.dataset.turnOpen = String(Boolean(getTurnOpen(turnKey, turn, isLastTurn, settings)));

      const hdr = formatTurnHeader(turn);
      const barSig = hdr.counts;
      if (bar.dataset.sig !== barSig) {
        bar.dataset.sig = barSig;
        bar.innerHTML =
          '<span class="xx-turn-star">' + ICONS.star + '</span>' +
          '<span class="xx-turn-label"></span>' +
          (hdr.counts ? '<span class="xx-turn-counts">· ' + escapeHtml(hdr.counts) + '</span>' : '') +
          '<span class="xx-turn-chev">' + ICONS.chev + '</span>';
      }
      const labelEl = bar.querySelector('.xx-turn-label');
      if (labelEl && labelEl.textContent !== hdr.label) labelEl.textContent = hdr.label;

      const existingById = new Map();
      for (const el of stepsBox.children) existingById.set(el.dataset.stepKey, el);

      const nextChildren = [];
      let needsStreamMore = false;
      const useSmooth = settings.smoothStream !== false;

      for (const item of turn.items) {
        let stepEl = existingById.get(item.id);
        if (!stepEl) {
          stepEl = document.createElement('div');
          stepEl.className = 'xx-step';
          stepEl.dataset.stepKey = item.id;
          stepEl.innerHTML =
            '<button class="xx-step-head" type="button">' +
              '<span class="xx-step-ico"></span>' +
              '<span class="xx-step-kind"></span>' +
              '<span class="xx-step-sep"></span>' +
              '<span class="xx-step-sum"></span>' +
              '<span class="xx-step-time"></span>' +
              '<span class="xx-step-chev">' + ICONS.chev + '</span>' +
            '</button>' +
            '<div class="xx-step-body-shell"><div class="xx-step-body-inner"><div class="xx-step-body"></div></div></div>';
        }

        const running = item.status === 'generating' || item.status === 'running';
        const isStreamingThink = item.kind === 'think' && (running || item.translateStatus === 'translating');
        const stepOpen = getStepOpen(item.id, item, settings);
        stepEl.dataset.kind = item.kind;
        stepEl.dataset.status = item.status || 'done';
        stepEl.dataset.running = String(running);
        stepEl.dataset.open = String(stepOpen);
        stepEl.dataset.hideSum = String(settings.hideSummaryWhenOpen !== false);
        stepEl.dataset.full = String(expandedFullMap.get(item.id) === true);
        stepEl._itemData = item;

        const rawText = item.kind === 'think' ? (item.thinking || '') : (item.detail || '');
        const zhText = item.kind === 'think' ? (item.translatedThinking || '') : '';
        const mode = settings.displayMode || 'zh';
        const showRawOverride = rawOverrideMap.get(item.id) === true;
        const effectiveMode = showRawOverride ? (mode === 'raw' ? 'zh' : 'raw') : mode;
        const targetText =
          item.kind === 'think' && effectiveMode !== 'raw' && zhText ? zhText : rawText;

        let displayText = targetText;
        if (item.kind === 'think') {
          const modeKey = effectiveMode + ':' + (zhText && effectiveMode !== 'raw' ? 'zh' : 'raw');
          let rec = streamShownMap.get(item.id);
          if (!useSmooth) {
            streamShownMap.delete(item.id);
            displayText = targetText;
          } else {
            if (!rec || rec.modeKey !== modeKey) {
              const startLen = isStreamingThink ? 0 : targetText.length;
              rec = { text: targetText, shownLen: startLen, modeKey, stepEl, item, effectiveMode, running, isStreamingThink };
              streamShownMap.set(item.id, rec);
            } else {
              rec.stepEl = stepEl;
              rec.item = item;
              rec.effectiveMode = effectiveMode;
              rec.running = running;
              rec.isStreamingThink = isStreamingThink;
              if (isStreamingThink && targetText.length < rec.shownLen) {
                rec.text = rec.text.slice(0, rec.shownLen);
              } else {
                rec.text = targetText;
              }
            }
            if (rec.shownLen < rec.text.length) needsStreamMore = true;
            displayText = rec.text.slice(0, Math.min(rec.shownLen, rec.text.length));
          }
        }

        stepEl._copyText = targetText;

        const sumText = item.kind === 'think'
          ? thinkSummary(displayText || targetText, isStreamingThink)
          : (item.summary || '');

        let timeText = '';
        if (running && item.startedAtMs) {
          timeText = Math.max(0, (Date.now() - item.startedAtMs) / 1000).toFixed(1) + 's';
        } else if (typeof item.durationSec === 'number') {
          timeText = item.durationSec.toFixed(1) + 's';
        }

        const headSig = item.kind + '|' + item.label + '|' + sumText + '|' + running;
        if (stepEl.dataset.headSig !== headSig) {
          stepEl.dataset.headSig = headSig;
          stepEl.querySelector('.xx-step-ico').innerHTML = ICONS[item.kind] || ICONS.tool;
          stepEl.querySelector('.xx-step-kind').textContent = item.label;
          stepEl.querySelector('.xx-step-sum').textContent = sumText;
        }
        const timeEl = stepEl.querySelector('.xx-step-time');
        if (timeEl && timeEl.textContent !== timeText) timeEl.textContent = timeText;

        const renderBody = () => {
          const liveRec = item.kind === 'think' ? streamShownMap.get(item.id) : null;
          const curDisplayText = liveRec
            ? liveRec.text.slice(0, Math.min(liveRec.shownLen, liveRec.text.length))
            : targetText;
          const curStreaming = isStreamingThink || Boolean(liveRec && liveRec.shownLen < liveRec.text.length);
          const bodySig = curDisplayText + '|' + rawText + '|' + effectiveMode + '|' + (settings.thinkHeightMode || 'md') + '|' + (item.translateStatus || '') + '|' + (item.translateModel || '') + '|' + (item.translateError || '') + '|' + running + '|' + curStreaming + '|' + (item.thinkingTokens || 0);
          if (stepEl.dataset.bodySig === bodySig) return;
          stepEl.dataset.bodySig = bodySig;
          const bodyEl = stepEl.querySelector('.xx-step-body');
          if (item.kind === 'think') {
            const cursor = curStreaming ? '<span class="xx-cursor"></span>' : '';
            const chipsHtml = buildFootChips(item, running);
            const bilingualExtra =
              effectiveMode === 'bilingual' && zhText && zhText !== rawText
                ? '<div class="xx-bilingual-raw">' + renderMarkdown(rawText) + '</div>'
                : '';
            const langToggleHtml = zhText && zhText !== rawText
              ? '<button class="xx-btn xx-toggle-lang" type="button">' + (effectiveMode === 'raw' ? '看中文' : '看原文') + '</button>'
              : '';
            const retryHtml =
              settings.translateEnabled !== false && item.translateStatus !== 'off' && item.translateStatus !== 'no-key' && item.translateModel !== 'native-zh'
                ? '<button class="xx-btn xx-retry-btn" type="button">重译</button>'
                : '';

            const mdHtml = (renderMarkdown(curDisplayText) || '<p>正在酝酿思路…</p>') + cursor + bilingualExtra;
            const existingMd = bodyEl.querySelector('.xx-think-md');
            const existingFoot = bodyEl.querySelector('.xx-step-foot');
            if (existingMd && existingFoot) {
              if (existingMd._lastHtml !== mdHtml) {
                const nearBottom = existingMd.scrollHeight - existingMd.scrollTop - existingMd.clientHeight < 48;
                existingMd._lastHtml = mdHtml;
                existingMd.innerHTML = mdHtml;
                if (curStreaming && nearBottom && stepEl.dataset.full !== 'true') {
                  existingMd.scrollTop = existingMd.scrollHeight;
                }
              }
              syncThinkOverflow(stepEl, existingMd);
              const metaSpan = existingFoot.querySelector('.xx-foot-meta');
              if (metaSpan && metaSpan._lastHtml !== chipsHtml) {
                metaSpan._lastHtml = chipsHtml;
                metaSpan.innerHTML = chipsHtml;
              }
              const actionsSpan = existingFoot.querySelector('.xx-foot-actions');
              const actionsSig = Boolean(langToggleHtml) + ':' + Boolean(retryHtml) + ':' + effectiveMode;
              if (actionsSpan && actionsSpan.dataset.sig !== actionsSig) {
                actionsSpan.dataset.sig = actionsSig;
                actionsSpan.innerHTML = langToggleHtml + retryHtml + '<button class="xx-btn xx-copy-btn" type="button">复制</button>';
              }
            } else {
              const actionsSig = Boolean(langToggleHtml) + ':' + Boolean(retryHtml) + ':' + effectiveMode;
              bodyEl.innerHTML =
                '<div class="xx-think-md">' + mdHtml + '</div>' +
                '<div class="xx-expand-bar"><button class="xx-expand-full-btn" type="button">展开全文</button></div>' +
                '<div class="xx-step-foot">' +
                  '<span class="xx-foot-meta">' + chipsHtml + '</span>' +
                  '<span class="xx-foot-actions" data-sig="' + actionsSig + '">' + langToggleHtml + retryHtml + '<button class="xx-btn xx-copy-btn" type="button">复制</button></span>' +
                '</div>';
              const newMd = bodyEl.querySelector('.xx-think-md');
              newMd._lastHtml = mdHtml;
              bodyEl.querySelector('.xx-foot-meta')._lastHtml = chipsHtml;
              if (curStreaming && stepEl.dataset.full !== 'true') {
                newMd.scrollTop = newMd.scrollHeight;
              }
              syncThinkOverflow(stepEl, newMd);
            }
          } else {
            if (!bodyEl.querySelector('.xx-detail-pre')) {
              bodyEl.innerHTML =
                '<pre class="xx-detail-pre">' + escapeHtml(rawText || '{}') + '</pre>' +
                '<div class="xx-step-foot"><span class="xx-foot-meta"><span class="xx-chip">' + escapeHtml(item.label) + '</span></span><span class="xx-foot-actions"><button class="xx-btn xx-copy-btn" type="button">复制</button></span></div>';
            } else {
              const pre = bodyEl.querySelector('.xx-detail-pre');
              const txt = rawText || '{}';
              if (pre.textContent !== txt) pre.textContent = txt;
            }
          }
        };
        stepEl._renderBody = renderBody;
        if (stepOpen) renderBody();

        nextChildren.push(stepEl);
      }

      const currentChildren = Array.from(stepsBox.children);
      const sameOrder =
        currentChildren.length === nextChildren.length &&
        currentChildren.every((el, idx) => el === nextChildren[idx]);
      if (!sameOrder) {
        stepsBox.replaceChildren(...nextChildren);
      }

      if (needsStreamMore) scheduleStreamTick();
    }

    /**
     * 精准局部 30fps 平滑吐字：绝不重跑整页 renderAll()，把 GPU/渲染进程 CPU 压到最低！
     */
    function scheduleStreamTick() {
      if (streamRaf) return;
      streamRaf = requestAnimationFrame((ts) => {
        streamRaf = 0;
        if (document.visibilityState !== 'visible') {
          // 后台标签页直接一步追平并同步 DOM，避免切回前台停在半截与残留光标
          for (const rec of streamShownMap.values()) {
            rec.shownLen = rec.text.length;
            if (rec.stepEl && rec.stepEl.isConnected) {
              updateStepThinkDisplay(rec.stepEl, rec.text, rec.item, rec.effectiveMode, rec.running, rec.isStreamingThink);
            }
          }
          return;
        }
        if (ts - lastStreamTickAt < 30) {
          scheduleStreamTick();
          return;
        }
        lastStreamTickAt = ts;
        let hasMore = false;
        for (const rec of streamShownMap.values()) {
          if (rec.shownLen < rec.text.length) {
            const delta = rec.text.length - rec.shownLen;
            const step = Math.max(2, Math.min(12, Math.ceil(delta / 5)));
            rec.shownLen = Math.min(rec.text.length, rec.shownLen + step);
            if (rec.stepEl && rec.stepEl.isConnected) {
              const shown = rec.text.slice(0, rec.shownLen);
              updateStepThinkDisplay(rec.stepEl, shown, rec.item, rec.effectiveMode, rec.running, rec.isStreamingThink || rec.shownLen < rec.text.length);
            }
            if (rec.shownLen < rec.text.length) hasMore = true;
          }
        }
        if (hasMore) scheduleStreamTick();
      });
    }

    function cleanupHosts() {
      for (const el of document.querySelectorAll('.agy-thinking-inline-host')) el.remove();
    }

    function renderAll() {
      if (!lastData || !lastSettings?.inlineEnabled) {
        cleanupHosts();
        return;
      }

      const domConvId = detectConversationId();
      if (domConvId && lastData.activeId && domConvId !== lastData.activeId) return;

      if (lastData.activeId && lastActiveConvId && lastData.activeId !== lastActiveConvId) {
        streamShownMap.clear();
        openState.clear();
        userPinnedSet.clear();
        rawOverrideMap.clear();
        expandedFullMap.clear();
        turnSettledMap.clear();
      }
      if (lastData.activeId) lastActiveConvId = lastData.activeId;

      const responses = Array.from(document.querySelectorAll('[data-testid="agent-response"]'));
      const turns = lastData.turns || [];
      if (turns.length === 0) {
        cleanupHosts();
        return;
      }
      if (responses.length === 0) return;

      const theme = detectTheme();
      const paired = pairResponsesToTurns(responses, turns);

      for (let i = 0; i < paired.length; i++) {
        const { resp, turn } = paired[i];
        if (!turn || !Array.isArray(turn.items) || turn.items.length === 0) {
          const old = resp.querySelector(':scope > .agy-thinking-inline-host');
          if (old) old.remove();
          continue;
        }
        let host = resp.querySelector(':scope > .agy-thinking-inline-host');
        if (!host) {
          host = document.createElement('div');
          host.className = 'agy-thinking-inline-host';
          resp.prepend(host);
        }
        renderTurnIntoHost(host, turn, i === paired.length - 1, lastSettings, theme);
      }
    }

    function apply(data, settings, owner) {
      if (owner < (globalThis.__agyThinkingInline?.owner || 0)) return 'superseded';
      lastData = data;
      lastSettings = settings;
      renderAll();
      return true;
    }

    function readState(owner) {
      if (owner < (globalThis.__agyThinkingInline?.owner || 0)) return 'superseded';
      const drained = pendingActions.length > 0 ? pendingActions.splice(0, pendingActions.length) : [];
      return {
        owner: OWNER,
        hash: ${JSON.stringify(createHash('sha1').update(String(owner)).digest('hex').slice(0, 12))},
        convId: detectConversationId(),
        hasResponses: document.querySelectorAll('[data-testid="agent-response"]').length > 0,
        visible: document.visibilityState === 'visible',
        actions: drained,
      };
    }

    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
      for (const rec of streamShownMap.values()) {
        if (rec.stepEl && rec.stepEl.isConnected) {
          const shown = rec.text.slice(0, Math.min(rec.shownLen, rec.text.length));
          updateStepThinkDisplay(rec.stepEl, shown, rec.item, rec.effectiveMode, rec.running, rec.isStreamingThink || rec.shownLen < rec.text.length);
        }
      }
      renderAll();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    function dispose() {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (timerHandle) clearInterval(timerHandle);
      if (streamRaf) cancelAnimationFrame(streamRaf);
      streamShownMap.clear();
      openState.clear();
      userPinnedSet.clear();
      rawOverrideMap.clear();
      expandedFullMap.clear();
      turnSettledMap.clear();
      cleanupHosts();
      if (globalThis.__agyThinkingInline?.owner === OWNER) delete globalThis.__agyThinkingInline;
    }

    // 仅在活跃生成且页面可见时走秒表，绝不空转
    timerHandle = setInterval(() => {
      if (!lastData?.isGenerating || document.visibilityState !== 'visible') return;
      for (const host of document.querySelectorAll('.agy-thinking-inline-host')) {
        const turn = host._turnData;
        const shadow = host.shadowRoot;
        if (!turn || !turn.isRunning || !shadow) continue;
        const labelEl = shadow.querySelector('.xx-turn-label');
        if (labelEl) labelEl.textContent = formatTurnHeader(turn).label;
        for (const stepEl of shadow.querySelectorAll('.xx-step[data-running="true"]')) {
          const item = stepEl._itemData;
          if (!item?.startedAtMs) continue;
          const timeEl = stepEl.querySelector('.xx-step-time');
          if (timeEl) timeEl.textContent = Math.max(0, (Date.now() - item.startedAtMs) / 1000).toFixed(1) + 's';
        }
      }
    }, 250);

    globalThis.__agyThinkingInline = { owner: OWNER, apply, readState, dispose };
    return true;
  })()`;

  const hash = createHash('sha1').update(code).digest('hex').slice(0, 16);
  const patchedCode = code.replace(
    createHash('sha1').update(String(owner)).digest('hex').slice(0, 12),
    hash
  );
  return { code: patchedCode, hash };
}

export function startInlineInjector(
  inspectByConvId,
  getCachedSnapshot,
  getSettings,
  getPublicSettings = getSettings,
  options = {}
) {
  const owner = options.instanceTs ?? INSTANCE_TS;
  const bundle = getClientBundle(owner);
  const sockets = new Map();
  let cachedPages = [];
  let lastListAt = 0;
  let stopped = false;
  let busy = false;
  let cdpState = 'unknown';
  let timer = null;
  let lastActiveAt = 0;
  let lastChangeAt = Date.now();
  let cachedPushTimer = null;
  let pendingCachedPush = false;
  let pendingCachedTriggerNew = false;
  let pendingNudge = false;
  const selfPort = Number(options.selfPort || 0);

  const retire = (entry, id) => {
    if (entry.closed) return;
    entry.closed = true;
    for (const cb of entry.pending.values()) cb(undefined);
    entry.pending.clear();
    try { entry.ws.close(); } catch {}
    if (sockets.get(id) === entry) sockets.delete(id);
  };

  const connect = async (target) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const entry = { ws, pending: new Map(), nextId: 1, lastSig: '', lastConvId: '', visible: true };
    await new Promise((resolve, reject) => {
      const fail = (msg) => {
        clearTimeout(t);
        retire(entry, target.id);
        reject(new Error(msg));
      };
      const t = setTimeout(() => fail('ws timeout'), 3000);
      ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      ws.onerror = () => fail('ws error');
    });
    if (stopped) {
      retire(entry, target.id);
      throw new Error('stopped');
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const cb = entry.pending.get(msg.id);
        if (cb) {
          entry.pending.delete(msg.id);
          cb(msg);
        }
      } catch {}
    };
    ws.onclose = () => retire(entry, target.id);
    sockets.set(target.id, entry);
    return entry;
  };

  const evaluate = (entry, expression) =>
    new Promise((resolve) => {
      if (entry.ws.readyState !== 1) return resolve(undefined);
      const id = entry.nextId++;
      const t = setTimeout(() => {
        entry.pending.delete(id);
        resolve(undefined);
      }, 3000);
      entry.pending.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg?.result?.result?.value);
      });
      try {
        entry.ws.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true },
          })
        );
      } catch {
        clearTimeout(t);
        entry.pending.delete(id);
        resolve(undefined);
      }
    });

  const listPages = async (force = false) => {
    if (typeof WebSocket !== 'function') {
      cdpState = 'no-ws';
      return [];
    }
    // 延长 page 枚举缓存至 10 秒，避免频繁打 /json/list
    if (!force && cachedPages.length && Date.now() - lastListAt < 10000) return cachedPages;
    let port;
    try {
      port = readFileSync(PORT_FILE, 'utf-8').split(/\r?\n/)[0].trim();
    } catch {
      cdpState = 'missing';
      return [];
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const targets = await res.json();
      cachedPages = targets.filter((t) => {
        if (t.type !== 'page' || !t.webSocketDebuggerUrl) return false;
        const m = String(t.url || '').match(/^https?:\/\/127\.0\.0\.1:(\d+)\//);
        if (!m) return false;
        if (selfPort && Number(m[1]) === selfPort) return false;
        return true;
      });
      lastListAt = Date.now();
      cdpState = 'ok';
      const validIds = new Set(cachedPages.map((t) => t.id));
      for (const [id, entry] of sockets) {
        if (!validIds.has(id)) retire(entry, id);
      }
      return cachedPages;
    } catch {
      cdpState = 'unreachable';
      return [];
    }
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearTimeout(cachedPushTimer);
    await Promise.all(
      [...sockets].map(async ([id, entry]) => {
        try {
          await evaluate(
            entry,
            `globalThis.__agyThinkingInline?.owner===${owner}&&globalThis.__agyThinkingInline.dispose()`
          );
        } finally {
          retire(entry, id);
        }
      })
    );
  };

  async function pushDataToEntry(entry, data, publicSettings) {
    const slimData = {
      activeId: data.activeId,
      activeStatus: data.activeStatus,
      isGenerating: data.isGenerating,
      turns: data.turns,
    };
    const sig = computeSlimSignature(slimData, publicSettings);
    if (entry.lastSig === sig) return false;

    const ok = await evaluate(
      entry,
      `globalThis.__agyThinkingInline?.apply(${JSON.stringify(slimData)},${JSON.stringify(publicSettings)},${owner})??false`
    );
    if (ok === 'superseded') {
      cdpState = 'superseded';
      await stop();
      return false;
    }
    if (ok) {
      entry.lastSig = sig;
      lastChangeAt = Date.now();
      return true;
    }
    return false;
  }

  /**
   * 零 LS RPC 缓存热推：专门承接翻译流式新字，绝不触发 LanguageServer 轮询！
   */
  const pushCached = (triggerNew = false) => {
    if (stopped) return;
    if (triggerNew) pendingCachedTriggerNew = true;
    if (cachedPushTimer) return;
    cachedPushTimer = setTimeout(async () => {
      cachedPushTimer = null;
      if (stopped || sockets.size === 0) {
        pendingCachedTriggerNew = false;
        return;
      }
      if (busy) {
        pendingCachedPush = true;
        return;
      }
      const shouldTrigger = pendingCachedTriggerNew;
      pendingCachedTriggerNew = false;
      const settings = getSettings();
      if (!settings.inlineEnabled) return;
      const publicSettings = getPublicSettings();
      for (const entry of sockets.values()) {
        if (entry.closed || !entry.visible) continue;
        try {
          const cached = getCachedSnapshot?.(entry.lastConvId || '', settings, shouldTrigger);
          if (cached) await pushDataToEntry(entry, cached, publicSettings);
        } catch {}
      }
    }, 90);
  };

  const computeNextDelay = (anyGenerating, anyVisible, inlineEnabled) => {
    if (!inlineEnabled) return 5000;
    if (!anyVisible) return 4500;
    if (anyGenerating) return 350;
    const sinceActive = Date.now() - lastActiveAt;
    if (sinceActive < 5000) return 1000;
    const sinceChange = Date.now() - lastChangeAt;
    return sinceChange > 20000 ? 3500 : 2200;
  };

  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    let anyGenerating = false;
    let anyVisible = false;
    const settings = getSettings();
    const publicSettings = getPublicSettings();
    try {
      const pages = await listPages();
      for (const target of pages) {
        if (stopped) break;
        try {
          const entry = sockets.get(target.id) || (await connect(target));
          let state = await evaluate(entry, `globalThis.__agyThinkingInline?.readState(${owner})??null`);
          if (state === undefined || stopped) continue;
          if (state === 'superseded') {
            cdpState = 'superseded';
            await stop();
            return;
          }
          if (state?.owner !== owner || state.hash !== bundle.hash) {
            const installed = await evaluate(entry, bundle.code);
            if (installed === 'superseded') {
              cdpState = 'superseded';
              await stop();
              return;
            }
            if (!installed || stopped) continue;
            entry.lastSig = '';
            state = await evaluate(entry, `globalThis.__agyThinkingInline?.readState(${owner})??null`);
          }
          if (!state || state.owner !== owner) continue;

          entry.visible = state.visible !== false;
          entry.lastConvId = state.convId || '';
          if (entry.visible) anyVisible = true;

          if (Array.isArray(state.actions) && state.actions.length > 0) {
            for (const act of state.actions) {
              try { options.onAction?.(act); } catch {}
            }
          }

          if (!settings.inlineEnabled) {
            if (entry.lastSig !== 'OFF') {
              await evaluate(
                entry,
                `globalThis.__agyThinkingInline?.apply(null,${JSON.stringify(publicSettings)},${owner})`
              );
              entry.lastSig = 'OFF';
            }
            continue;
          }

          if (!state.hasResponses) continue;
          // 隐藏页只在尚未注入过时刷一次，之后跳过节省 CPU
          if (!entry.visible && entry.lastSig) continue;

          const data = await inspectByConvId(state.convId || '', settings);
          if (!data || stopped) continue;
          if (data.isGenerating || data.activeStatus === 'CASCADE_RUN_STATUS_RUNNING') {
            anyGenerating = true;
            lastActiveAt = Date.now();
          }

          await pushDataToEntry(entry, data, publicSettings);
        } catch {
          const entry = sockets.get(target.id);
          if (entry) retire(entry, target.id);
        }
      }
    } finally {
      busy = false;
      if (!stopped) {
        if (pendingCachedPush) {
          pendingCachedPush = false;
          pushCached(pendingCachedTriggerNew);
        }
        const nextDelay = pendingNudge
          ? 120
          : computeNextDelay(anyGenerating, anyVisible, settings.inlineEnabled);
        pendingNudge = false;
        timer = setTimeout(tick, nextDelay);
      }
    }
  };

  timer = setTimeout(tick, 200);
  return {
    stop,
    status: () => cdpState,
    pushCached,
    nudge: () => {
      if (stopped) return;
      if (busy) {
        pendingNudge = true;
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(tick, 120);
    },
  };
}

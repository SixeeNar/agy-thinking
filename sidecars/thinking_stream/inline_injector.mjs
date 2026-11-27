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
  let sig = `${slimData.activeId}|${slimData.activeStatus}|${slimData.isGenerating}|${slimData.cacheEpoch || 0}|${JSON.stringify(publicSettings)}|`;
  for (const turn of slimData.turns || []) {
    sig += `${turn.turnIndex}:${turn.items.length}:${turn.isRunning}:${turn.hasError ? 1 : 0}:${turn.durationSec ?? ''}:`;
    for (const item of turn.items || []) {
      if (item.kind === 'reply-boundary') {
        sig += `rb:${item.id};`;
        continue;
      }
      const len = item.kind === 'think' ? (item.thinking?.length || 0) : (item.detail?.length || 0);
      const stepHint = item.kind === 'think' ? '' : sampleTextSig(item.liveDetail || item.summary);
      const tSig = sampleTextSig(item.translatedThinking);
      const fSig = sampleTextSig(item.fullTranslatedThinking);
      const nSig = sampleTextSig(item.narrativeSummary);
      sig += `${item.id}/${item.status}/${len}/${stepHint}/${tSig}/${item.translateStatus || ''}/${item.translatePhase || ''}/${item.translateModel || ''}/${item.translateError || ''}/${fSig}/${item.fullTranslateStatus || ''}/${item.fullTranslateModel || ''}/${item.fullTranslateError || ''}/${nSig}/${item.narrativeStatus || ''}/${item.narrativeModel || ''}/${item.narrativeError || ''}/${item.thinkingTokens || 0}/${item.durationSec ?? ''};`;
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

    const openState = new Map();       // turnKey / turnKey:g:gKey / turnKey:th:id / turnKey:tl:id -> boolean
    const userPinnedSet = new Set();   // 用户手动点击过的 key
    const turnAutoFoldedSet = new Set(); // 已触发过自动折叠的 turnKey
    const seenActiveTurns = new Set(); // 曾经处于运行/翻译态的 turnKey（用于防误收起冷却确认）
    const pendingFoldTimers = new Map(); // turnKey -> timeoutId（完成态稳定 2s 后再自动收起）
    const AUTO_FOLD_GRACE_MS = 2000;
    const clearFoldTimer = (turnKey) => {
      const tid = pendingFoldTimers.get(turnKey);
      if (tid) clearTimeout(tid);
      pendingFoldTimers.delete(turnKey);
    };
    const clearAllFoldTimers = () => {
      for (const tid of pendingFoldTimers.values()) clearTimeout(tid);
      pendingFoldTimers.clear();
    };
    const groupFollowMap = new Map();  // groupOpenKey -> boolean (运行中组独立跟底开关)
    const liveTitleCache = new Map();  // groupOpenKey -> { title, iconKey, activity, committedAt, pending, timer }
    const rawOverrideMap = new Map();
    const fullDetailMap = new Map();
    const expandedFullMap = new Map();
    const streamShownMap = new Map();  // itemId -> { text, shownLen, modeKey, rowEl, item, effectiveMode, running, isStreamingThink, summaryEnabled }
    const pendingActions = [];
    let lastActiveConvId = '';
    let lastTranslateStyle = '';
    let lastCacheEpoch = -1;
    let streamRaf = 0;
    let lastStreamTickAt = 0;
    let timerHandle = null;
    let lastData = null;
    let lastSettings = null;

    const LIVE_TITLE_MIN_MS = 150;

    ${SHARED_RENDER_SOURCE}

    function parseOpaqueRgb(bg) {
      const m = String(bg || '').match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/i);
      if (!m) return null;
      if (m[4] !== undefined && Number(m[4]) === 0) return null;
      return [Number(m[1]), Number(m[2]), Number(m[3])];
    }

    function detectTheme() {
      const rgb =
        parseOpaqueRgb(getComputedStyle(document.body).backgroundColor) ||
        parseOpaqueRgb(getComputedStyle(document.documentElement).backgroundColor);
      if (!rgb) {
        return window.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'light' : 'dark';
      }
      const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
      return lum < 0.5 ? 'dark' : 'light';
    }

    function detectConversationId() {
      const pathMatch = location.pathname.match(/\\/c\\/([0-9a-f-]{36})/i);
      if (pathMatch) return pathMatch[1];
      const row = document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"]');
      const cid = row?.getAttribute('data-cascade-id');
      return cid || '';
    }

    function resetTurnInnerDisclosures(turnKey) {
      const prefix = turnKey + ':';
      for (const k of Array.from(openState.keys())) {
        if (k.startsWith(prefix)) openState.delete(k);
      }
      for (const k of Array.from(userPinnedSet)) {
        if (k.startsWith(prefix)) userPinnedSet.delete(k);
      }
      for (const k of Array.from(groupFollowMap.keys())) {
        if (k.startsWith(prefix)) groupFollowMap.delete(k);
      }
    }

    function clearLiveTitleTimers() {
      for (const rec of liveTitleCache.values()) {
        if (rec?.timer) clearTimeout(rec.timer);
      }
      liveTitleCache.clear();
    }

    const SHADOW_CSS = \`
      :host {
        display: block;
        margin: 4px 0 12px;
        font-family: "PingFang SC", "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif;
        --xx-bg-sticky: #0d111b;
        --xx-fg: rgba(240, 244, 255, 0.94);
        --xx-muted: rgba(182, 196, 224, 0.84);
        --xx-dim: rgba(146, 165, 200, 0.62);
        --xx-surface: rgba(77, 163, 255, 0.052);
        --xx-surface-hover: rgba(155, 114, 203, 0.11);
        --xx-card: rgba(14, 19, 34, 0.56);
        --xx-border: rgba(138, 174, 242, 0.16);
        --xx-border-strong: rgba(155, 114, 203, 0.44);
        --xx-line: rgba(138, 174, 242, 0.24);
        --xx-code-bg: rgba(7, 10, 20, 0.44);
        --xx-accent: #4da3ff;
        --xx-accent-mid: #9b72cb;
        --xx-accent-2: #e879a8;
        --xx-grad: linear-gradient(135deg, #4da3ff 0%, #9b72cb 52%, #e879a8 100%);
        --xx-grad-flow: linear-gradient(90deg, #4da3ff 0%, #9b72cb 36%, #e879a8 68%, #4da3ff 100%);
        --xx-grad-soft: linear-gradient(135deg, rgba(77, 163, 255, 0.14) 0%, rgba(155, 114, 203, 0.15) 52%, rgba(232, 121, 168, 0.13) 100%);
        --xx-think: #b392f0;
        --xx-cmd: #2dd4bf;
        --xx-file: #60a5fa;
        --xx-edit: #a78bfa;
        --xx-search: #38bdf8;
        --xx-code: #818cf8;
        --xx-sub: #f472b6;
        --xx-plan: #34d399;
        --xx-tool: #e879a8;
        --xx-err: #fb7185;
      }
      .xx-wrap[data-theme="light"] {
        --xx-bg-sticky: #f6f8fe;
        --xx-fg: rgba(15, 23, 42, 0.92);
        --xx-muted: rgba(68, 84, 116, 0.86);
        --xx-dim: rgba(100, 116, 148, 0.72);
        --xx-surface: rgba(66, 133, 244, 0.055);
        --xx-surface-hover: rgba(139, 92, 246, 0.10);
        --xx-card: rgba(255, 255, 255, 0.86);
        --xx-border: rgba(66, 133, 244, 0.16);
        --xx-border-strong: rgba(139, 92, 246, 0.42);
        --xx-line: rgba(66, 133, 244, 0.22);
        --xx-code-bg: rgba(66, 133, 244, 0.07);
        --xx-accent: #4285f4;
        --xx-accent-mid: #8b5cf6;
        --xx-accent-2: #d96570;
        --xx-grad: linear-gradient(135deg, #4285f4 0%, #8b5cf6 54%, #d96570 100%);
        --xx-grad-flow: linear-gradient(90deg, #4285f4 0%, #8b5cf6 36%, #d96570 68%, #4285f4 100%);
        --xx-grad-soft: linear-gradient(135deg, rgba(66, 133, 244, 0.11) 0%, rgba(139, 92, 246, 0.12) 54%, rgba(217, 101, 112, 0.10) 100%);
        --xx-think: #7c3aed;
        --xx-cmd: #0d9488;
        --xx-file: #2563eb;
        --xx-edit: #7c3aed;
        --xx-search: #0284c7;
        --xx-code: #4f46e5;
        --xx-sub: #db2777;
        --xx-plan: #059669;
        --xx-tool: #db2777;
        --xx-err: #e11d48;
      }
      .xx-wrap, .xx-wrap * { box-sizing: border-box; }
      .xx-wrap {
        color: var(--xx-fg);
        font-size: 13px;
        line-height: 1.56;
      }
      .xx-wrap[data-font="sm"] { font-size: 12px; }
      .xx-wrap[data-font="sm"] .xx-think-md { font-size: 11.8px; line-height: 1.56; }
      .xx-wrap[data-font="lg"] { font-size: 14px; }
      .xx-wrap[data-font="lg"] .xx-think-md { font-size: 13.6px; line-height: 1.68; }

      /* ─── Layer 1: 整轮折叠控件（保留极光胶囊风格 + DSH 语义状态） ─── */
      .xx-turn-bar {
        position: relative;
        overflow: hidden;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        max-width: 100%;
        padding: 4.5px 13px 4.5px 10px;
        border-radius: 999px;
        border: 1px solid rgba(155, 114, 203, 0.26);
        background: linear-gradient(135deg, rgba(77, 163, 255, 0.09), rgba(155, 114, 203, 0.09) 52%, rgba(232, 121, 168, 0.08));
        color: var(--xx-fg);
        font: inherit;
        font-size: 12.4px;
        cursor: pointer;
        user-select: none;
        box-shadow: 0 2px 12px -6px rgba(77, 163, 255, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.08);
        transition: background 0.18s ease, border-color 0.18s ease, color 0.18s ease, box-shadow 0.2s ease, transform 0.12s ease;
      }
      .xx-wrap[data-theme="light"] .xx-turn-bar {
        border-color: rgba(139, 92, 246, 0.24);
        background: linear-gradient(135deg, rgba(66, 133, 244, 0.08), rgba(139, 92, 246, 0.08) 54%, rgba(217, 101, 112, 0.07));
        box-shadow: 0 2px 10px -6px rgba(139, 92, 246, 0.22);
      }
      .xx-turn-bar:disabled { cursor: default; }
      .xx-turn-bar::after {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(105deg, transparent 20%, rgba(255, 255, 255, 0.22) 48%, rgba(232, 121, 168, 0.16) 56%, transparent 80%);
        transform: translateX(-130%);
        pointer-events: none;
      }
      .xx-turn-bar:not(:disabled):hover {
        background: var(--xx-grad-soft);
        border-color: var(--xx-border-strong);
        box-shadow: 0 0 0 1px rgba(155, 114, 203, 0.18), 0 4px 18px -6px rgba(155, 114, 203, 0.42);
      }
      .xx-turn-bar:not(:disabled):hover::after { animation: xx-sheen 1.15s cubic-bezier(0.22, 1, 0.36, 1); }
      .xx-turn-bar:not(:disabled):active { transform: scale(0.988); }
      .xx-wrap[data-turn-open="true"] .xx-turn-bar {
        background: var(--xx-grad-soft);
        border-color: rgba(155, 114, 203, 0.34);
      }
      .xx-wrap[data-running="true"] .xx-turn-bar {
        border-color: rgba(232, 121, 168, 0.48);
        box-shadow: 0 0 0 1px rgba(155, 114, 203, 0.22), 0 4px 20px -5px rgba(155, 114, 203, 0.48), 0 0 16px -6px rgba(77, 163, 255, 0.38);
      }
      .xx-wrap[data-running="true"] .xx-turn-bar::after { animation: xx-sheen 2.4s ease-in-out infinite; }
      @keyframes xx-sheen {
        0% { transform: translateX(-130%); }
        60%, 100% { transform: translateX(130%); }
      }
      .xx-turn-star {
        position: relative;
        width: 14px;
        height: 14px;
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        filter: drop-shadow(0 0 5px rgba(155, 114, 203, 0.55));
      }
      .xx-turn-star svg { display: none; }
      .xx-turn-star::before {
        content: "";
        width: 100%;
        height: 100%;
        display: block;
        background: var(--xx-grad-flow);
        background-size: 220% 220%;
        background-position: 15% 50%;
        -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23000' d='M12 1.5L14.6 9.4L22.5 12L14.6 14.6L12 22.5L9.4 14.6L1.5 12L9.4 9.4Z'/%3E%3C/svg%3E") center/contain no-repeat;
        mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23000' d='M12 1.5L14.6 9.4L22.5 12L14.6 14.6L12 22.5L9.4 14.6L1.5 12L9.4 9.4Z'/%3E%3C/svg%3E") center/contain no-repeat;
      }
      .xx-wrap[data-running="true"] .xx-turn-star {
        filter: drop-shadow(0 0 8px rgba(232, 121, 168, 0.78));
        animation: xx-star-pulse 1.6s ease-in-out infinite;
      }
      .xx-wrap[data-running="true"] .xx-turn-star::before { animation: xx-aurora-shift 2.2s linear infinite; }
      @keyframes xx-aurora-shift {
        0% { background-position: 0% 50%; }
        100% { background-position: 220% 50%; }
      }
      @keyframes xx-star-pulse {
        0%, 100% { transform: scale(1) rotate(0deg); opacity: 1; }
        50% { transform: scale(0.84) rotate(45deg); opacity: 0.72; }
      }
      .xx-turn-label { font-weight: 550; white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .xx-turn-num {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-variant-numeric: tabular-nums;
      }
      .xx-wrap:not([data-running="true"]) .xx-turn-label {
        background: linear-gradient(90deg, var(--xx-fg) 0%, #c8dcff 58%, #e4c6ff 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .xx-wrap[data-theme="light"]:not([data-running="true"]) .xx-turn-label {
        background: linear-gradient(90deg, #1e293b 0%, #4285f4 62%, #8b5cf6 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .xx-wrap[data-running="true"] .xx-turn-label {
        background: var(--xx-grad-flow);
        background-size: 220% auto;
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
        animation: xx-shimmer 2.1s linear infinite;
      }
      .xx-wrap[data-error="true"]:not([data-running="true"]) .xx-turn-label {
        background: none;
        color: var(--xx-err);
      }
      @keyframes xx-shimmer { to { background-position: 220% center; } }
      .xx-turn-chev {
        width: 13px;
        height: 13px;
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--xx-muted);
        opacity: 0.76;
        transition: transform 0.16s cubic-bezier(0.22, 1, 0.36, 1);
      }
      .xx-turn-chev svg { width: 13px; height: 13px; display: block; }
      .xx-wrap[data-turn-open="true"] .xx-turn-chev { transform: rotate(180deg); }
      .xx-turn-bar:disabled .xx-turn-chev { display: none; }

      /* 整轮展开壳层 + 极光星轨 */
      .xx-turn-shell {
        display: grid;
        grid-template-rows: 0fr;
        opacity: 0;
        transition: grid-template-rows 0.2s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.16s ease;
      }
      .xx-wrap[data-turn-open="true"] .xx-turn-shell {
        grid-template-rows: 1fr;
        opacity: 1;
      }
      .xx-turn-inner { overflow: hidden; }
      .xx-groups {
        position: relative;
        margin: 8px 0 4px 0;
        padding: 4px 0 4px 28px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .xx-wrap[data-compact="true"] .xx-groups { gap: 5px; padding: 3px 0 2px 26px; }
      .xx-groups::before {
        content: "";
        position: absolute;
        top: 0;
        bottom: 6px;
        left: 16px;
        width: 1.5px;
        border-radius: 999px;
        background: linear-gradient(180deg, rgba(77, 163, 255, 0.5) 0%, rgba(155, 114, 203, 0.4) 52%, rgba(232, 121, 168, 0.28) 100%);
        -webkit-mask-image: linear-gradient(180deg, transparent 0%, #000 5%, #000 72%, rgba(0, 0, 0, 0.36) 88%, transparent 100%);
        mask-image: linear-gradient(180deg, transparent 0%, #000 5%, #000 72%, rgba(0, 0, 0, 0.36) 88%, transparent 100%);
      }
      .xx-groups::after {
        content: "";
        display: none;
        position: absolute;
        top: 0;
        bottom: 6px;
        left: 16px;
        width: 1.5px;
        border-radius: 999px;
        background: linear-gradient(
          180deg,
          transparent 0%,
          transparent 32%,
          rgba(77, 163, 255, 0.2) 40%,
          rgba(116, 138, 232, 0.62) 50%,
          rgba(155, 114, 203, 0.92) 58%,
          rgba(232, 121, 168, 1) 62%,
          rgba(255, 228, 245, 0.96) 64.5%,
          rgba(232, 121, 168, 0.32) 66.5%,
          transparent 68%,
          transparent 100%
        );
        background-size: 100% 340%;
        background-repeat: no-repeat;
        filter: drop-shadow(0 0 3px rgba(155, 114, 203, 0.62));
        -webkit-mask-image: linear-gradient(180deg, transparent 0%, #000 5%, #000 72%, rgba(0, 0, 0, 0.36) 88%, transparent 100%);
        mask-image: linear-gradient(180deg, transparent 0%, #000 5%, #000 72%, rgba(0, 0, 0, 0.36) 88%, transparent 100%);
        pointer-events: none;
      }
      .xx-wrap[data-running="true"] .xx-groups::after {
        display: block;
        animation: xx-rail-beam 2.2s cubic-bezier(0.35, 0.05, 0.45, 0.95) infinite;
      }
      @keyframes xx-rail-beam {
        0% { background-position: 0 100%; }
        100% { background-position: 0 0%; }
      }

      /* ─── Layer 2: 二级过程组（DSH 分组头 + 图标↔箭头淡切 + 400px 限高渐隐） ─── */
      .xx-group {
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      .xx-group-head {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        max-width: 100%;
        min-height: 24px;
        padding: 2px 10px 2px 6px;
        margin-left: 0;
        border: 1px solid var(--xx-border);
        border-radius: 999px;
        background: var(--xx-surface);
        color: var(--xx-muted);
        font: inherit;
        font-size: 11.8px;
        line-height: 1.4;
        text-align: left;
        cursor: pointer;
        user-select: none;
        transition: color 0.14s ease, background 0.14s ease, border-color 0.14s ease;
      }
      .xx-group-head:hover {
        color: var(--xx-fg);
        background: var(--xx-surface-hover);
        border-color: var(--xx-border-strong);
      }
      .xx-group[data-grouped="false"] > .xx-group-head { display: none; }

      .xx-lead {
        position: relative;
        flex: 0 0 auto;
        width: 18px;
        height: 18px;
        border-radius: 6px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--xx-think);
      }
      .xx-lead[data-ico="read"], .xx-lead[data-ico="file"] { color: var(--xx-file); }
      .xx-lead[data-ico="edit"] { color: var(--xx-edit); }
      .xx-lead[data-ico="search"], .xx-lead[data-ico="webSearch"], .xx-lead[data-ico="webFetch"] { color: var(--xx-search); }
      .xx-lead[data-ico="cmd"] { color: var(--xx-cmd); }
      .xx-lead[data-ico="code"] { color: var(--xx-code); }
      .xx-lead[data-ico="subagents"] { color: var(--xx-sub); }
      .xx-lead[data-ico="plan"] { color: var(--xx-plan); }
      .xx-lead[data-ico="questions"], .xx-lead[data-ico="tool"] { color: var(--xx-tool); }
      .xx-lead[data-err="true"] { color: var(--xx-err); }

      .xx-act-ico, .xx-act-chev {
        position: absolute;
        inset: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: opacity 0.1s ease;
      }
      .xx-act-ico svg, .xx-act-chev svg { width: 14px; height: 14px; display: block; }
      .xx-act-ico { opacity: 1; }
      .xx-act-chev { opacity: 0; color: var(--xx-accent-mid); }
      .xx-group-head:hover .xx-act-ico,
      .xx-group-head:focus-visible .xx-act-ico,
      .xx-group[data-group-open="true"] > .xx-group-head .xx-act-ico { opacity: 0; }
      .xx-group-head:hover .xx-act-chev,
      .xx-group-head:focus-visible .xx-act-chev,
      .xx-group[data-group-open="true"] > .xx-group-head .xx-act-chev { opacity: 1; }

      .xx-group[data-live="true"] > .xx-group-head .xx-act-ico svg {
        animation: xx-spin 2.2s linear infinite;
      }
      @keyframes xx-spin { to { transform: rotate(360deg); } }

      .xx-group-title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: 520;
      }
      .xx-group[data-live="true"] > .xx-group-head .xx-group-title {
        background: var(--xx-grad-flow);
        background-size: 220% auto;
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
        animation: xx-shimmer 2.1s linear infinite;
      }

      /* 组正文：手动展开时限高 min(400px, 50vh) + 24px 渐隐；平铺模式无组级限高 */
      .xx-group-body-shell {
        display: grid;
        grid-template-rows: 0fr;
        opacity: 0;
        transition: grid-template-rows 0.18s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.15s ease;
      }
      .xx-group[data-group-open="true"] > .xx-group-body-shell,
      .xx-group[data-grouped="false"] > .xx-group-body-shell {
        grid-template-rows: 1fr;
        opacity: 1;
      }
      .xx-group-body-inner { overflow: hidden; }
      .xx-group-body {
        margin-top: 6px;
        padding: 0 4px 4px 2px;
        max-height: min(400px, 50vh);
        overflow-y: auto;
        overscroll-behavior-y: auto;
        scrollbar-gutter: stable;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .xx-group[data-grouped="false"] > .xx-group-body-shell > .xx-group-body-inner > .xx-group-body {
        margin-top: 0;
        padding: 0;
        max-height: none;
        overflow: visible;
        scrollbar-gutter: auto;
      }
      .xx-wrap[data-compact="true"] .xx-group-body { gap: 2px; }
      .xx-group-body::-webkit-scrollbar { width: 4px; }
      .xx-group-body::-webkit-scrollbar-thumb { background: rgba(138, 174, 242, 0.28); border-radius: 999px; }
      .xx-group-body::-webkit-scrollbar-track { background: transparent; }

      .xx-group-body.xx-fade-top {
        -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 24px, #000 100%);
        mask-image: linear-gradient(to bottom, transparent 0, #000 24px, #000 100%);
      }
      .xx-group-body.xx-fade-bottom {
        -webkit-mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - 24px), transparent 100%);
        mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - 24px), transparent 100%);
      }
      .xx-group-body.xx-fade-top.xx-fade-bottom {
        -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%);
        mask-image: linear-gradient(to bottom, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%);
      }

      /* ─── Layer 3: 单条思考行 & 单条工具行（Aurora Glass 极光磨砂卡片） ─── */
      .xx-row {
        position: relative;
        min-width: 0;
        display: flex;
        flex-direction: column;
        border-radius: 12px;
        border: 1px solid transparent;
        transition: background 0.18s ease, border-color 0.18s ease, box-shadow 0.2s ease;
      }
      .xx-row[data-open="true"] {
        background:
          radial-gradient(115% 75% at 0% 0%, rgba(77, 163, 255, 0.085) 0%, rgba(155, 114, 203, 0.055) 38%, transparent 72%),
          linear-gradient(180deg, rgba(20, 25, 42, 0.72), rgba(12, 16, 29, 0.84));
        border-color: rgba(155, 114, 203, 0.18);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.065),
          0 10px 26px -16px rgba(2, 6, 22, 0.78);
        margin: 2px 0;
        overflow: clip;
      }
      .xx-wrap[data-theme="light"] .xx-row[data-open="true"] {
        background:
          radial-gradient(115% 75% at 0% 0%, rgba(66, 133, 244, 0.08) 0%, rgba(139, 92, 246, 0.045) 40%, transparent 72%),
          linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(246, 249, 255, 0.96));
        border-color: rgba(139, 92, 246, 0.17);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.9),
          0 8px 22px -14px rgba(66, 133, 244, 0.24);
      }
      .xx-row[data-open="true"]::before {
        content: "";
        position: absolute;
        top: 0;
        left: 12px;
        right: 12px;
        height: 1px;
        background: linear-gradient(90deg, transparent, rgba(77, 163, 255, 0.34) 26%, rgba(155, 114, 203, 0.42) 55%, rgba(232, 121, 168, 0.28) 80%, transparent);
        opacity: 0.65;
        pointer-events: none;
        z-index: 6;
      }
      .xx-row[data-open="true"][data-running="true"] {
        border-color: rgba(155, 114, 203, 0.34);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.08),
          0 0 0 1px rgba(155, 114, 203, 0.12),
          0 12px 28px -14px rgba(155, 114, 203, 0.36);
      }
      .xx-row[data-open="true"][data-running="true"]::before {
        height: 1.5px;
        left: 0;
        right: 0;
        background: var(--xx-grad-flow);
        background-size: 220% auto;
        opacity: 0.92;
        animation: xx-shimmer 2.4s linear infinite;
      }

      .xx-row-head {
        display: flex;
        align-items: center;
        gap: 7px;
        width: 100%;
        min-height: 28px;
        padding: 4px 11px;
        border: none;
        border-radius: 10px;
        background: transparent;
        color: var(--xx-muted);
        font: inherit;
        font-size: 12.2px;
        text-align: left;
        cursor: pointer;
        user-select: none;
        transition: background 0.14s ease, color 0.14s ease;
      }
      .xx-wrap[data-compact="true"] .xx-row-head { min-height: 24px; padding: 2px 9px; }
      .xx-row-head:hover { background: var(--xx-surface-hover); color: var(--xx-fg); }

      /* 展开思考卡头：半透磨砂吸顶 + 羽化渐变底丝线 */
      .xx-think-row[data-open="true"] > .xx-row-head {
        position: sticky;
        top: 0;
        z-index: 5;
        min-height: 33px;
        padding: 6px 13px;
        background: rgba(16, 21, 36, 0.78);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border-radius: 0;
      }
      .xx-wrap[data-theme="light"] .xx-think-row[data-open="true"] > .xx-row-head {
        background: rgba(248, 250, 255, 0.84);
      }
      .xx-think-row[data-open="true"] > .xx-row-head::after {
        content: "";
        position: absolute;
        left: 14px;
        right: 14px;
        bottom: 0;
        height: 1px;
        background: linear-gradient(90deg, transparent, rgba(138, 174, 242, 0.16) 18%, rgba(155, 114, 203, 0.2) 55%, rgba(232, 121, 168, 0.12) 84%, transparent);
        pointer-events: none;
      }
      .xx-think-row[data-open="true"] > .xx-row-head:hover {
        background: rgba(24, 31, 52, 0.86);
      }
      .xx-wrap[data-theme="light"] .xx-think-row[data-open="true"] > .xx-row-head:hover {
        background: rgba(240, 245, 255, 0.92);
      }

      .xx-row-head:hover .xx-act-ico,
      .xx-row-head:focus-visible .xx-act-ico,
      .xx-row[data-open="true"] > .xx-row-head .xx-act-ico { opacity: 0; }
      .xx-row-head:hover .xx-act-chev,
      .xx-row-head:focus-visible .xx-act-chev,
      .xx-row[data-open="true"] > .xx-row-head .xx-act-chev { opacity: 1; }
      .xx-row[data-running="true"] > .xx-row-head .xx-act-ico svg {
        animation: xx-spin 2.2s linear infinite;
      }

      .xx-row-title {
        flex: 0 0 auto;
        font-weight: 560;
        letter-spacing: 0.01em;
        color: var(--xx-fg);
        opacity: 0.92;
        white-space: nowrap;
      }
      .xx-think-row[data-open="true"] .xx-row-title {
        background: linear-gradient(90deg, var(--xx-fg) 0%, #c8dcff 65%, #e2c7ff 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .xx-wrap[data-theme="light"] .xx-think-row[data-open="true"] .xx-row-title {
        background: linear-gradient(90deg, #1e293b 0%, #4285f4 65%, #8b5cf6 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .xx-row-sep {
        flex: 0 0 auto;
        width: 2.5px;
        height: 2.5px;
        border-radius: 50%;
        background: var(--xx-dim);
      }
      .xx-row-sum {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11.9px;
        color: var(--xx-muted);
      }
      /* DSH 流式思考右侧 48px 渐隐遮罩 + 极光流光 */
      .xx-row[data-streaming="true"] .xx-row-sum {
        text-overflow: clip;
        -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 48px), transparent);
        mask-image: linear-gradient(to right, #000 calc(100% - 48px), transparent);
        background: var(--xx-grad-flow);
        background-size: 220% auto;
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
        animation: xx-shimmer 2.2s linear infinite;
      }
      .xx-row[data-preview="false"] .xx-row-sep,
      .xx-row[data-preview="false"] .xx-row-sum { display: none; }
      .xx-think-row[data-open="true"][data-hide-sum="true"] .xx-row-sep,
      .xx-think-row[data-open="true"][data-hide-sum="true"] .xx-row-sum { display: none; }

      .xx-row-time {
        flex: 0 0 auto;
        margin-left: auto;
        padding: 1px 6px;
        border-radius: 999px;
        font-size: 10.6px;
        color: var(--xx-dim);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .xx-think-row[data-open="true"] .xx-row-time {
        background: rgba(138, 174, 242, 0.08);
        color: var(--xx-muted);
      }
      .xx-row-err { color: var(--xx-err); }

      .xx-row-body-shell {
        display: grid;
        grid-template-rows: 0fr;
        transition: grid-template-rows 0.18s cubic-bezier(0.22, 1, 0.36, 1);
      }
      .xx-row[data-open="true"] > .xx-row-body-shell { grid-template-rows: 1fr; }
      .xx-row-body-inner { min-height: 0; overflow: hidden; }
      .xx-row-body { padding: 11px 15px 11px 15px; }
      .xx-wrap[data-compact="true"] .xx-row-body { padding: 8px 12px 9px 12px; }
      .xx-think-row[data-brief="true"] > .xx-row-body-shell .xx-row-body { padding: 8px 14px 9px 14px; }
      .xx-think-row[data-brief="true"] .xx-think-md {
        font-size: 12.2px;
        line-height: 1.64;
        opacity: 0.88;
      }

      .xx-think-md {
        width: 100%;
        padding: 0;
        border-left: none;
        color: rgba(226, 234, 252, 0.88);
        font-size: 12.6px;
        line-height: 1.74;
        letter-spacing: 0.01em;
        word-break: break-word;
        user-select: text;
      }
      .xx-wrap[data-theme="light"] .xx-think-md {
        color: rgba(24, 34, 56, 0.88);
      }
      /* 统一 260px 限高视口 + 上下柔和渐隐（短内容自然撑开无滚动条，长内容结束不炸屏，点「展开全文」可解除） */
      .xx-think-row:not([data-full="true"]) .xx-think-md {
        max-height: 260px;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding-right: 6px;
      }
      .xx-think-row:not([data-full="true"]) .xx-think-md.xx-live-fade-top {
        -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 22px, #000 100%);
        mask-image: linear-gradient(to bottom, transparent 0, #000 22px, #000 100%);
      }
      .xx-think-row:not([data-full="true"]) .xx-think-md.xx-live-fade-bottom {
        -webkit-mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - 22px), transparent 100%);
        mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - 22px), transparent 100%);
      }
      .xx-think-row:not([data-full="true"]) .xx-think-md.xx-live-fade-top.xx-live-fade-bottom {
        -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 22px, #000 calc(100% - 22px), transparent 100%);
        mask-image: linear-gradient(to bottom, transparent 0, #000 22px, #000 calc(100% - 22px), transparent 100%);
      }
      .xx-wrap[data-think-height="sm"] .xx-think-row:not([data-full="true"]) .xx-think-md {
        max-height: 220px;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding-right: 6px;
      }
      .xx-wrap[data-think-height="md"] .xx-think-row:not([data-full="true"]) .xx-think-md {
        max-height: 360px;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding-right: 6px;
      }
      .xx-think-md::-webkit-scrollbar { width: 4px; }
      .xx-think-md::-webkit-scrollbar-thumb { background: rgba(138, 174, 242, 0.28); border-radius: 999px; }
      .xx-think-md p { margin: 0 0 10px; }
      .xx-think-md p:last-child { margin-bottom: 0; }
      .xx-think-md .md-h { margin: 8px 0 4px; font-size: 12.5px; font-weight: 600; color: var(--xx-fg); }
      .xx-think-md .md-h:first-child { margin-top: 0; }
      .xx-think-md hr { border: none; border-top: 1px solid var(--xx-border); margin: 7px 0; }
      .xx-think-md strong { color: rgba(248, 250, 255, 0.98); font-weight: 620; }
      .xx-wrap[data-theme="light"] .xx-think-md strong { color: #0f172a; }
      .xx-think-md code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11.3px;
        padding: 1.5px 6px;
        border-radius: 5px;
        border: 1px solid rgba(138, 174, 242, 0.16);
        background: rgba(138, 174, 242, 0.1);
        color: #c8dcff;
      }
      .xx-wrap[data-theme="light"] .xx-think-md code {
        border-color: rgba(66, 133, 244, 0.18);
        background: rgba(66, 133, 244, 0.08);
        color: #2563eb;
      }
      .xx-think-md pre, .xx-detail-pre {
        margin: 6px 0 0;
        padding: 9px 11px;
        border-radius: 9px;
        border: 1px solid rgba(138, 174, 242, 0.12);
        background: rgba(7, 10, 20, 0.56);
        overflow-x: auto;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11.4px;
        line-height: 1.55;
        color: var(--xx-fg);
        user-select: text;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .xx-wrap[data-theme="light"] .xx-think-md pre,
      .xx-wrap[data-theme="light"] .xx-detail-pre {
        background: rgba(66, 133, 244, 0.055);
        border-color: rgba(66, 133, 244, 0.14);
      }
      .xx-think-md ul, .xx-think-md ol { margin: 4px 0 7px; padding-left: 18px; }
      .xx-think-md li { margin-bottom: 2px; }
      .xx-think-md blockquote { margin: 5px 0; padding-left: 9px; border-left: 2px solid var(--xx-border); opacity: 0.88; }

      /* 分步思路脉络迷你时间轴 */
      .xx-think-md .tstep-list {
        display: flex;
        flex-direction: column;
        gap: 9px;
      }
      .xx-wrap[data-compact="true"] .xx-think-md .tstep-list { gap: 6px; }
      .xx-think-md .tstep-node {
        position: relative;
        display: flex;
        align-items: flex-start;
        gap: 9px;
      }
      .xx-think-md .tstep-node:not(:last-child)::before {
        content: "";
        position: absolute;
        left: 8.5px;
        top: 20px;
        bottom: -9px;
        width: 1px;
        background: linear-gradient(180deg, rgba(155, 114, 203, 0.36), rgba(77, 163, 255, 0.14));
      }
      .xx-think-md .tstep-idx {
        flex: 0 0 auto;
        width: 18px;
        height: 18px;
        margin-top: 1px;
        border-radius: 999px;
        border: 1px solid rgba(155, 114, 203, 0.42);
        background: var(--xx-grad-soft);
        color: var(--xx-fg);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 10.2px;
        font-weight: 650;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .xx-think-md .tstep-body {
        flex: 1 1 auto;
        min-width: 0;
      }
      .xx-think-md .tstep-title {
        font-size: 12.4px;
        font-weight: 600;
        color: var(--xx-fg);
        line-height: 1.45;
      }
      .xx-think-md .tstep-desc {
        margin-top: 2px;
        color: var(--xx-muted);
        font-size: 12.1px;
        line-height: 1.6;
      }
      .xx-think-md .tstep-desc p { margin: 0 0 6px; }
      .xx-think-md .tstep-desc p:last-child { margin-bottom: 0; }
      .xx-row-steps-pill {
        flex: 0 0 auto;
        padding: 0 5px;
        height: 16px;
        line-height: 16px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 550;
        color: var(--xx-think);
        background: var(--xx-surface);
        border: 1px solid var(--xx-border);
        white-space: nowrap;
      }
      .xx-row-steps-pill:empty { display: none; }

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

      .xx-bilingual-raw {
        margin-top: 8px;
        padding-top: 7px;
        border-top: 1px dashed var(--xx-border);
        font-size: 11.5px;
        opacity: 0.72;
      }
      .xx-row-foot {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 10px;
        padding-top: 8px;
        font-size: 10.8px;
        color: var(--xx-dim);
      }
      .xx-row-foot::before {
        content: "";
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 1px;
        background: linear-gradient(90deg, rgba(138, 174, 242, 0.14), rgba(155, 114, 203, 0.12) 50%, transparent);
        pointer-events: none;
      }
      .xx-foot-meta { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; }
      .xx-foot-actions {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        opacity: 0.72;
        transition: opacity 0.16s ease;
      }
      .xx-row[data-open="true"]:hover .xx-foot-actions,
      .xx-row[data-open="true"]:focus-within .xx-foot-actions { opacity: 1; }
      .xx-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1.5px 7px;
        border-radius: 999px;
        background: rgba(138, 174, 242, 0.075);
        border: none;
        font-size: 10.4px;
        color: var(--xx-dim);
        font-variant-numeric: tabular-nums;
      }
      .xx-chip.live {
        color: var(--xx-accent-2);
        background: rgba(232, 121, 168, 0.12);
      }
      .xx-chip.err {
        color: var(--xx-err);
        background: rgba(248, 113, 113, 0.12);
      }
      .xx-btn {
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--xx-muted);
        font: inherit;
        font-size: 10.9px;
        cursor: pointer;
        transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
      }
      .xx-btn:hover {
        background: var(--xx-grad-soft);
        color: var(--xx-fg);
        border-color: rgba(155, 114, 203, 0.28);
      }

      /* ─── 极简无框风格（Minimal Editorial Stream）：去大气泡、去方框、与星轨浑然一体 ─── */
      .xx-wrap[data-card-style="minimal"] .xx-row[data-open="true"] {
        background: transparent;
        border-color: transparent;
        box-shadow: none;
        border-radius: 0;
        margin: 0;
      }
      .xx-wrap[data-card-style="minimal"] .xx-row[data-open="true"]::before { display: none; }
      .xx-wrap[data-card-style="minimal"] .xx-think-row[data-open="true"] > .xx-row-head {
        min-height: 26px;
        padding: 3px 4px 4px 4px;
        background: transparent;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        border-radius: 6px;
      }
      .xx-wrap[data-theme="light"][data-card-style="minimal"] .xx-think-row[data-open="true"] > .xx-row-head {
        background: transparent;
      }
      .xx-wrap[data-card-style="minimal"] .xx-think-row[data-open="true"] > .xx-row-head::after { display: none; }
      .xx-wrap[data-card-style="minimal"] .xx-think-row[data-open="true"] > .xx-row-head:hover {
        background: var(--xx-surface-hover);
      }
      .xx-wrap[data-card-style="minimal"] .xx-think-row[data-open="true"] .xx-row-title {
        font-size: 11.8px;
        letter-spacing: 0.03em;
      }
      .xx-wrap[data-card-style="minimal"] .xx-think-row[data-open="true"][data-running="true"] .xx-row-title {
        background: var(--xx-grad-flow);
        background-size: 220% auto;
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
        animation: xx-shimmer 2.2s linear infinite;
      }
      .xx-wrap[data-card-style="minimal"] .xx-think-row[data-open="true"] .xx-row-time {
        background: transparent;
        padding: 0 2px;
        color: var(--xx-dim);
        opacity: 0.72;
      }
      .xx-wrap[data-card-style="minimal"] .xx-think-row .xx-row-body {
        padding: 4px 4px 8px 25px;
      }
      .xx-wrap[data-card-style="minimal"] .xx-tool-row[data-open="true"] .xx-row-body {
        padding: 4px 4px 6px 25px;
      }
      .xx-wrap[data-card-style="minimal"] .xx-think-md {
        color: rgba(214, 224, 246, 0.82);
        line-height: 1.76;
      }
      .xx-wrap[data-theme="light"][data-card-style="minimal"] .xx-think-md {
        color: rgba(34, 46, 72, 0.84);
      }
      .xx-wrap[data-card-style="minimal"] .xx-think-md code {
        border-color: transparent;
        background: rgba(138, 174, 242, 0.09);
      }
      .xx-wrap[data-theme="light"][data-card-style="minimal"] .xx-think-md code {
        background: rgba(66, 133, 244, 0.075);
      }
      .xx-wrap[data-card-style="minimal"] .xx-think-row .xx-row-foot {
        margin-top: 7px;
        padding-top: 2px;
      }
      .xx-wrap[data-card-style="minimal"] .xx-think-row .xx-row-foot::before { display: none; }
      .xx-wrap[data-card-style="minimal"] .xx-think-row .xx-foot-meta { gap: 0; }
      .xx-wrap[data-card-style="minimal"] .xx-think-row .xx-chip {
        background: transparent;
        padding: 0;
        color: var(--xx-dim);
        opacity: 0.78;
      }
      .xx-wrap[data-card-style="minimal"] .xx-think-row .xx-chip + .xx-chip::before {
        content: "·";
        margin: 0 6px;
        opacity: 0.48;
        color: var(--xx-dim);
      }
      .xx-wrap[data-card-style="minimal"] .xx-think-row .xx-chip.live {
        color: var(--xx-accent-2);
        opacity: 0.95;
      }
      .xx-wrap[data-card-style="minimal"] .xx-think-row .xx-chip.err {
        color: var(--xx-err);
        opacity: 0.95;
      }
      .xx-wrap[data-card-style="minimal"] .xx-think-row .xx-foot-actions { opacity: 0.42; }
      .xx-wrap[data-card-style="minimal"] .xx-think-row:hover .xx-foot-actions,
      .xx-wrap[data-card-style="minimal"] .xx-think-row:focus-within .xx-foot-actions { opacity: 0.96; }
      .xx-wrap[data-card-style="minimal"] .xx-think-row .xx-btn {
        padding: 1px 6px;
        border-radius: 5px;
        font-size: 10.6px;
      }
      .xx-wrap[data-card-style="minimal"] .xx-think-row .xx-btn:hover {
        background: rgba(138, 174, 242, 0.1);
        border-color: transparent;
      }
    \`;

    function getBubblePromptForResponse(resp) {
      const turnEl = resp.closest('[data-turn-content]') || resp.parentElement?.parentElement;
      const bubble =
        turnEl?.querySelector('.agy-user-bubble') ||
        turnEl?.previousElementSibling?.querySelector?.('.agy-user-bubble');
      return (bubble?.innerText || '').replace(/\\s+/g, ' ').trim();
    }

    function isPromptMatch(turnPrompt, bubbleTxt) {
      const p = String(turnPrompt || '').replace(/\\s+/g, ' ').trim();
      const b = String(bubbleTxt || '').replace(/\\s+/g, ' ').trim();
      if (!p || !b) return false;
      if (p === b) return true;
      if (p.length < 6 || b.length < 6) return false;
      const prefixLen = Math.min(22, p.length, b.length);
      return p.startsWith(b.slice(0, prefixLen)) || b.startsWith(p.slice(0, prefixLen));
    }

    function pairResponsesToTurns(responses, turns) {
      const paired = new Array(responses.length);
      const usedTurnIdx = new Set();
      const activePrefix = (lastData?.activeId || 'conv') + ':turn:';
      const anchors = [];

      // Pass 1: 优先锁死已挂载过同会话思考卡片的节点（按原 turnIndex 单调锚定），
      // 防止新发重复短句（如「继续」「好」）时，底部新占位节点抢走上一轮的思考卡
      let lastAnchorTurn = -1;
      for (let i = 0; i < responses.length; i++) {
        const existingHost = responses[i].querySelector(':scope > .agy-thinking-inline-host');
        const key = existingHost?.dataset?.turnKey || '';
        if (!key.startsWith(activePrefix)) continue;
        const tIdxNum = Number(key.slice(activePrefix.length));
        const j = turns.findIndex((t, idx) => idx > lastAnchorTurn && !usedTurnIdx.has(idx) && t.turnIndex === tIdxNum);
        if (j !== -1) {
          usedTurnIdx.add(j);
          lastAnchorTurn = j;
          paired[i] = { resp: responses[i], turn: turns[j] };
          anchors.push({ r: i, t: j });
        }
      }

      // 将未锚定槽位按 Pass 1 锚点切分为严格单调区间 [rStart..rEnd] <-> [tStart..tEnd]，
      // 杜绝 Pass 2/3 跨越已锚定轮次发生前后互换或底部新占位抢占旧轮次
      const segments = [];
      let prevR = -1;
      let prevT = -1;
      for (const a of anchors) {
        segments.push({ rStart: prevR + 1, rEnd: a.r - 1, tStart: prevT + 1, tEnd: a.t - 1 });
        prevR = a.r;
        prevT = a.t;
      }
      segments.push({ rStart: prevR + 1, rEnd: responses.length - 1, tStart: prevT + 1, tEnd: turns.length - 1 });

      for (const seg of segments) {
        const rCount = seg.rEnd - seg.rStart + 1;
        const tCount = seg.tEnd - seg.tStart + 1;
        if (rCount <= 0) continue;

        // 当段内响应节点多于轨迹轮次（常见于末尾刚挂载尚未落盘的新占位），
        // 仅允许前 tCount 个槽位参与匹配，多出的尾部新占位一律置 null 避免整列错位
        const matchEnd = rCount > tCount ? (seg.rStart + Math.max(0, tCount) - 1) : seg.rEnd;

        // Pass 2: 区间内按相邻用户气泡文案自底向上单调匹配
        let cursor = seg.tEnd;
        for (let i = matchEnd; i >= seg.rStart; i--) {
          if (paired[i] || cursor < seg.tStart) continue;
          const bubbleTxt = getBubblePromptForResponse(responses[i]);
          if (!bubbleTxt) continue;
          for (let j = cursor; j >= seg.tStart; j--) {
            if (usedTurnIdx.has(j)) continue;
            if (isPromptMatch(turns[j].prompt, bubbleTxt)) {
              usedTurnIdx.add(j);
              paired[i] = { resp: responses[i], turn: turns[j] };
              cursor = j - 1;
              break;
            }
          }
        }

        // Pass 3: 区间内剩余未匹配槽位按正序填齐，超额尾部新占位保持 turn: null
        let fwdCursor = seg.tStart;
        for (let i = seg.rStart; i <= seg.rEnd; i++) {
          if (paired[i]) continue;
          if (i > matchEnd) {
            paired[i] = { resp: responses[i], turn: null };
            continue;
          }
          const directIdx = seg.tStart + (i - seg.rStart);
          let fallbackIdx = directIdx <= seg.tEnd && !usedTurnIdx.has(directIdx) ? directIdx : -1;
          if (fallbackIdx === -1) {
            while (fwdCursor <= seg.tEnd && usedTurnIdx.has(fwdCursor)) fwdCursor++;
            if (fwdCursor <= seg.tEnd) fallbackIdx = fwdCursor++;
          }
          if (fallbackIdx !== -1) usedTurnIdx.add(fallbackIdx);
          paired[i] = { resp: responses[i], turn: fallbackIdx !== -1 ? turns[fallbackIdx] : null };
        }
      }
      return paired;
    }

    function renderTurnLabelInfo(turn, settings = lastSettings) {
      return formatTurnBarLabel(turn, settings, 'xx-turn-num');
    }

    function buildFootChips(item, running, wantFullDetail) {
      const chips = [];
      if (item.thinkingTokens > 0) {
        chips.push('<span class="xx-chip">' + item.thinkingTokens + ' tok</span>');
      } else if (running) {
        chips.push('<span class="xx-chip live">流式思考中</span>');
      }
      if (wantFullDetail && item.fullTranslateStatus === 'translating') {
        chips.push('<span class="xx-chip live">完整译中</span>');
      } else if (wantFullDetail && item.fullTranslateStatus === 'error') {
        chips.push('<span class="xx-chip err" title="' + escapeHtml(item.fullTranslateError || '') + '">完整译失败</span>');
      } else if (wantFullDetail && item.fullTranslatedThinking) {
        chips.push('<span class="xx-chip">完整思考</span>');
      }
      if (item.translateStatus === 'translating') {
        const liveTxt = item.translatePhase === 'distilling' ? '整理脉络中' : '实时译中';
        chips.push('<span class="xx-chip live">' + liveTxt + '</span>');
      } else if (item.translateStatus === 'no-key') {
        chips.push('<span class="xx-chip">待填翻译 Key</span>');
      } else if (item.translateStatus === 'no-model') {
        chips.push('<span class="xx-chip">待选翻译模型</span>');
      } else if (item.translateStatus === 'error') {
        chips.push('<span class="xx-chip err" title="' + escapeHtml(item.translateError || '') + '">翻译异常</span>');
      } else if (item.translateModel) {
        chips.push('<span class="xx-chip">' + escapeHtml(shortModelName(item.translateModel)) + '</span>');
      }
      return chips.join('');
    }

    function updateGroupScrollFades(bodyEl) {
      if (!bodyEl) return;
      // 展开中的思考行头会 sticky 吸顶，避免被顶部 24px 渐隐遮罩淡化
      const hasOpenThink = Boolean(bodyEl.querySelector('.xx-think-row[data-open="true"]'));
      const canUp = !hasOpenThink && bodyEl.scrollTop > 2;
      const canDown = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight > 2;
      bodyEl.classList.toggle('xx-fade-top', canUp);
      bodyEl.classList.toggle('xx-fade-bottom', canDown);
    }

    function updateThinkLiveFade(rowEl, mdEl) {
      if (!rowEl || !mdEl) return;
      const constrained = rowEl.dataset.full !== 'true';
      const showTopFade = constrained && mdEl.scrollTop > 4;
      const showBottomFade = constrained && mdEl.scrollHeight - mdEl.scrollTop - mdEl.clientHeight > 6;
      mdEl.classList.toggle('xx-live-fade-top', showTopFade);
      mdEl.classList.toggle('xx-live-fade-bottom', showBottomFade);
    }

    function bindThinkMdScroll(rowEl, mdEl) {
      if (!mdEl || mdEl._liveScrollBound) return;
      mdEl._liveScrollBound = true;
      mdEl.addEventListener('scroll', () => updateThinkLiveFade(rowEl, mdEl), { passive: true });
    }

    function syncThinkOverflow(rowEl, mdEl) {
      if (!rowEl || !mdEl) return;
      bindThinkMdScroll(rowEl, mdEl);
      const isFull = rowEl.dataset.full === 'true';
      const hasOverflow = !isFull && mdEl.clientHeight >= 40 && mdEl.scrollHeight > mdEl.clientHeight + 8;
      rowEl.dataset.overflow = String(hasOverflow);
      updateThinkLiveFade(rowEl, mdEl);
      const btn = rowEl.querySelector('.xx-expand-full-btn');
      if (btn) {
        btn.textContent = isFull ? '收起高度' : '展开全文';
        btn.style.display = (hasOverflow || isFull) ? '' : 'none';
      }
    }

    function computeRowSummaryText(item, displayText, effectiveMode, isStreamingThink, summaryEnabled, wantFullDetail) {
      if (effectiveMode !== 'raw' && summaryEnabled && item.narrativeSummary) {
        return item.narrativeSummary.replace(/\\*\\*/g, '').replace(/\\s+/g, ' ').trim();
      }
      const fallbackText = effectiveMode === 'raw'
        ? (item.thinking || '')
        : ((wantFullDetail ? (item.fullTranslatedThinking || item.translatedThinking) : item.translatedThinking) || item.thinking || '');
      return thinkSummary(displayText || fallbackText, isStreamingThink);
    }

    function updateThinkRowStreamDom(rowEl, displayText, item, effectiveMode, running, isStreamingThink, summaryEnabled, policy, useStepRender, wantFullDetail) {
      const sumText = computeRowSummaryText(item, displayText, effectiveMode, isStreamingThink, summaryEnabled, wantFullDetail);
      const showPreview = Boolean(sumText) && (isStreamingThink || policy.settledReasoningPreview);
      rowEl.dataset.preview = String(showPreview);
      const sumEl = rowEl.querySelector('.xx-row-sum');
      if (sumEl && sumEl.textContent !== sumText) sumEl.textContent = sumText;

      if (rowEl.dataset.open !== 'true') return;
      const mdEl = rowEl.querySelector('.xx-think-md');
      if (!mdEl) return;

      const rawText = item.thinking || '';
      const zhText = wantFullDetail ? (item.fullTranslatedThinking || item.translatedThinking || '') : (item.translatedThinking || '');
      const cursor = isStreamingThink ? '<span class="xx-cursor"></span>' : '';
      const bilingualExtra =
        effectiveMode === 'bilingual' && zhText && zhText !== rawText
          ? '<div class="xx-bilingual-raw">' + renderMarkdown(rawText) + '</div>'
          : '';
      const rendered = renderThinkingSteps(displayText, useStepRender !== false && effectiveMode !== 'raw');
      const mdHtml = (rendered || '<p>正在酝酿思路…</p>') + cursor + bilingualExtra;
      if (mdEl._lastHtml !== mdHtml) {
        const nearBottom = mdEl.scrollHeight - mdEl.scrollTop - mdEl.clientHeight < 48;
        mdEl._lastHtml = mdHtml;
        mdEl.innerHTML = mdHtml;
        if (isStreamingThink && nearBottom && rowEl.dataset.full !== 'true') {
          mdEl.scrollTop = mdEl.scrollHeight;
        }
        syncThinkOverflow(rowEl, mdEl);
        const grpBody = rowEl.closest('.xx-group-body');
        if (grpBody) {
          const gKey = grpBody.dataset.groupOpenKey;
          if (gKey && groupFollowMap.get(gKey) === true) {
            grpBody.scrollTop = grpBody.scrollHeight;
          }
          updateGroupScrollFades(grpBody);
        }
      }
    }

    /**
     * DSH 150ms 实时组标题防抖：运行中标题变化最少保留 150ms，组结束立刻切完成态不延迟。
     */
    function resolveStableGroupTitle(groupOpenKey, desired, isLive, onCommit) {
      if (!isLive) {
        const prev = liveTitleCache.get(groupOpenKey);
        if (prev?.timer) clearTimeout(prev.timer);
        liveTitleCache.delete(groupOpenKey);
        return desired;
      }
      const now = Date.now();
      const rec = liveTitleCache.get(groupOpenKey);
      if (!rec) {
        const fresh = { ...desired, committedAt: now, pending: null, timer: null };
        liveTitleCache.set(groupOpenKey, fresh);
        return desired;
      }
      if (rec.title === desired.title && rec.iconKey === desired.iconKey) {
        return rec;
      }
      const remaining = LIVE_TITLE_MIN_MS - (now - rec.committedAt);
      if (remaining <= 0) {
        if (rec.timer) clearTimeout(rec.timer);
        rec.title = desired.title;
        rec.iconKey = desired.iconKey;
        rec.activity = desired.activity;
        rec.committedAt = now;
        rec.pending = null;
        rec.timer = null;
        return rec;
      }
      rec.pending = desired;
      if (!rec.timer) {
        rec.timer = setTimeout(() => {
          rec.timer = null;
          if (rec.pending) {
            rec.title = rec.pending.title;
            rec.iconKey = rec.pending.iconKey;
            rec.activity = rec.pending.activity;
            rec.committedAt = Date.now();
            rec.pending = null;
            onCommit?.();
          }
        }, remaining);
      }
      return rec;
    }

    function renderTurnIntoHost(host, turn, isLastTurn, settings, theme) {
      let shadow = host.shadowRoot;
      if (!shadow) {
        shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML =
          '<style>' + SHADOW_CSS + '</style>' +
          '<div class="xx-wrap">' +
            '<button class="xx-turn-bar" type="button">' +
              '<span class="xx-turn-star">' + ICONS.star + '</span>' +
              '<span class="xx-turn-label"></span>' +
              '<span class="xx-turn-chev">' + ICONS.chevDown + '</span>' +
            '</button>' +
            '<div class="xx-turn-shell"><div class="xx-turn-inner"><div class="xx-groups"></div></div></div>' +
          '</div>';

        const wrap = shadow.querySelector('.xx-wrap');
        const bar = shadow.querySelector('.xx-turn-bar');
        const groupsBox = shadow.querySelector('.xx-groups');

        bar.addEventListener('click', () => {
          if (bar.disabled) return;
          const key = host.dataset.turnKey;
          const next = wrap.dataset.turnOpen !== 'true';
          clearFoldTimer(key);
          openState.set(key, next);
          userPinnedSet.add(key);
          wrap.dataset.turnOpen = String(next);
          if (!next) {
            // DSH 铁律：收起整轮时重置内部所有组、思考和工具的开合状态
            resetTurnInnerDisclosures(key);
          }
          // 无论展开还是收起都立即同步渲染，避免懒渲染的折叠轮展开后组体为空
          renderAll();
          if (next) {
            setTimeout(() => {
              if (!host.isConnected || wrap.dataset.turnOpen !== 'true') return;
              for (const b of groupsBox.querySelectorAll('.xx-group-body')) updateGroupScrollFades(b);
              for (const r of groupsBox.querySelectorAll('.xx-think-row[data-open="true"]')) {
                syncThinkOverflow(r, r.querySelector('.xx-think-md'));
              }
            }, 210);
          }
        });

        groupsBox.addEventListener('click', async (ev) => {
          const groupHead = ev.target.closest('.xx-group-head');
          if (groupHead) {
            const grpEl = groupHead.closest('.xx-group');
            const gKey = grpEl?.dataset.groupOpenKey;
            if (gKey) {
              const next = grpEl.dataset.groupOpen !== 'true';
              openState.set(gKey, next);
              grpEl.dataset.groupOpen = String(next);
              const chevEl = groupHead.querySelector('.xx-act-chev');
              if (chevEl) chevEl.innerHTML = next ? ICONS.chevUp : ICONS.chevDown;
              const bodyEl = grpEl.querySelector('.xx-group-body');
              if (next) {
                const isLive = grpEl.dataset.live === 'true';
                groupFollowMap.set(gKey, isLive);
                if (grpEl._renderMembers) grpEl._renderMembers();
                setTimeout(() => {
                  if (!grpEl.isConnected || grpEl.dataset.groupOpen !== 'true' || !bodyEl) return;
                  bodyEl.scrollTop = isLive ? bodyEl.scrollHeight : 0;
                  updateGroupScrollFades(bodyEl);
                }, 200);
              } else {
                groupFollowMap.set(gKey, false);
              }
            }
            return;
          }

          const thinkHead = ev.target.closest('.xx-think-head');
          if (thinkHead) {
            const rowEl = thinkHead.closest('.xx-think-row');
            const rKey = rowEl?.dataset.rowOpenKey;
            if (rKey) {
              const next = rowEl.dataset.open !== 'true';
              openState.set(rKey, next);
              userPinnedSet.add(rKey);
              rowEl.dataset.open = String(next);
              const chevEl = thinkHead.querySelector('.xx-act-chev');
              const wantChev = next ? ICONS.chevUp : ICONS.chevDown;
              if (chevEl) {
                chevEl._lastHtml = wantChev;
                chevEl.innerHTML = wantChev;
              }
              if (next && rowEl._renderThinkBody) {
                const liveRec = rowEl._thinkItem ? streamShownMap.get(rowEl._thinkItem.id) : null;
                if (liveRec && liveRec.shownLen < liveRec.text.length) {
                  if (!liveRec.isStreamingThink) {
                    liveRec.shownLen = liveRec.text.length;
                  } else {
                    scheduleStreamTick();
                  }
                }
                rowEl._renderThinkBody();
                setTimeout(() => {
                  if (!rowEl.isConnected || rowEl.dataset.open !== 'true') return;
                  syncThinkOverflow(rowEl, rowEl.querySelector('.xx-think-md'));
                  const grpBody = rowEl.closest('.xx-group-body');
                  if (grpBody) updateGroupScrollFades(grpBody);
                }, 210);
              } else {
                const grpBody = rowEl.closest('.xx-group-body');
                if (grpBody) updateGroupScrollFades(grpBody);
              }
            }
            return;
          }

          const toolHead = ev.target.closest('.xx-tool-head');
          if (toolHead) {
            const rowEl = toolHead.closest('.xx-tool-row');
            const rKey = rowEl?.dataset.rowOpenKey;
            if (rKey) {
              const next = rowEl.dataset.open !== 'true';
              openState.set(rKey, next);
              rowEl.dataset.open = String(next);
              const chevEl = toolHead.querySelector('.xx-act-chev');
              if (chevEl) chevEl.innerHTML = next ? ICONS.chevUp : ICONS.chevDown;
              if (next && rowEl._renderToolBody) {
                rowEl._renderToolBody();
                setTimeout(() => {
                  const grpBody = rowEl.closest('.xx-group-body');
                  if (grpBody) updateGroupScrollFades(grpBody);
                }, 200);
              }
            }
            return;
          }

          const retryBtn = ev.target.closest('.xx-retry-btn');
          if (retryBtn) {
            const rowEl = retryBtn.closest('.xx-think-row');
            const item = rowEl?._thinkItem;
            if (item) {
              streamShownMap.delete(item.id);
              rowEl.dataset.bodySig = '';
              pendingActions.push({ type: 'retry', itemId: item.id, rawText: item.thinking || '' });
              retryBtn.textContent = '重译中…';
              setTimeout(() => { if (retryBtn.isConnected) retryBtn.textContent = '重译'; }, 3500);
            }
            return;
          }

          const toggleDetailBtn = ev.target.closest('.xx-toggle-detail');
          if (toggleDetailBtn) {
            const rowEl = toggleDetailBtn.closest('.xx-think-row');
            const item = rowEl?._thinkItem;
            const key = item?.id;
            if (key) {
              const nextDetail = fullDetailMap.get(key) !== true;
              fullDetailMap.set(key, nextDetail);
              if (nextDetail && !item.fullTranslatedThinking) {
                pendingActions.push({ type: 'translate-full', itemId: key });
              }
              streamShownMap.delete(key);
              rowEl.dataset.bodySig = '';
              renderAll();
            }
            return;
          }

          const toggleLangBtn = ev.target.closest('.xx-toggle-lang');
          if (toggleLangBtn) {
            const rowEl = toggleLangBtn.closest('.xx-think-row');
            const key = rowEl?._thinkItem?.id;
            if (key) {
              rawOverrideMap.set(key, rawOverrideMap.get(key) !== true);
              streamShownMap.delete(key);
              rowEl.dataset.bodySig = '';
              renderAll();
            }
            return;
          }

          const expandBtn = ev.target.closest('.xx-expand-full-btn');
          if (expandBtn) {
            const rowEl = expandBtn.closest('.xx-think-row');
            const key = rowEl?._thinkItem?.id;
            if (key) {
              const nextFull = rowEl.dataset.full !== 'true';
              expandedFullMap.set(key, nextFull);
              rowEl.dataset.full = String(nextFull);
              syncThinkOverflow(rowEl, rowEl.querySelector('.xx-think-md'));
            }
            return;
          }

          const copyBtn = ev.target.closest('.xx-copy-btn');
          if (copyBtn) {
            const rowEl = copyBtn.closest('.xx-row');
            const raw = rowEl?._copyText || '';
            try {
              await navigator.clipboard.writeText(raw);
              copyBtn.textContent = '已复制';
              setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = '复制'; }, 1200);
            } catch {}
            return;
          }
        });
      }

      const policy = getPresentationPolicy(settings);
      const turnKey = (lastData?.activeId || 'conv') + ':turn:' + turn.turnIndex;
      host.dataset.turnKey = turnKey;
      host._turnData = turn;

      const wrap = shadow.querySelector('.xx-wrap');
      const bar = shadow.querySelector('.xx-turn-bar');
      const groupsBox = shadow.querySelector('.xx-groups');

      const turnActive = Boolean(turn.isRunning || isTurnTranslating(turn, settings));
      wrap.dataset.theme = theme;
      wrap.dataset.running = String(turnActive);
      wrap.dataset.error = String(Boolean(turn.hasError));
      wrap.dataset.compact = 'false';
      wrap.dataset.font = settings.fontSize || 'md';
      wrap.dataset.cardStyle = settings.cardStyle === 'glass' ? 'glass' : 'minimal';
      wrap.dataset.thinkHeight = 'full';

      // 极简 2 档整轮开合：进行中（含步骤空窗期与翻译收尾）强制展开；
      // 刚结束的活跃轮次需连续稳定 2s 后才自动收起，防止步骤衔接间隙提前闪折
      const forceOpen = turnActive;
      const canCollapse = !forceOpen && Boolean(turn.hasProcess !== false);

      let turnOpen;
      if (forceOpen) {
        turnOpen = true;
        seenActiveTurns.add(turnKey);
        clearFoldTimer(turnKey);
        turnAutoFoldedSet.delete(turnKey);
      } else if (userPinnedSet.has(turnKey)) {
        clearFoldTimer(turnKey);
        turnOpen = openState.get(turnKey) === true;
      } else if (!policy.foldCompletedTurns || turn.hasError) {
        clearFoldTimer(turnKey);
        turnOpen = true;
        openState.set(turnKey, true);
        turnAutoFoldedSet.delete(turnKey);
      } else {
        if (!turnAutoFoldedSet.has(turnKey)) {
          if (seenActiveTurns.has(turnKey)) {
            openState.set(turnKey, true);
            if (!pendingFoldTimers.has(turnKey)) {
              const tid = setTimeout(() => {
                pendingFoldTimers.delete(turnKey);
                if (userPinnedSet.has(turnKey) || turnAutoFoldedSet.has(turnKey)) return;
                const latestTurn = (lastData?.turns || []).find((t) => ((lastData?.activeId || 'conv') + ':turn:' + t.turnIndex) === turnKey);
                if (latestTurn && (latestTurn.isRunning || isTurnTranslating(latestTurn, lastSettings))) return;
                turnAutoFoldedSet.add(turnKey);
                openState.set(turnKey, false);
                resetTurnInnerDisclosures(turnKey);
                renderAll();
              }, AUTO_FOLD_GRACE_MS);
              pendingFoldTimers.set(turnKey, tid);
            }
          } else {
            turnAutoFoldedSet.add(turnKey);
            openState.set(turnKey, false);
            resetTurnInnerDisclosures(turnKey);
          }
        }
        turnOpen = openState.get(turnKey) === true;
      }

      bar.disabled = !canCollapse;
      wrap.dataset.turnOpen = String(Boolean(turnOpen));

      const labelEl = bar.querySelector('.xx-turn-label');
      const labelInfo = renderTurnLabelInfo(turn, settings);
      if (labelEl && labelEl._lastHtml !== labelInfo.html) {
        labelEl._lastHtml = labelInfo.html;
        labelEl.innerHTML = labelInfo.html;
      }
      if (bar.title !== labelInfo.title) bar.title = labelInfo.title;

      const mode = settings.displayMode || 'zh';
      const summaryEnabled = settings.summaryEnabled === true;
      const useSmooth = settings.smoothStream !== false;
      const hideSum = settings.hideSummaryWhenOpen !== false;

      // 思考直出主时间线 + 连续多条工具自动收成轻量胶囊
      const groups = buildProcessGroups(turn.items, turn.isRunning, mode, summaryEnabled);

      const existingGroups = new Map();
      for (const el of groupsBox.children) {
        if (el.dataset.groupOpenKey) existingGroups.set(el.dataset.groupOpenKey, el);
      }

      const nextGroupEls = [];
      const activeLiveKeys = new Set();
      const pendingMemberRenderers = [];
      let needsStreamMore = false;

      for (const group of groups) {
        const groupOpenKey = turnKey + ':g:' + group.key;
        const isGrouped = Boolean(group.grouped);
        let grpEl = existingGroups.get(groupOpenKey);
        if (!grpEl) {
          grpEl = document.createElement('div');
          grpEl.className = 'xx-group';
          grpEl.dataset.groupOpenKey = groupOpenKey;
          grpEl.innerHTML =
            '<button class="xx-group-head" type="button">' +
              '<span class="xx-lead">' +
                '<span class="xx-act-ico"></span>' +
                '<span class="xx-act-chev">' + ICONS.chevDown + '</span>' +
              '</span>' +
              '<span class="xx-group-title"></span>' +
            '</button>' +
            '<div class="xx-group-body-shell"><div class="xx-group-body-inner"><div class="xx-group-body"></div></div></div>';
          const bodyEl = grpEl.querySelector('.xx-group-body');
          bodyEl.dataset.groupOpenKey = groupOpenKey;
          bodyEl.addEventListener('scroll', () => {
            updateGroupScrollFades(bodyEl);
            const atBottom = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 20;
            if (grpEl.dataset.live === 'true') {
              groupFollowMap.set(groupOpenKey, atBottom);
            }
          }, { passive: true });
        }

        const isLiveGroup = !group.closed;
        if (isLiveGroup) activeLiveKeys.add(groupOpenKey);
        const groupOpen = !isGrouped || openState.get(groupOpenKey) === true;
        grpEl.dataset.grouped = String(isGrouped);
        grpEl.dataset.groupOpen = String(groupOpen);
        grpEl.dataset.live = String(isLiveGroup);

        const rawTitleInfo = formatProcessGroupTitle(group.summary, group.closed, policy.liveProcessDetail);
        const stableTitle = resolveStableGroupTitle(groupOpenKey, rawTitleInfo, isLiveGroup, () => renderAll());

        const headEl = grpEl.querySelector('.xx-group-head');
        const leadEl = headEl.querySelector('.xx-lead');
        const icoEl = headEl.querySelector('.xx-act-ico');
        const chevEl = headEl.querySelector('.xx-act-chev');
        const titleEl = headEl.querySelector('.xx-group-title');

        const headSig = stableTitle.iconKey + '|' + stableTitle.title + '|' + groupOpen + '|' + group.hasError;
        if (headEl.dataset.sig !== headSig) {
          headEl.dataset.sig = headSig;
          leadEl.dataset.ico = stableTitle.iconKey;
          leadEl.dataset.err = String(Boolean(group.hasError));
          icoEl.innerHTML = ICONS[stableTitle.iconKey] || ICONS.think;
          chevEl.innerHTML = groupOpen ? ICONS.chevUp : ICONS.chevDown;
          titleEl.textContent = stableTitle.title;
          titleEl.title = stableTitle.title;
        }

        const bodyEl = grpEl.querySelector('.xx-group-body');
        const renderMembers = () => {
          const existingRows = new Map();
          for (const rEl of bodyEl.children) {
            if (rEl.dataset.rowOpenKey) existingRows.set(rEl.dataset.rowOpenKey, rEl);
          }

          let localNeedsStream = false;
          const nextRowEls = [];
          for (const item of group.members) {
            if (item.kind === 'think') {
              const rowOpenKey = turnKey + ':th:' + item.id;
              let rowEl = existingRows.get(rowOpenKey);
              if (!rowEl) {
                rowEl = document.createElement('div');
                rowEl.className = 'xx-row xx-think-row';
                rowEl.dataset.rowOpenKey = rowOpenKey;
                rowEl.innerHTML =
                  '<button class="xx-row-head xx-think-head" type="button">' +
                    '<span class="xx-lead" data-ico="think">' +
                      '<span class="xx-act-ico">' + ICONS.think + '</span>' +
                      '<span class="xx-act-chev">' + ICONS.chevDown + '</span>' +
                    '</span>' +
                    '<span class="xx-row-title">思考</span>' +
                    '<span class="xx-row-steps-pill"></span>' +
                    '<span class="xx-row-sep"></span>' +
                    '<span class="xx-row-sum"></span>' +
                    '<span class="xx-row-time"></span>' +
                  '</button>' +
                  '<div class="xx-row-body-shell"><div class="xx-row-body-inner"><div class="xx-row-body">' +
                    '<div class="xx-think-md"></div>' +
                    '<div class="xx-row-foot">' +
                      '<span class="xx-foot-meta"></span>' +
                      '<span class="xx-foot-actions"></span>' +
                    '</div>' +
                  '</div></div></div>';
              }

              const rawText = item.thinking || '';
              const zhFull = item.translatedThinking || '';
              const isStepsStyle = (settings.translateStyle || 'natural') === 'steps';
              const wantFullDetail = isStepsStyle && fullDetailMap.get(item.id) === true;
              const showRawOverride = rawOverrideMap.get(item.id) === true;
              const effectiveMode = showRawOverride ? (mode === 'raw' ? 'zh' : 'raw') : mode;
              const running = item.status === 'generating';
              const isStreamingThink = running || (effectiveMode !== 'raw' && (item.translateStatus === 'translating' || (wantFullDetail && item.fullTranslateStatus === 'translating')));

              // 默认开启进行中自动展开当前思考行；关闭后单条思考默认收起、按需点开
              let rowOpen;
              if (userPinnedSet.has(rowOpenKey)) {
                rowOpen = openState.get(rowOpenKey) === true;
              } else if (openState.has(rowOpenKey)) {
                rowOpen = openState.get(rowOpenKey) === true;
              } else if (settings.autoExpandRunningThink !== false && isStreamingThink && turn.isRunning) {
                rowOpen = true;
                openState.set(rowOpenKey, true);
              } else {
                rowOpen = false;
              }

              const activeZh = wantFullDetail ? (item.fullTranslatedThinking || zhFull) : zhFull;
              const targetText = effectiveMode !== 'raw' && activeZh ? activeZh : rawText;
              const isBriefThink = !isStreamingThink && !wantFullDetail && rawText.length < 220 && targetText.length < 180 && !rawText.includes('\`\`\`');
              const useStepRender = isStepsStyle && !wantFullDetail && !isStreamingThink && !isBriefThink && effectiveMode !== 'raw' && Boolean(activeZh);

              let displayText = targetText;
              const modeKey = effectiveMode + ':' + (wantFullDetail ? 'full' : (useStepRender ? 'steps' : 'live')) + ':' + (activeZh && effectiveMode !== 'raw' ? 'zh' : 'raw');
              let rec = streamShownMap.get(item.id);
              if (!useSmooth) {
                streamShownMap.delete(item.id);
                displayText = targetText;
              } else {
                if (!rec || rec.modeKey !== modeKey) {
                  const startLen = isStreamingThink ? 0 : targetText.length;
                  rec = { text: targetText, shownLen: startLen, modeKey, rowEl, item, effectiveMode, running, isStreamingThink, summaryEnabled, policy, useStepRender, wantFullDetail };
                  streamShownMap.set(item.id, rec);
                } else {
                  rec.rowEl = rowEl;
                  rec.item = item;
                  rec.effectiveMode = effectiveMode;
                  rec.running = running;
                  rec.isStreamingThink = isStreamingThink;
                  rec.summaryEnabled = summaryEnabled;
                  rec.policy = policy;
                  rec.useStepRender = useStepRender;
                  rec.wantFullDetail = wantFullDetail;
                  rec.text = targetText;
                  if (rec.shownLen > targetText.length) {
                    rec.shownLen = targetText.length;
                  }
                }
                if (!isStreamingThink && !rowOpen && rec.shownLen < rec.text.length) {
                  rec.shownLen = rec.text.length;
                }
                if (rowOpen && rec.shownLen < rec.text.length) {
                  localNeedsStream = true;
                  needsStreamMore = true;
                }
                displayText = rec.text.slice(0, Math.min(rec.shownLen, rec.text.length));
              }

              const sumText = computeRowSummaryText(item, displayText, effectiveMode, isStreamingThink, summaryEnabled, wantFullDetail);
              const showPreview = Boolean(sumText) && (isStreamingThink || policy.settledReasoningPreview);

              rowEl.dataset.open = String(rowOpen);
              rowEl.dataset.running = String(running);
              rowEl.dataset.streaming = String(isStreamingThink);
              rowEl.dataset.brief = String(Boolean(isBriefThink));
              rowEl.dataset.preview = String(showPreview);
              rowEl.dataset.hideSum = String(hideSum);
              rowEl.dataset.full = String(expandedFullMap.get(item.id) === true);
              rowEl._thinkItem = item;
              rowEl._copyText = targetText;

              const chevEl = rowEl.querySelector('.xx-think-head .xx-act-chev');
              const wantChev = rowOpen ? ICONS.chevUp : ICONS.chevDown;
              if (chevEl && chevEl._lastHtml !== wantChev) {
                chevEl._lastHtml = wantChev;
                chevEl.innerHTML = wantChev;
              }
              const sumEl = rowEl.querySelector('.xx-row-sum');
              if (sumEl && sumEl.textContent !== sumText) sumEl.textContent = sumText;
              const stepCount = useStepRender ? countThinkingSteps(activeZh || targetText) : 0;
              const stepPillEl = rowEl.querySelector('.xx-row-steps-pill');
              const stepPillText = item.translatePhase === 'distilling'
                ? '整理脉络'
                : (stepCount > 1 ? (stepCount + ' 步') : '');
              if (stepPillEl && stepPillEl.textContent !== stepPillText) stepPillEl.textContent = stepPillText;

              let tStr = '';
              if (running && item.startedAtMs) {
                tStr = Math.max(0, (Date.now() - item.startedAtMs) / 1000).toFixed(1) + 's';
              } else if (typeof item.durationSec === 'number') {
                tStr = item.durationSec.toFixed(1) + 's';
              }
              const timeEl = rowEl.querySelector('.xx-row-time');
              if (timeEl && timeEl.textContent !== tStr) timeEl.textContent = tStr;

              const renderThinkBody = () => {
                const liveRec = streamShownMap.get(item.id);
                const curDisplayText = liveRec
                  ? liveRec.text.slice(0, Math.min(liveRec.shownLen, liveRec.text.length))
                  : targetText;
                const curStreaming = isStreamingThink || Boolean(liveRec && liveRec.shownLen < liveRec.text.length);
                const bodySig = curDisplayText.length + ':' + curDisplayText.slice(-24) + '|' + rawText.length + '|' + effectiveMode + '|' + wantFullDetail + '|' + useStepRender + '|' + isBriefThink + '|' + (item.translateStatus || '') + '|' + (item.translatePhase || '') + '|' + (item.fullTranslateStatus || '') + '|' + (item.fullTranslateError || '') + '|' + (item.translateModel || '') + '|' + (item.translateError || '') + '|' + running + '|' + curStreaming + '|' + (settings.thinkHeightMode || 'full') + '|' + (item.thinkingTokens || 0) + '|' + (expandedFullMap.get(item.id) === true);
                if (rowEl.dataset.bodySig === bodySig) return;
                rowEl.dataset.bodySig = bodySig;

                const cursor = curStreaming ? '<span class="xx-cursor"></span>' : '';
                const bilingualExtra = effectiveMode === 'bilingual' && activeZh && activeZh !== rawText
                  ? '<div class="xx-bilingual-raw">' + renderMarkdown(rawText) + '</div>'
                  : '';
                const rendered = renderThinkingSteps(curDisplayText, useStepRender);
                const mdHtml = (rendered || '<p>正在酝酿思路…</p>') + cursor + bilingualExtra;
                const mdEl = rowEl.querySelector('.xx-think-md');
                if (mdEl && mdEl._lastHtml !== mdHtml) {
                  const nearBottom = mdEl.scrollHeight - mdEl.scrollTop - mdEl.clientHeight < 48;
                  const settledToSteps = Boolean(mdEl._wasStreaming) && !curStreaming && useStepRender;
                  mdEl._lastHtml = mdHtml;
                  mdEl.innerHTML = mdHtml;
                  if (curStreaming && nearBottom && rowEl.dataset.full !== 'true') {
                    mdEl.scrollTop = mdEl.scrollHeight;
                  } else if (settledToSteps) {
                    mdEl.scrollTop = 0;
                  }
                }
                if (mdEl) mdEl._wasStreaming = curStreaming;

                const chipsHtml = buildFootChips(item, running, wantFullDetail);
                const metaEl = rowEl.querySelector('.xx-foot-meta');
                if (metaEl && metaEl._lastHtml !== chipsHtml) {
                  metaEl._lastHtml = chipsHtml;
                  metaEl.innerHTML = chipsHtml;
                }

                const isFullNow = rowEl.dataset.full === 'true';
                const canRetry = Boolean(settings.translateEnabled !== false && item.translateStatus !== 'off' && item.translateStatus !== 'no-key' && item.translateStatus !== 'no-model' && item.translateModel !== 'native-zh');
                const detailBtn = (wantFullDetail || !isStreamingThink) && isStepsStyle && !isBriefThink && effectiveMode !== 'raw' && zhFull && item.translateModel !== 'native-zh'
                  ? '<button class="xx-btn xx-toggle-detail" type="button">' + (wantFullDetail ? '看脉络' : '看完整') + '</button>'
                  : '';
                const langBtn = zhFull && zhFull !== rawText
                  ? '<button class="xx-btn xx-toggle-lang" type="button">' + (effectiveMode === 'raw' ? '看中文' : '看原文') + '</button>'
                  : '';
                const retryBtn = canRetry
                  ? '<button class="xx-btn xx-retry-btn" type="button">重译</button>'
                  : '';
                const expandBtn = '<button class="xx-btn xx-expand-full-btn" type="button">' + (isFullNow ? '收起高度' : '展开全文') + '</button>';
                const actHtml = expandBtn + detailBtn + langBtn + retryBtn + '<button class="xx-btn xx-copy-btn" type="button">复制</button>';
                const actEl = rowEl.querySelector('.xx-foot-actions');
                if (actEl && actEl._lastHtml !== actHtml) {
                  actEl._lastHtml = actHtml;
                  actEl.innerHTML = actHtml;
                }
                if (mdEl) syncThinkOverflow(rowEl, mdEl);
              };

              rowEl._renderThinkBody = renderThinkBody;
              nextRowEls.push(rowEl);
            } else {
              // 单条工具行（DSH 默认收起，点击展开参数/命令详情）
              const rowOpenKey = turnKey + ':tl:' + item.id;
              const act = classifyToolActivity(item);
              const icoKey = activityIconKey(act);
              let rowEl = existingRows.get(rowOpenKey);
              if (!rowEl) {
                rowEl = document.createElement('div');
                rowEl.className = 'xx-row xx-tool-row';
                rowEl.dataset.rowOpenKey = rowOpenKey;
                rowEl.innerHTML =
                  '<button class="xx-row-head xx-tool-head" type="button">' +
                    '<span class="xx-lead">' +
                      '<span class="xx-act-ico"></span>' +
                      '<span class="xx-act-chev">' + ICONS.chevDown + '</span>' +
                    '</span>' +
                    '<span class="xx-row-title"></span>' +
                    '<span class="xx-row-sep"></span>' +
                    '<span class="xx-row-sum"></span>' +
                    '<span class="xx-row-time"></span>' +
                  '</button>' +
                  '<div class="xx-row-body-shell"><div class="xx-row-body-inner"><div class="xx-row-body">' +
                    '<pre class="xx-detail-pre"></pre>' +
                    '<div class="xx-row-foot">' +
                      '<span class="xx-foot-meta"></span>' +
                      '<span class="xx-foot-actions"><button class="xx-btn xx-copy-btn" type="button">复制</button></span>' +
                    '</div>' +
                  '</div></div></div>';
              }

              const rowOpen = openState.get(rowOpenKey) === true;
              const running = item.status === 'running';
              const isErr = item.status === 'error';
              const sumText = item.summary || item.liveDetail || item.toolName || '';

              rowEl.dataset.open = String(rowOpen);
              rowEl.dataset.running = String(running);
              rowEl.dataset.streaming = String(running);
              rowEl.dataset.preview = String(Boolean(sumText));
              rowEl._toolItem = item;
              rowEl._copyText = item.detail || sumText;

              const headEl = rowEl.querySelector('.xx-tool-head');
              const leadEl = headEl.querySelector('.xx-lead');
              const headSig = icoKey + '|' + item.label + '|' + sumText + '|' + rowOpen + '|' + isErr;
              if (headEl.dataset.sig !== headSig) {
                headEl.dataset.sig = headSig;
                leadEl.dataset.ico = icoKey;
                leadEl.dataset.err = String(isErr);
                headEl.querySelector('.xx-act-ico').innerHTML = ICONS[icoKey] || ICONS.tool;
                headEl.querySelector('.xx-act-chev').innerHTML = rowOpen ? ICONS.chevUp : ICONS.chevDown;
                headEl.querySelector('.xx-row-title').textContent = item.label || '工具调用';
                const sumEl = headEl.querySelector('.xx-row-sum');
                sumEl.textContent = sumText;
                sumEl.classList.toggle('xx-row-err', isErr);
              }

              let tStr = '';
              if (running && item.startedAtMs) {
                tStr = Math.max(0, (Date.now() - item.startedAtMs) / 1000).toFixed(1) + 's';
              } else if (typeof item.durationSec === 'number') {
                tStr = item.durationSec.toFixed(1) + 's';
              }
              const timeEl = rowEl.querySelector('.xx-row-time');
              if (timeEl && timeEl.textContent !== tStr) timeEl.textContent = tStr;

              const renderToolBody = () => {
                const detailTxt = item.detail || sumText || '{}';
                const pre = rowEl.querySelector('.xx-detail-pre');
                if (pre && pre.textContent !== detailTxt) pre.textContent = detailTxt;
                const metaEl = rowEl.querySelector('.xx-foot-meta');
                const chipHtml = isErr
                  ? '<span class="xx-chip err">执行异常</span>'
                  : '<span class="xx-chip">' + escapeHtml(item.toolName || item.label || 'tool') + '</span>';
                if (metaEl && metaEl._lastHtml !== chipHtml) {
                  metaEl._lastHtml = chipHtml;
                  metaEl.innerHTML = chipHtml;
                }
              };

              rowEl._renderToolBody = renderToolBody;
              nextRowEls.push(rowEl);
            }
          }

          const curRowEls = Array.from(bodyEl.children);
          const sameRows = curRowEls.length === nextRowEls.length && curRowEls.every((el, idx) => el === nextRowEls[idx]);
          if (!sameRows) bodyEl.replaceChildren(...nextRowEls);

          // 节点已挂入真实 DOM 后再渲染正文与测量高度，避免游离态 clientHeight/scrollHeight 恒为 0 导致「展开全文」失效
          const needDeferredMeasure = [];
          for (const rowEl of nextRowEls) {
            if (rowEl.dataset.open !== 'true') continue;
            if (rowEl._renderThinkBody) {
              rowEl._renderThinkBody();
              const mdEl = rowEl.querySelector('.xx-think-md');
              if (mdEl && mdEl.clientHeight < 40) needDeferredMeasure.push([rowEl, mdEl]);
            } else if (rowEl._renderToolBody) {
              rowEl._renderToolBody();
            }
          }
          if (needDeferredMeasure.length > 0) {
            setTimeout(() => {
              for (const [rEl, mEl] of needDeferredMeasure) {
                if (rEl.isConnected && rEl.dataset.open === 'true') syncThinkOverflow(rEl, mEl);
              }
            }, 220);
          }

          const isGroupedNow = grpEl.dataset.grouped === 'true';
          const isGroupOpenNow = grpEl.dataset.groupOpen === 'true';
          const isLiveNow = grpEl.dataset.live === 'true';
          if (isGroupedNow && isGroupOpenNow) {
            if (isLiveNow && groupFollowMap.get(groupOpenKey) === true) {
              bodyEl.scrollTop = bodyEl.scrollHeight;
            }
            updateGroupScrollFades(bodyEl);
          } else {
            bodyEl.classList.remove('xx-fade-top', 'xx-fade-bottom');
          }
          if (localNeedsStream) scheduleStreamTick();
        };

        grpEl._renderMembers = renderMembers;
        if (turnOpen && groupOpen) pendingMemberRenderers.push(renderMembers);
        nextGroupEls.push(grpEl);
      }

      // 清理该轮次因单个工具升级成连续工具胶囊（tl: -> tc:）而废弃的 liveTitleCache 条目
      const turnGroupPrefix = turnKey + ':g:';
      for (const [k, rec] of liveTitleCache.entries()) {
        if (k.startsWith(turnGroupPrefix) && !activeLiveKeys.has(k)) {
          if (rec?.timer) clearTimeout(rec.timer);
          liveTitleCache.delete(k);
        }
      }

      const curGroups = Array.from(groupsBox.children);
      const sameGroups = curGroups.length === nextGroupEls.length && curGroups.every((el, idx) => el === nextGroupEls[idx]);
      if (!sameGroups) groupsBox.replaceChildren(...nextGroupEls);

      for (const runMembers of pendingMemberRenderers) runMembers();

      if (needsStreamMore) scheduleStreamTick();
    }

    function scheduleStreamTick() {
      if (streamRaf) return;
      streamRaf = requestAnimationFrame((ts) => {
        streamRaf = 0;
        if (document.visibilityState !== 'visible') {
          for (const rec of streamShownMap.values()) {
            rec.shownLen = rec.text.length;
            if (rec.rowEl && rec.rowEl.isConnected) {
              updateThinkRowStreamDom(rec.rowEl, rec.text, rec.item, rec.effectiveMode, rec.running, rec.isStreamingThink, rec.summaryEnabled, rec.policy, rec.useStepRender, rec.wantFullDetail);
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
        for (const [itemId, rec] of streamShownMap.entries()) {
          if (rec.rowEl && !rec.rowEl.isConnected) {
            streamShownMap.delete(itemId);
            continue;
          }
          if (rec.shownLen < rec.text.length) {
            const delta = rec.text.length - rec.shownLen;
            const step = Math.max(2, Math.min(12, Math.ceil(delta / 5)));
            rec.shownLen = Math.min(rec.text.length, rec.shownLen + step);
            if (rec.rowEl && rec.rowEl.isConnected) {
              const shown = rec.text.slice(0, rec.shownLen);
              updateThinkRowStreamDom(rec.rowEl, shown, rec.item, rec.effectiveMode, rec.running, rec.isStreamingThink || rec.shownLen < rec.text.length, rec.summaryEnabled, rec.policy, rec.useStepRender, rec.wantFullDetail);
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
        return { ok: true, responseCount: 0, hostCount: 0 };
      }

      const domConvId = detectConversationId();
      if (domConvId && lastData.activeId && domConvId !== lastData.activeId) {
        return { ok: false };
      }

      if (lastData.activeId && lastActiveConvId && lastData.activeId !== lastActiveConvId) {
        streamShownMap.clear();
        openState.clear();
        userPinnedSet.clear();
        turnAutoFoldedSet.clear();
        seenActiveTurns.clear();
        clearAllFoldTimers();
        groupFollowMap.clear();
        clearLiveTitleTimers();
        rawOverrideMap.clear();
        fullDetailMap.clear();
        expandedFullMap.clear();
      }
      if (lastData.activeId) lastActiveConvId = lastData.activeId;

      const curStyle = lastSettings?.translateStyle || 'natural';
      if (lastTranslateStyle && curStyle !== lastTranslateStyle) {
        streamShownMap.clear();
      }
      lastTranslateStyle = curStyle;

      const curCacheEpoch = Number(lastData.cacheEpoch || 0);
      if (lastCacheEpoch !== -1 && curCacheEpoch !== lastCacheEpoch) {
        fullDetailMap.clear();
        streamShownMap.clear();
      }
      lastCacheEpoch = curCacheEpoch;

      const responses = Array.from(document.querySelectorAll('[data-testid="agent-response"]'));
      const turns = lastData.turns || [];
      if (turns.length === 0) {
        cleanupHosts();
        return { ok: true, responseCount: responses.length, hostCount: 0 };
      }
      if (responses.length === 0) return { ok: false };

      const theme = detectTheme();
      const paired = pairResponsesToTurns(responses, turns);

      for (let i = 0; i < paired.length; i++) {
        const { resp, turn } = paired[i];
        const hasVisibleProcess = turn && (turn.hasProcess || (Array.isArray(turn.items) && turn.items.some((it) => it.kind !== 'reply-boundary')));
        if (!hasVisibleProcess) {
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
        const lastTurnIndex = turns.length > 0 ? turns[turns.length - 1].turnIndex : -1;
        renderTurnIntoHost(host, turn, turn.turnIndex === lastTurnIndex, lastSettings, theme);
      }

      let hostCount = 0;
      for (const r of responses) {
        if (r.querySelector(':scope > .agy-thinking-inline-host')) hostCount++;
      }
      return { ok: true, responseCount: responses.length, hostCount };
    }

    function apply(data, settings, owner) {
      if (owner < (globalThis.__agyThinkingInline?.owner || 0)) return 'superseded';
      lastData = data;
      lastSettings = settings;
      return renderAll();
    }

    function readState(owner) {
      if (owner < (globalThis.__agyThinkingInline?.owner || 0)) return 'superseded';
      const drained = pendingActions.length > 0 ? pendingActions.splice(0, pendingActions.length) : [];
      const responses = document.querySelectorAll('[data-testid="agent-response"]');
      let hostCount = 0;
      for (const r of responses) {
        if (r.querySelector(':scope > .agy-thinking-inline-host')) hostCount++;
      }
      return {
        owner: OWNER,
        hash: ${JSON.stringify(createHash('sha1').update(String(owner)).digest('hex').slice(0, 12))},
        convId: detectConversationId(),
        hasResponses: responses.length > 0,
        responseCount: responses.length,
        hostCount,
        visible: document.visibilityState === 'visible',
        actions: drained,
      };
    }

    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
      for (const rec of streamShownMap.values()) {
        if (rec.rowEl && rec.rowEl.isConnected) {
          const shown = rec.text.slice(0, Math.min(rec.shownLen, rec.text.length));
          updateThinkRowStreamDom(rec.rowEl, shown, rec.item, rec.effectiveMode, rec.running, rec.isStreamingThink || rec.shownLen < rec.text.length, rec.summaryEnabled, rec.policy, rec.useStepRender, rec.wantFullDetail);
        }
      }
      renderAll();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    function dispose() {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (timerHandle) clearInterval(timerHandle);
      if (streamRaf) cancelAnimationFrame(streamRaf);
      clearLiveTitleTimers();
      streamShownMap.clear();
      openState.clear();
      userPinnedSet.clear();
      turnAutoFoldedSet.clear();
      seenActiveTurns.clear();
      clearAllFoldTimers();
      groupFollowMap.clear();
      rawOverrideMap.clear();
      fullDetailMap.clear();
      expandedFullMap.clear();
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
        const barEl = shadow.querySelector('.xx-turn-bar');
        if (labelEl) {
          const info = renderTurnLabelInfo(turn, lastSettings);
          if (labelEl._lastHtml !== info.html) {
            labelEl._lastHtml = info.html;
            labelEl.innerHTML = info.html;
          }
          if (barEl && barEl.title !== info.title) barEl.title = info.title;
        }
        for (const rowEl of shadow.querySelectorAll('.xx-row[data-running="true"]')) {
          const item = rowEl._thinkItem || rowEl._toolItem;
          if (!item?.startedAtMs) continue;
          const timeEl = rowEl.querySelector('.xx-row-time');
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
    const entry = { id: target.id, ws, pending: new Map(), nextId: 1, lastSig: '', lastConvId: '', lastResponseCount: -1, lastHostCount: -1, visible: true };
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        retire(entry, target.id);
        reject(new Error(msg));
      };
      const t = setTimeout(() => fail('ws timeout'), 3000);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve();
      };
      ws.onerror = () => fail('ws error');
      ws.onclose = () => fail('ws closed');
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
    ws.onerror = () => retire(entry, target.id);
    sockets.set(target.id, entry);
    return entry;
  };

  const evaluate = (entry, expression, opts = {}) =>
    new Promise((resolve) => {
      const retireBad = () => {
        if (opts.retireOnFail !== false && !entry.closed) {
          retire(entry, entry.id);
          lastListAt = 0;
        }
      };
      if (entry.closed || entry.ws.readyState !== 1) {
        retireBad();
        return resolve(undefined);
      }
      const id = entry.nextId++;
      const t = setTimeout(() => {
        entry.pending.delete(id);
        retireBad();
        resolve(undefined);
      }, 3000);
      entry.pending.set(id, (msg) => {
        clearTimeout(t);
        if (!msg || msg.error) {
          retireBad();
          return resolve(undefined);
        }
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
        retireBad();
        resolve(undefined);
      }
    });

  const retireAllSockets = () => {
    for (const [id, entry] of [...sockets]) {
      retire(entry, id);
    }
  };

  const listPages = async (force = false) => {
    if (typeof WebSocket !== 'function') {
      cdpState = 'no-ws';
      return [];
    }
    if (!force && cachedPages.length && Date.now() - lastListAt < 10000) return cachedPages;
    let port;
    try {
      port = readFileSync(PORT_FILE, 'utf-8').split(/\r?\n/)[0].trim();
    } catch {
      cdpState = 'missing';
      cachedPages = [];
      lastListAt = 0;
      retireAllSockets();
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
      cdpState = cachedPages.length > 0 ? 'ok' : 'no-page';
      const validIds = new Set(cachedPages.map((t) => t.id));
      for (const [id, entry] of sockets) {
        if (!validIds.has(id)) retire(entry, id);
      }
      return cachedPages;
    } catch {
      cdpState = 'unreachable';
      cachedPages = [];
      lastListAt = 0;
      retireAllSockets();
      return [];
    }
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    timer = null;
    clearTimeout(cachedPushTimer);
    cachedPushTimer = null;
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
      cacheEpoch: data.runtime?.cacheEpoch || 0,
      turns: data.turns,
    };
    const sig = computeSlimSignature(slimData, publicSettings);
    if (entry.lastSig === sig) return false;

    const res = await evaluate(
      entry,
      `globalThis.__agyThinkingInline?.apply(${JSON.stringify(slimData)},${JSON.stringify(publicSettings)},${owner})??false`
    );
    if (res === 'superseded') {
      cdpState = 'superseded';
      await stop();
      return false;
    }
    if (res && (res === true || res.ok)) {
      entry.lastSig = sig;
      if (typeof res === 'object') {
        entry.lastResponseCount = res.responseCount;
        entry.lastHostCount = res.hostCount;
      }
      lastChangeAt = Date.now();
      return true;
    }
    return false;
  }

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
      busy = true;
      const shouldTrigger = pendingCachedTriggerNew;
      pendingCachedTriggerNew = false;
      try {
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
      } finally {
        busy = false;
        if (!stopped) {
          const latestSettings = getSettings();
          if (pendingCachedPush) {
            pendingCachedPush = false;
            if (latestSettings.inlineEnabled) pushCached(pendingCachedTriggerNew);
            else pendingCachedTriggerNew = false;
          }
          if (pendingNudge || (!timer && latestSettings.inlineEnabled)) {
            pendingNudge = false;
            clearTimeout(timer);
            timer = setTimeout(tick, 120);
          }
        }
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
    timer = null;
    if (stopped) return;
    if (busy) {
      // pushCached 正在占用锁时绝不能吞掉 tick，标记 pendingNudge 由其 finally 立即补跑
      pendingNudge = true;
      return;
    }
    busy = true;
    let anyGenerating = false;
    let anyVisible = false;
    const settings = getSettings();
    const publicSettings = getPublicSettings();
    try {
      if (!settings.inlineEnabled) {
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
        cachedPages = [];
        lastListAt = 0;
        return;
      }

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

          const nextConvId = state.convId || '';
          const responseCountChanged = state.responseCount !== entry.lastResponseCount;
          if (
            nextConvId !== entry.lastConvId ||
            responseCountChanged ||
            state.hostCount !== entry.lastHostCount
          ) {
            entry.lastSig = '';
          }
          entry.visible = state.visible !== false;
          entry.lastConvId = nextConvId;
          if (entry.visible) anyVisible = true;

          if (Array.isArray(state.actions) && state.actions.length > 0) {
            for (const act of state.actions) {
              try { options.onAction?.(act); } catch {}
            }
          }

          if (!state.hasResponses) continue;
          if (!entry.visible && entry.lastSig) continue;

          const data = await inspectByConvId(state.convId || '', settings, { force: responseCountChanged });
          if (!data || stopped) continue;
          if (data.isGenerating || data.activeStatus === 'CASCADE_RUN_STATUS_RUNNING') {
            anyGenerating = true;
            lastActiveAt = Date.now();
          }

          await pushDataToEntry(entry, data, publicSettings);
        } catch {
          const entry = sockets.get(target.id);
          if (entry) retire(entry, target.id);
          lastListAt = 0;
        }
      }
    } finally {
      busy = false;
      if (!stopped) {
        const latestSettings = getSettings();
        if (pendingCachedPush) {
          pendingCachedPush = false;
          if (latestSettings.inlineEnabled) pushCached(pendingCachedTriggerNew);
          else pendingCachedTriggerNew = false;
        }
        if (latestSettings.inlineEnabled || pendingNudge) {
          const nextDelay = pendingNudge
            ? 120
            : computeNextDelay(anyGenerating, anyVisible, latestSettings.inlineEnabled);
          pendingNudge = false;
          clearTimeout(timer);
          timer = setTimeout(tick, nextDelay);
        } else {
          clearTimeout(timer);
          timer = null;
        }
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

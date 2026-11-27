import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSettingsStore, validateSettings } from './settings.mjs';
import { buildTurnsPayload } from './trajectory.mjs';
import { startInlineInjector } from './inline_injector.mjs';
import { createTranslator } from './translator.mjs';
import { buildSharedBrowserScript } from './shared_render.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIND_HOST = '127.0.0.1';
const UI_TOKEN = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
const WEB_PORT = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '0', 10);
const DEFAULT_CONV_ID = process.env.ANTIGRAVITY_CONVERSATION_ID || '';

// 防止宿主关闭 stdio 管道时触发 EPIPE 异常退出
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', (err) => {
    if (err?.code !== 'EPIPE') throw err;
  });
}

const settingsStore = createSettingsStore();
let inlineInjector = null;
const clients = new Set();
let pollTimer = null;
let isPolling = false;
let pendingPollDelay = null;
let cachedBroadcastPending = false;
let cachedBroadcastTriggerNew = false;
let settingsVersion = 0;

// ─── 单飞 + TTL 缓存层：彻底消灭高频重复调用 GetAllCascadeTrajectories / GetCascadeTrajectory ───
const runtimeStats = {
  lsListCalls: 0,
  lsTrajCalls: 0,
  pollMode: 'idle', // 'streaming' | 'cooldown' | 'idle' | 'sleeping'
  lastActiveAt: 0,
  lastChangeAt: Date.now(),
};

const activeConvMap = new Map(); // convId -> lastRunningAtMs

let conversationsCache = { list: [], fetchedAt: 0 };
let inFlightConversations = null;

const trajectoryCache = new Map(); // convId -> { data, fetchedAt, isRunning }
const inFlightTrajectories = new Map(); // convId -> Promise
const lastResolvedConvByKey = new Map(); // `${requestedId}::${hostConvId}` -> convId

function isUuidLike(str) {
  return typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim());
}

function updateConvActivity(convId, isRunning) {
  if (!convId) return;
  const now = Date.now();
  if (isRunning) {
    activeConvMap.set(convId, now);
    runtimeStats.lastActiveAt = now;
  } else {
    activeConvMap.delete(convId);
  }
}

function isAnyConvActive(now = Date.now()) {
  for (const [id, ts] of activeConvMap.entries()) {
    if (now - ts < 2500) return true;
    activeConvMap.delete(id);
  }
  return false;
}

function getPollMode() {
  const now = Date.now();
  const s = settingsStore.read();
  if (clients.size === 0 && !s.inlineEnabled) return 'sleeping';
  if (isAnyConvActive(now)) return 'streaming';
  if (now - runtimeStats.lastActiveAt < 4500) return 'cooldown';
  return 'idle';
}

function getCurrentPollIntervalMs() {
  const mode = getPollMode();
  runtimeStats.pollMode = mode;
  if (mode === 'streaming') return 350;
  if (mode === 'cooldown') return 1000;
  const quietFor = Date.now() - runtimeStats.lastChangeAt;
  return quietFor > 20000 ? 4000 : 2500;
}

const translator = createTranslator(
  () => settingsStore.read(),
  () => {
    // 翻译流式吐新字时只读内存缓存刷新，绝不再触发 LS RPC！
    scheduleCachedBroadcast(false);
    inlineInjector?.pushCached?.();
  }
);

function loadPreloadJs() {
  try {
    const require = createRequire(import.meta.url);
    return readFileSync(require.resolve('sidecar_sdk/preload.js'), 'utf-8');
  } catch {
    const fallback = join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js');
    if (existsSync(fallback)) return readFileSync(fallback, 'utf-8');
    return '';
  }
}

const PRELOAD_JS = loadPreloadJs();
const SHARED_JS = buildSharedBrowserScript();

function readUiHtml() {
  return readFileSync(join(__dirname, 'ui.html'), 'utf-8');
}

function validateToken(req, url) {
  if (!UI_TOKEN) return true;
  const provided = req.headers['x-sidecar-token'] || url.searchParams.get('token');
  return provided === UI_TOKEN;
}

async function callLs(method, body = {}) {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddr || !csrf) {
    throw new Error('缺少 ANTIGRAVITY_LS_ADDRESS 或 ANTIGRAVITY_CSRF_TOKEN 环境变量');
  }
  const res = await fetch(`http://${lsAddr}/exa.language_server_pb.LanguageServerService/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-codeium-csrf-token': csrf,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4500),
  });
  if (!res.ok) {
    throw new Error(`LS RPC ${method} HTTP ${res.status}`);
  }
  return res.json();
}

async function listConversationsCached(options = {}) {
  const now = Date.now();
  const mode = getPollMode();
  const ttl = options.force ? 0 : (mode === 'streaming' ? 3000 : 8000);
  if (conversationsCache.fetchedAt > 0 && now - conversationsCache.fetchedAt < ttl) {
    return conversationsCache.list;
  }
  if (inFlightConversations) return inFlightConversations;

  inFlightConversations = (async () => {
    try {
      runtimeStats.lsListCalls += 1;
      const data = await callLs('GetAllCascadeTrajectories', {});
      const map = data?.trajectorySummaries || {};
      const list = Object.entries(map)
        .map(([id, info]) => {
          const parsedMtime = info?.lastModifiedTime ? Date.parse(info.lastModifiedTime) : 0;
          return {
            id,
            summary: info?.summary || id.slice(0, 8),
            status: info?.status || '',
            lastModifiedTime: info?.lastModifiedTime || '',
            mtimeMs: Number.isFinite(parsedMtime) ? parsedMtime : 0,
          };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      conversationsCache = { list, fetchedAt: Date.now() };
      return list;
    } finally {
      inFlightConversations = null;
    }
  })();

  return inFlightConversations;
}

async function fetchTrajectoryCached(activeId, options = {}) {
  if (!activeId) return null;
  const now = Date.now();
  const entry = trajectoryCache.get(activeId);
  const mode = getPollMode();
  const ttl = options.force
    ? 0
    : entry?.isRunning || mode === 'streaming'
      ? 340
      : mode === 'cooldown'
        ? 950
        : 2400;

  if (entry && now - entry.fetchedAt < ttl) {
    return entry.data;
  }

  const existingPromise = inFlightTrajectories.get(activeId);
  if (existingPromise) return existingPromise;

  const p = (async () => {
    try {
      runtimeStats.lsTrajCalls += 1;
      const data = await callLs('GetCascadeTrajectory', { cascadeId: activeId });
      const steps = Array.isArray(data?.trajectory?.steps) ? data.trajectory.steps : [];
      const trajStatus = data?.status || data?.trajectory?.status || '';
      const isRunning =
        trajStatus === 'CASCADE_RUN_STATUS_RUNNING' ||
        steps.some((st) =>
          st?.status === 'CORTEX_STEP_STATUS_GENERATING' ||
          st?.status === 'CORTEX_STEP_STATUS_RUNNING' ||
          st?.status === 'CORTEX_STEP_STATUS_PENDING' ||
          st?.status === 'CORTEX_STEP_STATUS_WAITING'
        );
      updateConvActivity(activeId, isRunning);
      // 先删后插实现真正 LRU，确保最新访问的对话排在队尾，避免误删活跃对话或卡住清理循环
      trajectoryCache.delete(activeId);
      trajectoryCache.set(activeId, { data, fetchedAt: Date.now(), isRunning });
      // 只保留最近 6 条对话轨迹缓存，防止长时运行内存膨胀
      while (trajectoryCache.size > 6) {
        const oldestKey = trajectoryCache.keys().next().value;
        if (!oldestKey || oldestKey === activeId) break;
        trajectoryCache.delete(oldestKey);
        activeConvMap.delete(oldestKey);
      }
      return data;
    } finally {
      inFlightTrajectories.delete(activeId);
    }
  })();

  inFlightTrajectories.set(activeId, p);
  return p;
}

function pickActiveConversation(conversations, requestedId, hostConvId) {
  if (requestedId && requestedId !== 'auto') {
    if (conversations.some((c) => c.id === requestedId)) return requestedId;
    if (isUuidLike(requestedId)) return requestedId;
  }
  const running = conversations.find((c) => c.status === 'CASCADE_RUN_STATUS_RUNNING');
  if (running) return running.id;
  if (hostConvId && conversations.some((c) => c.id === hostConvId)) return hostConvId;
  if (isUuidLike(hostConvId)) return hostConvId;
  return conversations[0]?.id || '';
}

const ALLOWED_EXTERNAL_HOSTS = new Set([
  'cloud.siliconflow.cn',
  'cloud.siliconflow.com',
  'platform.deepseek.com',
  'open.bigmodel.cn',
  'bigmodel.cn',
  'bailian.console.aliyun.com',
  'openrouter.ai',
  'ollama.com',
]);

function openOfficialExternalUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('无效的网址格式');
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('仅允许打开官方白名单服务商控制台页面');
  }
  const safeUrl = parsed.toString();
  let child;
  if (process.platform === 'win32') {
    child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', safeUrl], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  } else if (process.platform === 'darwin') {
    child = spawn('open', [safeUrl], { detached: true, stdio: 'ignore' });
  } else {
    child = spawn('xdg-open', [safeUrl], { detached: true, stdio: 'ignore' });
  }
  child.unref();
  return safeUrl;
}

function attachRuntimeMeta(payload) {
  const tStats = translator.getStats();
  payload.runtime = {
    pollMode: getPollMode(),
    cacheCount: tStats.cacheCount,
    cacheEpoch: tStats.cacheEpoch,
    activeModel: tStats.activeModel,
    inFlightTranslations: tStats.inFlightCount,
    usage: tStats.usage,
    lsListCalls: runtimeStats.lsListCalls,
    lsTrajCalls: runtimeStats.lsTrajCalls,
  };
  return payload;
}

async function fetchSnapshot(requestedId = 'auto', hostConvId = DEFAULT_CONV_ID, settings = settingsStore.read(), options = {}) {
  const needList = options.includeConversations !== false;
  let conversations = conversationsCache.list;
  let activeId = '';

  // 如果已经知道明确的 UUID 且调用方不关心完整列表（比如内嵌注入器），直接跳过 GetAllCascadeTrajectories！
  if (!needList && isUuidLike(requestedId)) {
    activeId = requestedId;
  } else {
    conversations = await listConversationsCached({ force: Boolean(options.forceList) });
    activeId = pickActiveConversation(conversations, requestedId, hostConvId);
  }

  lastResolvedConvByKey.set(`${requestedId}::${hostConvId}`, activeId);
  if (!activeId) {
    return attachRuntimeMeta(buildTurnsPayload(conversations, '', null, settings));
  }

  const wasActive = activeConvMap.has(activeId);
  const trajectoryData = await fetchTrajectoryCached(activeId, { force: Boolean(options.force) });
  const trajHasActive = trajectoryCache.get(activeId)?.isRunning === true;
  const cachedMeta = conversations.find((c) => c.id === activeId);
  const cachedSaysRunning = cachedMeta?.status === 'CASCADE_RUN_STATUS_RUNNING';

  // 内嵌模式跳过会话列表时，只要轨迹本身看不到运行中步骤，但之前活跃或旧缓存仍标着 RUNNING，
  // 就按最小 650ms 节流向 LS 复核最新状态：既防止空窗期提前收起，也彻底杜绝过期 RUNNING 缓存自举死锁
  let effectiveConversations = conversations;
  if (!needList && !trajHasActive && (wasActive || cachedSaysRunning)) {
    const cacheAge = Date.now() - conversationsCache.fetchedAt;
    if (cacheAge >= 650) {
      try {
        effectiveConversations = await listConversationsCached({ force: true });
      } catch {
        if (cacheAge > 8000) effectiveConversations = [];
      }
    }
  }

  const payload = buildTurnsPayload(effectiveConversations, activeId, trajectoryData, settings);
  const liveRunning = payload.isGenerating || payload.activeStatus === 'CASCADE_RUN_STATUS_RUNNING';
  updateConvActivity(activeId, liveRunning);
  translator.enrichTurns(payload.turns, { triggerNew: options.triggerNew !== false });
  return attachRuntimeMeta(payload);
}

/**
 * 纯内存热快照（0 次 LS RPC）：供翻译流式回调即时推送译文进度。
 */
function buildCachedSnapshot(requestedId = 'auto', hostConvId = DEFAULT_CONV_ID, settings = settingsStore.read(), triggerNew = false) {
  const key = `${requestedId}::${hostConvId}`;
  const activeId = isUuidLike(requestedId)
    ? requestedId
    : (lastResolvedConvByKey.get(key) || pickActiveConversation(conversationsCache.list, requestedId, hostConvId));
  if (!activeId) return null;
  const cached = trajectoryCache.get(activeId);
  if (!cached) return null;
  const payload = buildTurnsPayload(conversationsCache.list, activeId, cached.data, settings);
  translator.enrichTurns(payload.turns, { triggerNew });
  return attachRuntimeMeta(payload);
}

function sampleTextSig(str) {
  if (!str) return '0';
  const len = str.length;
  return `${len}:${str.slice(0, 16)}:${str.slice(-24)}`;
}

function computeSignature(payload, cdpState, publicSettings) {
  const convSig = (payload.conversations || [])
    .slice(0, 30)
    .map((c) => `${c.id}:${c.summary}:${c.status}`)
    .join(',');
  const uTot = payload.runtime?.usage?.total;
  const usageSig = uTot ? `${uTot.requests}:${uTot.cacheHits}:${uTot.inputTokens}:${uTot.outputTokens}:${uTot.updatedAt}` : '0';
  let hash = `${payload.activeId}|${payload.activeStatus}|${cdpState}|${payload.runtime?.pollMode || ''}|${payload.runtime?.cacheCount || 0}|${payload.runtime?.cacheEpoch || 0}|${payload.runtime?.activeModel || ''}|${usageSig}|${convSig}|${JSON.stringify(publicSettings)}|`;
  for (const turn of payload.turns) {
    hash += `${turn.turnIndex}:${turn.items.length}:${turn.isRunning}:${turn.hasError ? 1 : 0}:${turn.durationSec ?? ''}:`;
    for (const item of turn.items) {
      const len = item.kind === 'think' ? (item.thinking?.length || 0) : (item.detail?.length || 0);
      const stepHint = item.kind === 'think' ? '' : sampleTextSig(item.liveDetail || item.summary);
      const tSig = sampleTextSig(item.translatedThinking);
      const fSig = sampleTextSig(item.fullTranslatedThinking);
      const nSig = sampleTextSig(item.narrativeSummary);
      hash += `${item.id}/${item.status}/${len}/${stepHint}/${tSig}/${item.translateStatus || ''}/${item.translatePhase || ''}/${item.translateModel || ''}/${item.translateError || ''}/${fSig}/${item.fullTranslateStatus || ''}/${item.fullTranslateModel || ''}/${item.fullTranslateError || ''}/${nSig}/${item.narrativeStatus || ''}/${item.narrativeModel || ''}/${item.narrativeError || ''}/${item.thinkingTokens || 0}/${item.durationSec ?? ''};`;
    }
  }
  return hash;
}

function removeClient(client) {
  if (!client || client.closed) return;
  client.closed = true;
  if (client.keepalive) {
    clearInterval(client.keepalive);
    client.keepalive = null;
  }
  clients.delete(client);
  if (clients.size === 0) {
    clearTimeout(pollTimer);
    pollTimer = null;
    pendingPollDelay = null;
    runtimeStats.pollMode = getPollMode();
  }
}

function writeClientSafe(client, chunk) {
  if (client.closed) return false;
  try {
    client.res.write(chunk);
    return true;
  } catch {
    removeClient(client);
    return false;
  }
}

function broadcastCachedToClients(triggerNew = false) {
  if (clients.size === 0) return;
  const rawSettings = settingsStore.read();
  const publicSettings = settingsStore.readPublic();
  const cdpState = inlineInjector?.status?.() ?? 'unknown';

  const groups = new Map();
  for (const client of clients) {
    const key = `${client.requestedId}::${client.hostConvId}`;
    if (!groups.has(key)) {
      groups.set(key, { requestedId: client.requestedId, hostConvId: client.hostConvId, list: [] });
    }
    groups.get(key).list.push(client);
  }

  for (const group of groups.values()) {
    let payload = buildCachedSnapshot(group.requestedId, group.hostConvId, rawSettings, triggerNew);
    if (!payload && conversationsCache.list.length === 0 && !isUuidLike(group.requestedId)) {
      payload = attachRuntimeMeta(buildTurnsPayload([], '', null, rawSettings));
    }
    if (!payload) continue;
    payload.cdpState = cdpState;
    payload.settings = publicSettings;
    const sig = computeSignature(payload, cdpState, publicSettings);
    let encoded = '';
    for (const client of group.list) {
      if (client.lastSig !== sig) {
        if (!encoded) encoded = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
        client.lastSig = sig;
        client.lastErr = '';
        writeClientSafe(client, encoded);
      }
    }
  }
}

function scheduleCachedBroadcast(triggerNew = false) {
  if (clients.size === 0) return;
  if (triggerNew) cachedBroadcastTriggerNew = true;
  if (cachedBroadcastPending) return;
  cachedBroadcastPending = true;
  setTimeout(() => {
    const shouldTrigger = cachedBroadcastTriggerNew;
    cachedBroadcastPending = false;
    cachedBroadcastTriggerNew = false;
    broadcastCachedToClients(shouldTrigger);
  }, 90);
}

async function pollAndBroadcast() {
  if (isPolling) return;
  if (clients.size === 0) {
    clearTimeout(pollTimer);
    pollTimer = null;
    pendingPollDelay = null;
    runtimeStats.pollMode = getPollMode();
    return;
  }
  clearTimeout(pollTimer);
  pollTimer = null;
  pendingPollDelay = null;
  isPolling = true;

  let anyChanged = false;
  try {
    const groups = new Map();
    for (const client of clients) {
      const key = `${client.requestedId}::${client.hostConvId}`;
      if (!groups.has(key)) {
        groups.set(key, { requestedId: client.requestedId, hostConvId: client.hostConvId, list: [] });
      }
      groups.get(key).list.push(client);
    }

    for (const group of groups.values()) {
      try {
        const verBefore = settingsVersion;
        const rawSettings = settingsStore.read();
        let payload = await fetchSnapshot(group.requestedId, group.hostConvId, rawSettings);
        // 若在途 LS 轮询期间用户修改了设置，改用最新设置重算纯内存热快照，防止旧设置把界面开关弹回原状
        if (settingsVersion !== verBefore) {
          const refreshed = buildCachedSnapshot(group.requestedId, group.hostConvId, settingsStore.read(), false);
          if (refreshed) payload = refreshed;
        }
        const latestPublicSettings = settingsStore.readPublic();
        const latestCdpState = inlineInjector?.status?.() ?? 'unknown';
        payload.cdpState = latestCdpState;
        payload.settings = latestPublicSettings;
        const sig = computeSignature(payload, latestCdpState, latestPublicSettings);
        let encoded = '';
        for (const client of group.list) {
          client.lastErr = '';
          if (client.lastSig !== sig) {
            if (!encoded) encoded = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
            client.lastSig = sig;
            anyChanged = true;
            writeClientSafe(client, encoded);
          }
        }
      } catch (err) {
        const errMsg = `event: notice\ndata: ${JSON.stringify({ message: err.message })}\n\n`;
        for (const client of group.list) {
          if (client.lastErr !== err.message) {
            client.lastErr = err.message;
            writeClientSafe(client, errMsg);
          }
        }
      }
    }
  } finally {
    isPolling = false;
    if (anyChanged) runtimeStats.lastChangeAt = Date.now();
    if (clients.size > 0) {
      const nextDelay = pendingPollDelay !== null ? pendingPollDelay : getCurrentPollIntervalMs();
      pendingPollDelay = null;
      clearTimeout(pollTimer);
      pollTimer = setTimeout(pollAndBroadcast, nextDelay);
    }
  }
}

function ensurePollRunning(delayMs = 40) {
  if (clients.size === 0) return;
  if (isPolling) {
    pendingPollDelay = pendingPollDelay === null ? delayMs : Math.min(pendingPollDelay, delayMs);
    return;
  }
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollAndBroadcast, delayMs);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > 1024 * 1024) {
        settled = true;
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      let url;
      try {
        url = new URL(req.url || '/', `http://${BIND_HOST}:${WEB_PORT || 80}`);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }

    if (req.method === 'GET' && url.pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(PRELOAD_JS);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/shared.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(SHARED_JS);
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      try {
        const html = readUiHtml();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        res.end(`Failed to load UI: ${err.message}`);
      }
      return;
    }

    if (!validateToken(req, url)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (url.pathname === '/api/settings') {
      try {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(settingsStore.readPublic()));
          return;
        }
        if (req.method === 'POST') {
          const patch = await readJsonBody(req);
          if (typeof patch?.translateBaseUrl === 'string' && patch.translateBaseUrl.trim()) {
            const checkUrl = validateSettings({ translateBaseUrl: patch.translateBaseUrl });
            if (!checkUrl.translateBaseUrl) {
              throw new Error('API Base URL 格式无效，请以 http:// 或 https:// 开头');
            }
          }
          const prev = settingsStore.read();
          const cleanedPatch = validateSettings(patch);
          // 更换了服务商 Base URL 时，未显式传入新 Key/模型则自动清空旧服务商的 Key/模型，避免跨渠道串台
          const providerChanged = Boolean(
            cleanedPatch.translateBaseUrl &&
            cleanedPatch.translateBaseUrl.toLowerCase() !== (prev.translateBaseUrl || '').toLowerCase()
          );
          if (providerChanged && cleanedPatch.translateApiKey === undefined) {
            cleanedPatch.translateApiKey = '';
          }
          if (providerChanged && cleanedPatch.translateModels === undefined) {
            cleanedPatch.translateModels = '';
          }
          const next = settingsStore.update(cleanedPatch);
          settingsVersion += 1;
          const styleChanged = Boolean(cleanedPatch.translateStyle && cleanedPatch.translateStyle !== prev.translateStyle);
          const translateConfigChanged =
            (cleanedPatch.translateBaseUrl !== undefined && cleanedPatch.translateBaseUrl !== prev.translateBaseUrl) ||
            (cleanedPatch.translateApiKey !== undefined && cleanedPatch.translateApiKey !== prev.translateApiKey) ||
            (cleanedPatch.translateModels !== undefined && cleanedPatch.translateModels !== prev.translateModels) ||
            (cleanedPatch.translateEnabled !== undefined && cleanedPatch.translateEnabled !== prev.translateEnabled) ||
            (cleanedPatch.disableTranslatorThinking !== undefined && cleanedPatch.disableTranslatorThinking !== prev.disableTranslatorThinking);
          if (styleChanged) {
            translator.resetForStyleChange();
          } else if (translateConfigChanged) {
            translator.resetForConfigChange();
          } else {
            translator.resetErrors();
          }
          broadcastCachedToClients(true);
          inlineInjector?.pushCached?.(false);
          inlineInjector?.nudge?.();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(next));
          return;
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/translate/models') {
      try {
        const body = await readJsonBody(req);
        const override = validateSettings(body);
        if (typeof body?.translateBaseUrl === 'string' && body.translateBaseUrl.trim() && !override.translateBaseUrl) {
          throw new Error('API Base URL 格式无效，请以 http:// 或 https:// 开头');
        }
        const result = await translator.discoverModels(override);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/translate/test') {
      try {
        const body = await readJsonBody(req);
        const override = validateSettings(body);
        if (typeof body?.translateBaseUrl === 'string' && body.translateBaseUrl.trim() && !override.translateBaseUrl) {
          throw new Error('API Base URL 格式无效，请以 http:// 或 https:// 开头');
        }
        const result = await translator.testConnection(override);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/translate/full') {
      try {
        const body = await readJsonBody(req);
        if (body?.itemId) translator.requestFullTranslation(body.itemId);
        broadcastCachedToClients(true);
        inlineInjector?.pushCached?.(true);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/translate/retry') {
      try {
        const body = await readJsonBody(req);
        translator.retryItem(body?.itemId || '', body?.rawText || '');
        broadcastCachedToClients(true);
        inlineInjector?.pushCached?.(true);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/translate/cache/clear') {
      try {
        translator.clearCache();
        broadcastCachedToClients(true);
        inlineInjector?.pushCached?.(true);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, cacheCount: 0 }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/translate/usage') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, usage: translator.getUsageSummary() }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/translate/usage/reset') {
      try {
        translator.resetUsageStats();
        broadcastCachedToClients(false);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, usage: translator.getUsageSummary() }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/translate/balance') {
      try {
        const body = await readJsonBody(req);
        const override = validateSettings(body);
        if (typeof body?.translateBaseUrl === 'string' && body.translateBaseUrl.trim() && !override.translateBaseUrl) {
          throw new Error('API Base URL 格式无效，请以 http:// 或 https:// 开头');
        }
        const result = await translator.fetchAccountBalance(override);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/open-url') {
      try {
        const body = await readJsonBody(req);
        const opened = openOfficialExternalUrl(body?.url);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, url: opened }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const requestedId = url.searchParams.get('conversationId') || 'auto';
      const hostConvId = url.searchParams.get('hostConvId') || DEFAULT_CONV_ID;
      try {
        const rawSettings = settingsStore.read();
        const payload = await fetchSnapshot(requestedId, hostConvId, rawSettings, { force: true });
        payload.cdpState = inlineInjector?.status?.() ?? 'unknown';
        payload.settings = settingsStore.readPublic();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      const requestedId = url.searchParams.get('conversationId') || 'auto';
      const hostConvId = url.searchParams.get('hostConvId') || DEFAULT_CONV_ID;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');

      const client = { res, requestedId, hostConvId, lastSig: '', lastErr: '', closed: false, keepalive: null };
      clients.add(client);

      client.keepalive = setInterval(() => {
        if (client.closed) return;
        writeClientSafe(client, ': ping\n\n');
      }, 20000);

      req.on('close', () => removeClient(client));
      res.on('close', () => removeClient(client));

      try {
        const rawSettings = settingsStore.read();
        const publicSettings = settingsStore.readPublic();
        const cdpState = inlineInjector?.status?.() ?? 'unknown';
        const initial = await fetchSnapshot(requestedId, hostConvId, rawSettings, { forceList: true });
        if (client.closed) return;
        initial.cdpState = cdpState;
        initial.settings = publicSettings;
        client.lastSig = computeSignature(initial, cdpState, publicSettings);
        client.lastErr = '';
        writeClientSafe(client, `event: state\ndata: ${JSON.stringify(initial)}\n\n`);
      } catch (err) {
        if (client.closed) return;
        client.lastErr = err.message;
        writeClientSafe(client, `event: notice\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
      }
      if (!client.closed) ensurePollRunning(400);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err?.message || 'Internal Server Error' }));
      } else {
        try { res.end(); } catch {}
      }
    }
  });

  server.listen(WEB_PORT, BIND_HOST, () => {
    console.log(`[agy-thinking] listening on ${BIND_HOST}:${server.address().port}`);
  });

  return server;
}

if (WEB_PORT) {
  const server = startServer();
  inlineInjector = startInlineInjector(
    (convId, rawSettings, opts = {}) =>
      fetchSnapshot(convId || 'auto', convId || DEFAULT_CONV_ID, rawSettings, {
        includeConversations: !isUuidLike(convId),
        force: Boolean(opts.force),
      }),
    (convId, rawSettings, triggerNew = false) =>
      buildCachedSnapshot(convId || 'auto', convId || DEFAULT_CONV_ID, rawSettings, triggerNew),
    () => settingsStore.read(),
    () => settingsStore.readPublic(),
    {
      selfPort: WEB_PORT,
      onAction: (action) => {
        if (action?.type === 'retry' && action.itemId) {
          translator.retryItem(action.itemId, action.rawText || '');
          broadcastCachedToClients(true);
          inlineInjector?.pushCached?.(true);
        } else if (action?.type === 'translate-full' && action.itemId) {
          translator.requestFullTranslation(action.itemId);
          broadcastCachedToClients(true);
          inlineInjector?.pushCached?.(true);
        }
      },
    }
  );

  let stopping = false;
  let debounce = null;
  const shutdown = async (reason) => {
    if (stopping) return;
    stopping = true;
    console.log(`[agy-thinking] stopping (${reason})`);
    try { translator.flushCache?.(); } catch {}
    try { await inlineInjector?.stop?.(); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 600).unref();
  };

  if (process.env.AGY_THINKING_DEV_WATCH === '1') {
    try {
      watch(__dirname, (_event, filename) => {
        if (!filename || !/\.(mjs|json)$/i.test(filename)) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => void shutdown(`${filename} changed`), 350);
      });
    } catch {}
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => void shutdown(sig));
  }
}

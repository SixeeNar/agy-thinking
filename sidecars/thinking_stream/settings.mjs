import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  inlineEnabled: true,
  displayLevel: 'focus', // 'focus'（完成后收起）| 'expanded'（始终保持展开）
  includeTools: true,
  autoExpandRunningThink: true, // 默认开启：思考流中自动展开当前思考正文
  hideSummaryWhenOpen: true,
  smoothStream: true,
  fontSize: 'md', // 'sm' | 'md' | 'lg'
  cardStyle: 'minimal', // 'minimal'（极简无框）| 'glass'（极光卡片）
  colorTheme: 'gemini', // 'gemini' | 'mono' | 'amber' | 'emerald' | 'sakura' | 'host'
  translateEnabled: true,
  summaryEnabled: false, // 分步脉络首条标题即摘要，默认关闭额外摘要请求省额度
  disableTranslatorThinking: true,
  displayMode: 'zh', // 'zh' | 'bilingual' | 'raw'
  translateStyle: 'natural', // 'steps'（分步脉络）| 'natural'（自然直译）
  translateBaseUrl: 'https://api.siliconflow.cn/v1',
  translateApiKey: '',
  translateModels: '',
  providerProfiles: Object.freeze({}), // { [providerKey]: { baseUrl, apiKey, enabled } }
});

export function inferProviderKeyFromUrl(rawUrl) {
  const clean = normalizeApiBaseUrl(rawUrl);
  if (!clean) return 'custom';
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(clean)) return 'local';
  try {
    const host = new URL(clean).hostname.toLowerCase();
    if (/(^|\.)siliconflow\.(cn|com)$/i.test(host)) return 'siliconflow';
    if (/(^|\.)deepseek\.com$/i.test(host)) return 'deepseek';
    if (/(^|\.)bigmodel\.cn$/i.test(host)) return 'zhipu';
    if (/(^|\.)modelscope\.(cn|ai)$/i.test(host)) return 'modelscope';
    if (/(^|\.)(hunyuan\.cloud\.tencent\.com|tencentmaas\.com)$/i.test(host)) return 'hunyuan';
    if (/(^|\.)dashscope\.aliyuncs\.com$/i.test(host)) return 'qwen';
    if (/(^|\.)openrouter\.ai$/i.test(host)) return 'openrouter';
  } catch {}
  return 'custom';
}

const VALID_PROFILE_KEYS = new Set([
  'siliconflow',
  'modelscope',
  'zhipu',
  'hunyuan',
  'deepseek',
  'qwen',
  'openrouter',
  'local',
  'custom',
]);

function normalizeProviderProfiles(rawProfiles) {
  const out = {};
  if (!rawProfiles || typeof rawProfiles !== 'object' || Array.isArray(rawProfiles)) return out;
  for (const [k, v] of Object.entries(rawProfiles)) {
    const key = String(k || '').trim().toLowerCase();
    if (!VALID_PROFILE_KEYS.has(key)) continue;
    if (v === null) {
      out[key] = null; // 显式删除标记
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    const entry = {};
    if (typeof v.baseUrl === 'string' && v.baseUrl.trim()) {
      const normalized = normalizeApiBaseUrl(v.baseUrl);
      if (normalized) entry.baseUrl = normalized;
    }
    if (typeof v.apiKey === 'string') {
      const trimmed = v.apiKey.trim();
      if (!trimmed.includes('****')) entry.apiKey = trimmed;
    }
    if (typeof v.enabled === 'boolean') entry.enabled = v.enabled;
    if (Object.keys(entry).length > 0) out[key] = entry;
  }
  return out;
}

export function normalizeApiBaseUrl(raw) {
  if (typeof raw !== 'string') return '';
  let clean = raw.trim().replace(/\/+$/, '');
  if (!clean) return '';
  // 自动剥离用户从文档整段复制过来的端点后缀，避免拼出 /chat/completions/chat/completions 或 /models/models
  clean = clean.replace(/\/(chat\/completions|completions|models)$/i, '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(clean)) return '';
  try {
    const parsed = new URL(clean);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return clean;
  } catch {
    return '';
  }
}

export function getSettingsPath() {
  return join(homedir(), '.gemini', 'config', 'agy-thinking', 'settings.json');
}

export function maskApiKey(key) {
  if (!key || typeof key !== 'string') return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

export function validateSettings(raw) {
  const clean = {};
  if (!raw || typeof raw !== 'object') return clean;

  const boolKeys = [
    'inlineEnabled',
    'includeTools',
    'autoExpandRunningThink',
    'hideSummaryWhenOpen',
    'smoothStream',
    'translateEnabled',
    'summaryEnabled',
    'disableTranslatorThinking',
  ];
  for (const key of boolKeys) {
    if (typeof raw[key] === 'boolean') clean[key] = raw[key];
  }

  if (raw.displayLevel === 'focus' || raw.displayLevel === 'expanded') {
    clean.displayLevel = raw.displayLevel;
  } else if (raw.displayLevel === 'verbose') {
    clean.displayLevel = 'expanded';
  } else if (['timeline', 'compact', 'standard', 'detailed'].includes(raw.displayLevel)) {
    clean.displayLevel = 'focus';
  }
  if (['zh', 'bilingual', 'raw'].includes(raw.displayMode)) {
    clean.displayMode = raw.displayMode;
  }
  if (raw.translateStyle === 'steps' || raw.translateStyle === 'natural') {
    clean.translateStyle = raw.translateStyle;
  } else if (['technical', 'concise'].includes(raw.translateStyle)) {
    clean.translateStyle = 'natural';
  }
  if (['sm', 'md', 'lg'].includes(raw.fontSize)) {
    clean.fontSize = raw.fontSize;
  }
  if (raw.cardStyle === 'minimal' || raw.cardStyle === 'glass') {
    clean.cardStyle = raw.cardStyle;
  }
  if (['gemini', 'mono', 'amber', 'emerald', 'sakura', 'host'].includes(raw.colorTheme)) {
    clean.colorTheme = raw.colorTheme;
  }
  if (typeof raw.translateBaseUrl === 'string' && raw.translateBaseUrl.trim()) {
    const normalizedUrl = normalizeApiBaseUrl(raw.translateBaseUrl);
    if (normalizedUrl) clean.translateBaseUrl = normalizedUrl;
  }
  if (typeof raw.translateModels === 'string') {
    clean.translateModels = raw.translateModels.trim();
  }
  if (typeof raw.translateApiKey === 'string') {
    const k = raw.translateApiKey.trim();
    // 只有不是掩码占位时才更新密钥
    if (!k.includes('****')) {
      clean.translateApiKey = k;
    }
  }
  if (raw.providerProfiles && typeof raw.providerProfiles === 'object' && !Array.isArray(raw.providerProfiles)) {
    const normalizedProfiles = normalizeProviderProfiles(raw.providerProfiles);
    if (Object.keys(normalizedProfiles).length > 0) {
      clean.providerProfiles = normalizedProfiles;
    }
  }
  return clean;
}

function mergeProviderProfiles(existing = {}, incoming = {}, legacyUrl = '', legacyKey = '') {
  const merged = {};
  for (const [k, v] of Object.entries(existing || {})) {
    if (v && typeof v === 'object' && v.baseUrl) {
      merged[k] = {
        baseUrl: v.baseUrl,
        apiKey: typeof v.apiKey === 'string' ? v.apiKey : '',
        enabled: v.enabled !== false,
      };
    }
  }
  // 首次迁移：若历史仅有单渠道配置且尚未写入 providerProfiles，自动同步进档案
  if (Object.keys(merged).length === 0 && legacyUrl) {
    const key = inferProviderKeyFromUrl(legacyUrl);
    if (legacyKey || key === 'local') {
      merged[key] = {
        baseUrl: normalizeApiBaseUrl(legacyUrl) || legacyUrl,
        apiKey: legacyKey || '',
        enabled: true,
      };
    }
  }
  for (const [k, patch] of Object.entries(incoming || {})) {
    if (patch === null) {
      delete merged[k];
      continue;
    }
    const prev = merged[k] || { baseUrl: '', apiKey: '', enabled: true };
    const nextEntry = {
      baseUrl: patch.baseUrl ?? prev.baseUrl,
      apiKey: patch.apiKey !== undefined ? patch.apiKey : prev.apiKey,
      enabled: patch.enabled !== undefined ? patch.enabled : prev.enabled,
    };
    const isLocal = k === 'local';
    if (!nextEntry.baseUrl || (!isLocal && !nextEntry.apiKey) || (isLocal && nextEntry.enabled === false)) {
      delete merged[k];
    } else {
      merged[k] = nextEntry;
    }
  }
  return merged;
}

function maskProviderProfiles(profiles = {}) {
  const out = {};
  for (const [k, v] of Object.entries(profiles || {})) {
    if (!v || typeof v !== 'object' || !v.baseUrl) continue;
    const isLocal = k === 'local';
    const hasApiKey = Boolean(v.apiKey);
    if (!isLocal && !hasApiKey) continue;
    out[k] = {
      baseUrl: v.baseUrl,
      hasApiKey,
      apiKey: maskApiKey(v.apiKey || ''),
      enabled: v.enabled !== false,
    };
  }
  return out;
}

export function createSettingsStore(filePath = getSettingsPath()) {
  let cached = { ...DEFAULT_SETTINGS, providerProfiles: {} };
  let loaded = false;

  const readFromDisk = () => {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
      const valid = validateSettings(parsed);
      const base = { ...DEFAULT_SETTINGS, ...valid };
      // 仅当历史旧配置完全不含 providerProfiles 字段时，才从单渠道字段自动迁移，防止已显式移除的 local 渠道重启复活
      const hasProfilesField =
        parsed &&
        typeof parsed === 'object' &&
        Object.prototype.hasOwnProperty.call(parsed, 'providerProfiles') &&
        parsed.providerProfiles &&
        typeof parsed.providerProfiles === 'object' &&
        !Array.isArray(parsed.providerProfiles);
      base.providerProfiles = mergeProviderProfiles(
        valid.providerProfiles || {},
        {},
        hasProfilesField ? '' : base.translateBaseUrl,
        hasProfilesField ? '' : base.translateApiKey
      );
      const targetKey = inferProviderKeyFromUrl(base.translateBaseUrl || '');
      const activeProfile = base.providerProfiles[targetKey];
      if (activeProfile) {
        base.translateBaseUrl = activeProfile.baseUrl;
        base.translateApiKey = activeProfile.apiKey || '';
      } else if (hasProfilesField) {
        base.translateApiKey = '';
      }
      cached = base;
    } catch {
      // 文件不存在或损坏时保留当前默认配置
    }
    loaded = true;
  };

  const read = () => {
    if (!loaded) readFromDisk();
    return {
      ...cached,
      providerProfiles: Object.fromEntries(
        Object.entries(cached.providerProfiles || {}).map(([k, v]) => [k, { ...v }])
      ),
    };
  };

  const reload = () => {
    readFromDisk();
    return read();
  };

  const readPublic = () => {
    const s = read();
    return {
      ...s,
      hasApiKey: Boolean(s.translateApiKey),
      translateApiKey: maskApiKey(s.translateApiKey),
      providerProfiles: maskProviderProfiles(s.providerProfiles),
    };
  };

  const update = (patch) => {
    const prev = read();
    const valid = validateSettings(patch);
    const next = { ...prev, ...valid };
    const incomingProfiles = { ...(valid.providerProfiles || {}) };

    const prevKey = inferProviderKeyFromUrl(prev.translateBaseUrl || '');
    const targetUrl = next.translateBaseUrl || '';
    const targetKey = inferProviderKeyFromUrl(targetUrl);

    // 切换服务商地址但未显式提交新 Key 时，严禁把旧服务商的 translateApiKey 串味带给新服务商
    if (valid.translateBaseUrl !== undefined && targetKey !== prevKey && valid.translateApiKey === undefined) {
      next.translateApiKey = '';
    }

    // 同步通过旧字段 translateBaseUrl + translateApiKey 提交的变更到对应渠道档案
    if (valid.translateApiKey !== undefined && targetUrl) {
      if (valid.translateApiKey) {
        incomingProfiles[targetKey] = {
          ...(incomingProfiles[targetKey] || {}),
          baseUrl: targetUrl,
          apiKey: valid.translateApiKey,
          enabled: true,
        };
      } else if (incomingProfiles[targetKey] === undefined) {
        incomingProfiles[targetKey] = null;
      }
    } else if (targetKey === 'local' && valid.translateBaseUrl !== undefined && incomingProfiles.local === undefined) {
      incomingProfiles.local = { baseUrl: targetUrl, apiKey: '', enabled: true };
    }

    // 此处不再触发旧版单渠道自动迁移（已有 prev.providerProfiles 作为真相源），防止刚移除的 local 渠道当场复活
    next.providerProfiles = mergeProviderProfiles(
      prev.providerProfiles || {},
      incomingProfiles,
      '',
      ''
    );

    // 显式移除本地 Ollama 渠道时，清理残留的本地 translateBaseUrl，避免前后端误判仍启用了本机
    if (incomingProfiles.local === null && inferProviderKeyFromUrl(next.translateBaseUrl || '') === 'local') {
      const fallbackEntry = Object.values(next.providerProfiles)[0];
      next.translateBaseUrl = fallbackEntry?.baseUrl || DEFAULT_SETTINGS.translateBaseUrl;
    }

    const finalTargetKey = inferProviderKeyFromUrl(next.translateBaseUrl || '');
    const activeProfile = next.providerProfiles[finalTargetKey];
    if (activeProfile) {
      next.translateBaseUrl = activeProfile.baseUrl;
      next.translateApiKey = activeProfile.apiKey || '';
    } else {
      next.translateApiKey = '';
    }

    mkdirSync(dirname(filePath), { recursive: true });
    const content = `${JSON.stringify(next, null, 2)}\n`;
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, content, 'utf-8');
      renameSync(tmp, filePath);
    } catch {
      try { unlinkSync(tmp); } catch {}
      writeFileSync(filePath, content, 'utf-8');
    }
    cached = next;
    loaded = true;
    return readPublic();
  };

  return { read, reload, readPublic, update };
}

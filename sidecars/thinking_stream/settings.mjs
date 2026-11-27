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
});

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
  return clean;
}

export function createSettingsStore(filePath = getSettingsPath()) {
  let cached = { ...DEFAULT_SETTINGS };
  let loaded = false;

  const readFromDisk = () => {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
      cached = { ...DEFAULT_SETTINGS, ...validateSettings(parsed) };
    } catch {
      // 文件不存在或损坏时保留当前默认配置
    }
    loaded = true;
  };

  const read = () => {
    if (!loaded) readFromDisk();
    return { ...cached };
  };

  const reload = () => {
    readFromDisk();
    return { ...cached };
  };

  const readPublic = () => {
    const s = read();
    return {
      ...s,
      hasApiKey: Boolean(s.translateApiKey),
      translateApiKey: maskApiKey(s.translateApiKey),
    };
  };

  const update = (patch) => {
    const next = { ...read(), ...validateSettings(patch) };
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

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  inlineEnabled: true,
  includeTools: true,
  autoExpandRunningTurn: true,
  autoCollapseDoneTurn: false,
  autoExpandRunningThink: true,
  hideSummaryWhenOpen: true,
  smoothStream: true,
  compactMode: false,
  fontSize: 'md', // 'sm' | 'md' | 'lg'
  thinkHeightMode: 'md', // 'sm' | 'md' | 'full'
  sidebarDefaultTab: 'settings', // 'settings' | 'feed'
  translateEnabled: true,
  disableTranslatorThinking: true,
  displayMode: 'zh', // 'zh' | 'bilingual' | 'raw'
  translateStyle: 'natural', // 'natural' | 'technical' | 'concise'
  translateBaseUrl: 'https://api.siliconflow.cn/v1',
  translateApiKey: '',
  translateModels: 'Qwen/Qwen2.5-7B-Instruct, THUDM/glm-4-9b-chat, tencent/Hunyuan-MT-7B',
});

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
    'autoExpandRunningTurn',
    'autoCollapseDoneTurn',
    'autoExpandRunningThink',
    'hideSummaryWhenOpen',
    'smoothStream',
    'compactMode',
    'translateEnabled',
    'disableTranslatorThinking',
  ];
  for (const key of boolKeys) {
    if (typeof raw[key] === 'boolean') clean[key] = raw[key];
  }

  if (['zh', 'bilingual', 'raw'].includes(raw.displayMode)) {
    clean.displayMode = raw.displayMode;
  }
  if (['natural', 'technical', 'concise'].includes(raw.translateStyle)) {
    clean.translateStyle = raw.translateStyle;
  }
  if (['sm', 'md', 'lg'].includes(raw.fontSize)) {
    clean.fontSize = raw.fontSize;
  }
  if (['sm', 'md', 'full'].includes(raw.thinkHeightMode)) {
    clean.thinkHeightMode = raw.thinkHeightMode;
  }
  if (['settings', 'feed'].includes(raw.sidebarDefaultTab)) {
    clean.sidebarDefaultTab = raw.sidebarDefaultTab;
  }
  if (typeof raw.translateBaseUrl === 'string' && raw.translateBaseUrl.trim()) {
    clean.translateBaseUrl = raw.translateBaseUrl.trim().replace(/\/+$/, '');
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

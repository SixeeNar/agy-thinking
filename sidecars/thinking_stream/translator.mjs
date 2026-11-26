import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const STYLE_PROMPTS = {
  natural: [
    '你是一个母语为中文的资深工程师，请把下面这段英文 AI 内部思考过程转述成自然地道的简体中文。',
    '规则：',
    '1. 语气要像真人在边想边自言自语一样口语化、顺滑自然，彻底去掉「为了确保……」「需要系统地……」「值得注意的是……」这类生硬翻译腔。',
    '2. 原样保留所有 Markdown 格式、反引号内的代码、文件路径、命令行、JSON 字段名、函数名和专有名词，绝不翻译代码标识符。',
    '3. 只输出中文正文，不要加任何开头说明、思考标签或总结。',
  ].join('\n'),
  technical: [
    '你是一个专业的技术文档与代码审阅译者。请把下面的英文 AI 内部思考过程精准、克制、清晰地翻译成简体中文。',
    '规则：',
    '1. 准确传达技术逻辑与因果关系，行文干练无废话，避免生硬直译。',
    '2. 原样保留所有 Markdown 格式、反引号内的代码、文件路径、命令行、JSON 字段名、函数名和专有名词，绝不翻译代码标识符。',
    '3. 只输出翻译后的中文正文，不要加任何开头说明、思考标签或总结。',
  ].join('\n'),
  concise: [
    '请把下面这段英文 AI 内部思考过程提炼并转译为极其简明直白的简体中文，让人扫一眼就懂。',
    '规则：',
    '1. 合并啰嗦铺垫，保留所有核心判断、排查动作与结论，口语直白无翻译腔。',
    '2. 原样保留反引号内的代码、文件路径、命令行与关键标识符。',
    '3. 只输出精简后的中文正文，不要加任何开头说明、思考标签或总结。',
  ].join('\n'),
};

const MAX_CONCURRENCY = 3;

/**
 * 过滤掉明显不是对话/翻译模型的 ID（嵌入、重排、文生图、语音、视频、审核等）
 */
const NON_TRANSLATION_RE =
  /(embed|bge-|rerank|whisper|tts|speech|audio|voice|flux|stable-diffusion|sdxl|sd3|kolors|dall-e|midjourney|cogvideo|cogview|wan2\.|wanx|sora|veo|imagen|janus|moderation|guard|ocr|realtime|live-|transcribe|music|paint|sketch|upscale|inpaint|clip-|siglip|cosyvoice|fish-speech|sensevoice|funasr|paraformer|sambert)/i;

/**
 * 三维翻译模型评估规则：
 * - overall: 综合推荐分（兼顾性价比与自然使用感）
 * - value:   性价比分（免费额度 / 单价 / 缓存省钱）
 * - natural: 自然感与使用感分（无机翻味、口语流畅度、代码标识符保持、首字延迟）
 */
const MODEL_RATING_RULES = [
  {
    match: /(^|\/)deepseek-chat$|(^|\/)deepseek-v3(\.\d)?$/i,
    overall: 98,
    value: 94,
    natural: 99,
    costTag: '极低价·缓存省',
    costTone: 'cheap',
    reason: '外译中母语级自然，几乎零机翻味，缓存命中极省钱',
  },
  {
    match: /(^|\/)(glm-4\.7-flash|glm-4\.5-flash|glm-4-flash|glm-4-9b-chat)/i,
    overall: 96,
    value: 100,
    natural: 91,
    costTag: '免费',
    costTone: 'free',
    reason: '官方/平台常驻免费，中文表达顺滑自然，零成本首选',
  },
  {
    match: /(^|\/)(qwen3\.5-flash|qwen-flash|qwen2\.5-7b-instruct|qwen3-8b|qwen3-4b)/i,
    overall: 95,
    value: 98,
    natural: 93,
    costTag: '免费 / 极低价',
    costTone: 'free',
    reason: '技术语感极佳、代码零误翻，免费或白菜价且首字快',
  },
  {
    match: /(^|\/)qwen-turbo/i,
    overall: 94,
    value: 97,
    natural: 91,
    costTag: '¥0.3/M 极低',
    costTone: 'cheap',
    reason: '百炼经典经济快模，延迟极低、技术表达干净利落',
  },
  {
    match: /(^|\/)qwen-mt-plus/i,
    overall: 93,
    value: 88,
    natural: 96,
    costTag: '¥1.8/M 专译',
    costTone: 'cheap',
    reason: '高质量专职翻译，复杂语境与专业术语拿捏很准',
  },
  {
    match: /(^|\/)deepseek-v3/i,
    overall: 94,
    value: 91,
    natural: 97,
    costTag: '极低价',
    costTone: 'cheap',
    reason: 'DeepSeek V3 衍生版，中文自然顺口、极少翻译腔',
  },
  {
    match: /(^|\/)(claude-haiku|claude-3-5-haiku|claude-3\.5-haiku)/i,
    overall: 89,
    value: 78,
    natural: 97,
    costTag: '中等价位',
    costTone: 'mid',
    reason: '中文表达极自然有网感，使用感顶级，但单价略高',
  },
  {
    match: /(^|\/)gemini-2\.5-flash-lite|(^|\/)gemini-2\.5-flash$|(^|\/)gemini-2\.0-flash/i,
    overall: 91,
    value: 96,
    natural: 88,
    costTag: '地板价·超快',
    costTone: 'cheap',
    reason: '吞吐极快、单价极薄，配合口语提示词流畅度很好',
  },
  {
    match: /(^|\/)(qwen2\.5-14b|qwen2\.5-32b|qwen3-14b|qwen3-30b-a3b|qwen-plus)/i,
    overall: 91,
    value: 87,
    natural: 94,
    costTag: '高性价比',
    costTone: 'cheap',
    reason: '中大参数通义，长难句拆解稳、行文自然不生硬',
  },
  {
    match: /(^|\/)(qwen-mt-flash|qwen-mt-turbo|qwen-mt-lite)/i,
    overall: 88,
    value: 93,
    natural: 84,
    costTag: '¥0.7/M 专译',
    costTone: 'cheap',
    reason: '专职快译便宜高速，风格略工整偏直白',
  },
  {
    match: /(^|\/)(hunyuan-mt|hy-mt)/i,
    overall: 85,
    value: 96,
    natural: 78,
    costTag: '免费 / 轻量',
    costTone: 'free',
    reason: '免费专职快译、速度极快，但略带书面翻译腔',
  },
  {
    match: /(^|\/)(glm-4\.5-air|glm-4-air|glm-4\.6|glm-4\.5$)/i,
    overall: 87,
    value: 86,
    natural: 90,
    costTag: '高性价比',
    costTone: 'cheap',
    reason: '智谱轻量/标准主力，中文语感自然、延迟较低',
  },
  {
    match: /(^|\/)(gpt-4\.1-mini|gpt-4\.1-nano|gpt-4o-mini)/i,
    overall: 85,
    value: 86,
    natural: 85,
    costTag: '低价稳健',
    costTone: 'cheap',
    reason: '语法严谨、代码格式稳定，中文略保守直白',
  },
  {
    match: /(^|\/)(doubao.*lite|doubao.*mini|minimax|kimi|moonshot|internlm|yi-|step-1-flash|ernie-speed|ernie-lite|gemma)/i,
    overall: 84,
    value: 88,
    natural: 84,
    costTag: '低价流畅',
    costTone: 'cheap',
    reason: '轻量中文友好模型，适合日常流式翻译',
  },
  {
    match: /(^|\/)(qwen2-7b|qwen1\.5-7b|qwen2\.5-3b|qwen2\.5-1\.5b)/i,
    overall: 81,
    value: 94,
    natural: 75,
    costTag: '免费 / 极轻',
    costTone: 'free',
    reason: '免费轻量小模型，速度快但偶有语句略平淡',
  },
  {
    match: /(gpt-4o$|gpt-4\.1$|gpt-5|claude-sonnet|claude-opus|claude-3-7|qwen-max|qwen3-235b|glm-4-plus|gemini-2\.5-pro)/i,
    overall: 79,
    value: 58,
    natural: 96,
    costTag: '旗舰·偏贵',
    costTone: 'mid',
    reason: '译文自然度顶级，但实时翻思考流成本太高',
  },
  {
    match: /(deepseek-r1|qwq|glm-z1|seed-thinking|reasoner|o1-|o3-|o4-|-thinking)/i,
    overall: 64,
    value: 66,
    natural: 62,
    costTag: '推理型·偏慢',
    costTone: 'slow',
    reason: '自带内部思考链，首字延迟高，不适合做实时译者',
  },
];

function gradeFromScore(score) {
  if (score >= 95) return 'S+';
  if (score >= 90) return 'S';
  if (score >= 84) return 'A+';
  if (score >= 76) return 'A';
  return 'B';
}

export function evaluateModelForTranslation(modelId, baseUrl = '') {
  const id = String(modelId || '').trim();
  const isLocal = isLocalGatewayUrl(baseUrl);
  for (const rule of MODEL_RATING_RULES) {
    if (rule.match.test(id)) {
      const value = isLocal ? 100 : rule.value;
      const overall = isLocal ? Math.min(99, Math.round(rule.natural * 0.65 + value * 0.35)) : rule.overall;
      return {
        id,
        overall,
        value,
        natural: rule.natural,
        score: overall,
        grade: gradeFromScore(overall),
        costTag: isLocal ? '本机免费' : rule.costTag,
        costTone: isLocal ? 'free' : rule.costTone,
        reason: rule.reason,
        recommended: overall >= 84,
      };
    }
  }
  const lower = id.toLowerCase();
  if (/(flash|lite|mini|nano|turbo|7b|8b|9b)/i.test(lower)) {
    const value = isLocal ? 100 : 84;
    const natural = 78;
    const overall = isLocal ? 86 : 80;
    return {
      id,
      overall,
      value,
      natural,
      score: overall,
      grade: gradeFromScore(overall),
      costTag: isLocal ? '本机免费' : '轻量快速',
      costTone: isLocal ? 'free' : 'cheap',
      reason: '轻量快速模型，适合实时流式翻译实测',
      recommended: overall >= 84,
    };
  }
  const value = isLocal ? 96 : 70;
  const natural = 74;
  const overall = isLocal ? 82 : 72;
  return {
    id,
    overall,
    value,
    natural,
    score: overall,
    grade: gradeFromScore(overall),
    costTag: isLocal ? '本机模型' : '通用模型',
    costTone: isLocal ? 'free' : 'neutral',
    reason: '平台可用对话模型，可勾选实测翻译手感',
    recommended: false,
  };
}

export function isUsableTranslationModel(modelId) {
  const id = String(modelId || '').trim();
  if (!id) return false;
  if (NON_TRANSLATION_RE.test(id)) return false;
  return true;
}

function getCachePath() {
  return join(homedir(), '.gemini', 'config', 'agy-thinking', 'translation-cache.json');
}

function hashText(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function cacheKeyFor(text, style = 'natural') {
  const s = style && style !== 'natural' ? `${style}:` : '';
  return hashText(`${s}${text}`);
}

/**
 * 判断文本是否已经以中文为主：
 * 先剔除代码块、行内代码、URL 与文件路径，避免夹带代码标识符时误判成英文去重翻。
 */
export function containsMostlyChinese(text) {
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, ' ')
    .replace(/(?:^|\s)[./~][\w./-]+\.[a-zA-Z0-9]+/g, ' ')
    .replace(/\s+/g, '');
  if (!clean) return true;
  const zhCount = (clean.match(/[\u4e00-\u9fff]/g) || []).length;
  const enCount = (clean.match(/[a-zA-Z]/g) || []).length;
  if (enCount < 16) return zhCount > 0 || enCount === 0;
  if (zhCount === 0) return false;
  return zhCount >= 6 && zhCount / (zhCount + enCount) >= 0.32;
}

function parseModels(modelsStr) {
  return String(modelsStr || '')
    .split(/[,，\n]+/)
    .map((m) => m.trim())
    .filter(Boolean);
}

export function isLocalGatewayUrl(baseUrl) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(String(baseUrl || '').trim());
}

function isSiliconFlowUrl(baseUrl) {
  return /siliconflow\.(cn|com)/i.test(String(baseUrl || ''));
}

function isZhipuUrl(baseUrl) {
  return /open\.bigmodel\.cn|bigmodel\.cn/i.test(String(baseUrl || ''));
}

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

function isHunyuanMtModel(model) {
  return /(^|\/)(hunyuan-mt|hy-mt)/i.test(String(model || '').trim());
}

function isQwenMtModel(model) {
  return /(^|\/)qwen-mt/i.test(String(model || '').trim());
}

function supportsEnableThinkingFlag(baseUrl, model) {
  const m = String(model || '').toLowerCase();
  if (isHunyuanMtModel(m) || isQwenMtModel(m)) return false;
  if (isSiliconFlowUrl(baseUrl) || /dashscope\.aliyuncs\.com|modelscope\.cn/i.test(String(baseUrl || ''))) {
    // 仅对明确支持 enable_thinking 的推理/混合思考模型下发，避免普通模型返回 400
    return /(qwen3(?!-coder)|qwq|deepseek-r1|glm-4\.5|glm-4\.7|glm-z1|seed-thinking|hunyuan-a13b|intern-s1)/i.test(m);
  }
  return false;
}

function supportsZhipuThinkingDisable(baseUrl, model) {
  if (!isZhipuUrl(baseUrl)) return false;
  return /(glm-4\.5|glm-4\.6|glm-4\.7|glm-z1)/i.test(String(model || '').toLowerCase());
}

/**
 * 剥离某些兼容接口可能夹带在正文里的 <think>...</think> 标签，
 * 支持流式未闭合以及流式半截标签前缀（如 "<thi"）的增量隐藏，避免译者内心戏污染思考流。
 */
export function stripThinkTags(raw, isFinal = false) {
  if (!raw) return '';
  let out = String(raw).replace(/<think>[\s\S]*?<\/think>/gi, '');
  const openIdx = out.search(/<think>/i);
  if (openIdx !== -1) {
    out = out.slice(0, openIdx);
  }
  out = out.replace(/<\/think>/gi, '');
  if (!isFinal) {
    // 截断末尾可能尚未吐完的 <think> / </think> 标签前缀，避免流式闪现半截标签
    const tailMatch = out.match(/<\/?[a-z]{0,6}$/i);
    if (tailMatch) {
      const frag = tailMatch[0].toLowerCase();
      if ('<think>'.startsWith(frag) || '</think>'.startsWith(frag)) {
        out = out.slice(0, out.length - frag.length);
      }
    }
  }
  return out.trimStart();
}

export function buildTranslateRequestBody({
  baseUrl,
  model,
  text,
  disableTranslatorThinking = true,
  translateStyle = 'natural',
}) {
  if (isQwenMtModel(model)) {
    return {
      model,
      messages: [{ role: 'user', content: text }],
      stream: true,
      translation_options: {
        source_lang: 'auto',
        target_lang: 'Chinese',
      },
    };
  }

  if (isHunyuanMtModel(model)) {
    // 腾讯混元专用翻译模型使用官方精简模板，严禁附加 enable_thinking
    return {
      model,
      messages: [
        {
          role: 'user',
          content: `把下面的文本翻译成自然口语化的简体中文，避免书面翻译腔，原样保留所有 Markdown 格式、反引号代码、路径和专有名词，不要额外解释。\n${text}`,
        },
      ],
      temperature: 0.25,
      stream: true,
    };
  }

  const systemPrompt = STYLE_PROMPTS[translateStyle] || STYLE_PROMPTS.natural;
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text },
    ],
    temperature: translateStyle === 'natural' ? 0.3 : 0.2,
    stream: true,
  };

  if (disableTranslatorThinking !== false) {
    if (isLocalGatewayUrl(baseUrl)) {
      body.reasoning_effort = 'none';
    } else if (supportsZhipuThinkingDisable(baseUrl, model)) {
      body.thinking = { type: 'disabled' };
    } else if (supportsEnableThinkingFlag(baseUrl, model)) {
      body.enable_thinking = false;
    }
  }

  return body;
}

async function streamChatCompletion({
  baseUrl,
  apiKey,
  model,
  text,
  disableTranslatorThinking,
  translateStyle,
  onChunk,
  signal,
}) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = buildTranslateRequestBody({
    baseUrl,
    model,
    text,
    disableTranslatorThinking,
    translateStyle,
  });
  const startedAt = Date.now();

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status}: ${errText.slice(0, 160)}`);
    err.status = res.status;
    err.responseText = errText;
    throw err;
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('响应不支持流式读取');

  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let rawFull = '';
  let lastClean = '';
  let ttftMs = null;
  let sawSseData = false;

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    sawSseData = true;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const parsed = JSON.parse(payload);
      if (parsed?.error) {
        const msg = typeof parsed.error === 'string' ? parsed.error : (parsed.error.message || JSON.stringify(parsed.error));
        throw new Error(msg);
      }
      const delta = parsed?.choices?.[0]?.delta?.content ?? parsed?.choices?.[0]?.message?.content;
      if (typeof delta === 'string' && delta) {
        rawFull += delta;
        const clean = stripThinkTags(rawFull, false);
        if (clean && clean !== lastClean) {
          if (ttftMs === null) ttftMs = Date.now() - startedAt;
          lastClean = clean;
          onChunk?.(clean);
        }
      }
    } catch (err) {
      if (err instanceof SyntaxError) return;
      throw err;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) processLine(line);
  }

  // Flush UTF-8 解码器尾字节并处理流尾未换行的残留数据
  buffer += decoder.decode();
  if (buffer.trim()) {
    const tailLines = buffer.split(/\r?\n/);
    for (const line of tailLines) processLine(line);
    if (!sawSseData) {
      // 兼容部分网关返回非流式 JSON 或 HTTP 200 错误体
      try {
        const parsed = JSON.parse(buffer.trim());
        if (parsed?.error) {
          const msg = typeof parsed.error === 'string' ? parsed.error : (parsed.error.message || JSON.stringify(parsed.error));
          throw new Error(msg);
        }
        const msgContent = parsed?.choices?.[0]?.message?.content;
        if (typeof msgContent === 'string' && msgContent) {
          rawFull += msgContent;
        }
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
      }
    }
  }

  const finalClean = stripThinkTags(rawFull, true).trim();
  const totalMs = Date.now() - startedAt;
  return { text: finalClean, ttftMs: ttftMs ?? totalMs, totalMs };
}

export function createTranslator(getSettings, onProgress) {
  const cachePath = getCachePath();
  const diskCache = new Map();
  const liveStates = new Map();
  const modelCooldownUntil = new Map();
  const segmentMap = new Map();
  const latestItemSnapshots = new Map(); // itemId -> { rawText, fullKey, style, isGenerating, paragraphs }
  const itemEpochs = new Map(); // itemId -> number
  const itemControllers = new Map(); // itemId -> Set<AbortController>
  let globalEpoch = 0;
  let lastActiveModel = '';

  const MAX_LIVE_ITEMS = 200;

  const getItemEpoch = (itemId) => itemEpochs.get(itemId) || 0;

  const abortItemControllers = (itemId) => {
    const set = itemControllers.get(itemId);
    if (!set) return;
    for (const ctrl of set) {
      try { ctrl.abort(); } catch {}
    }
    set.clear();
    itemControllers.delete(itemId);
  };

  const abortAllControllers = () => {
    for (const set of itemControllers.values()) {
      for (const ctrl of set) {
        try { ctrl.abort(); } catch {}
      }
      set.clear();
    }
    itemControllers.clear();
  };

  const trackController = (itemId, ctrl) => {
    let set = itemControllers.get(itemId);
    if (!set) {
      set = new Set();
      itemControllers.set(itemId, set);
    }
    set.add(ctrl);
  };

  const untrackController = (itemId, ctrl) => {
    const set = itemControllers.get(itemId);
    if (!set) return;
    set.delete(ctrl);
    if (set.size === 0) itemControllers.delete(itemId);
  };

  const pruneMemoryMaps = () => {
    if (liveStates.size <= MAX_LIVE_ITEMS) return;
    for (const [id, st] of liveStates.entries()) {
      if (liveStates.size <= MAX_LIVE_ITEMS) break;
      if (st?.inFlight) continue;
      liveStates.delete(id);
      segmentMap.delete(id);
      latestItemSnapshots.delete(id);
      itemEpochs.delete(id);
    }
  };

  let runningJobs = 0;
  const pendingJobs = [];
  const enqueueJob = (fn) => {
    const runNext = () => {
      if (runningJobs >= MAX_CONCURRENCY || pendingJobs.length === 0) return;
      const next = pendingJobs.shift();
      runningJobs += 1;
      void Promise.resolve()
        .then(next)
        .finally(() => {
          runningJobs -= 1;
          runNext();
        });
    };
    pendingJobs.push(fn);
    runNext();
  };

  // 加载磁盘缓存（最多保留最近 1200 条）
  try {
    const raw = JSON.parse(readFileSync(cachePath, 'utf-8'));
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string') diskCache.set(k, v);
      }
    }
  } catch {}

  let saveTimer = null;
  let cacheDirty = false;
  const flushCacheNow = () => {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!cacheDirty) return;
    cacheDirty = false;
    const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      while (diskCache.size > 1200) {
        const oldest = diskCache.keys().next().value;
        diskCache.delete(oldest);
      }
      mkdirSync(dirname(cachePath), { recursive: true });
      const serialized = JSON.stringify(Object.fromEntries(diskCache));
      try {
        writeFileSync(tmp, serialized, 'utf-8');
        renameSync(tmp, cachePath);
      } catch {
        try { unlinkSync(tmp); } catch {}
        writeFileSync(cachePath, serialized, 'utf-8');
      }
    } catch {
      try { unlinkSync(tmp); } catch {}
    }
  };

  const scheduleSave = () => {
    cacheDirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(flushCacheNow, 1200);
  };

  const putDiskCache = (key, val) => {
    if (!key || !val) return;
    if (diskCache.get(key) === val) return;
    diskCache.set(key, val);
    scheduleSave();
  };

  async function translateWithFallback(text, settings, onChunk, externalSignal) {
    const models = parseModels(settings.translateModels);
    if (models.length === 0) throw new Error('未配置翻译模型名称');

    const now = Date.now();
    const activeModels = models.filter((m) => (modelCooldownUntil.get(m) || 0) <= now);
    const candidates = activeModels.length > 0 ? activeModels : models;

    let lastErr = null;
    for (const model of candidates) {
      if (externalSignal?.aborted) {
        const abortErr = new Error('翻译已取消');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      const runOnce = async (disableThink) => {
        const timeoutSig = AbortSignal.timeout(22000);
        const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSig]) : timeoutSig;
        return streamChatCompletion({
          baseUrl: settings.translateBaseUrl,
          apiKey: settings.translateApiKey,
          model,
          text,
          disableTranslatorThinking: disableThink,
          translateStyle: settings.translateStyle || 'natural',
          onChunk,
          signal,
        });
      };

      try {
        let res;
        try {
          res = await runOnce(settings.disableTranslatorThinking !== false);
        } catch (err) {
          // 兼容部分网关不支持 reasoning_effort / enable_thinking / thinking 参数返回 400：自动剥离重试一次
          if (
            err?.status === 400 &&
            settings.disableTranslatorThinking !== false &&
            !externalSignal?.aborted &&
            /(reasoning_effort|enable_thinking|thinking|unknown|unrecognized|unsupported|extra_forbidden)/i.test(err.responseText || err.message || '')
          ) {
            res = await runOnce(false);
          } else {
            throw err;
          }
        }
        if (res.text) {
          lastActiveModel = model;
          return { result: res.text, model, ttftMs: res.ttftMs, totalMs: res.totalMs };
        }
        lastErr = new Error(`模型 ${model} 返回空译文`);
      } catch (err) {
        if (externalSignal?.aborted) throw err;
        lastErr = err;
        if ([400, 401, 402, 403, 404, 429].includes(err.status)) {
          modelCooldownUntil.set(model, Date.now() + 5 * 60 * 1000);
          continue;
        }
        if ([500, 502, 503, 504].includes(err.status) || err?.name === 'TimeoutError' || err?.name === 'AbortError' || !err.status) {
          modelCooldownUntil.set(model, Date.now() + 60 * 1000);
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error('所有备选模型均请求失败');
  }

  function splitParagraphs(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .split(/\n(?:[\t ]*\n)+/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  const slotKey = (idx) => `slot:${idx}`;

  function buildOutputForItem(itemId) {
    const snap = latestItemSnapshots.get(itemId);
    const segStates = segmentMap.get(itemId);
    if (!snap || !segStates) return;

    const { rawText, fullKey, style, isGenerating, paragraphs } = snap;
    const prevLive = liveStates.get(itemId);
    const parts = [];
    let anyTranslating = false;
    let anyError = false;
    let allDone = paragraphs.length > 0;
    let lastErr = '';
    let lastModel = '';
    const activeKeys = new Set();

    for (let idx = 0; idx < paragraphs.length; idx++) {
      const para = paragraphs[idx];
      const pHash = cacheKeyFor(para, style);
      const sKey = slotKey(idx);
      activeKeys.add(pHash);
      activeKeys.add(sKey);

      const st = segStates.get(pHash);
      const fallbackSlot = segStates.get(sKey);
      const txt = st?.translated || fallbackSlot?.translated || '';
      if (txt) parts.push(txt);
      if (st?.status === 'translating') anyTranslating = true;
      if (st?.status !== 'done' || !st?.translated) allDone = false;
      if (st?.status === 'error') {
        anyError = true;
        if (st.error) lastErr = st.error;
      }
      if (st?.model) lastModel = st.model;

      // 思考已结束后，补录之前处于尾段尚未落盘的段落缓存，确保重启 0 重翻
      if (!isGenerating && st?.status === 'done' && st?.translated && st.model !== 'native-zh') {
        putDiskCache(pHash, st.translated);
      }
    }

    // 清理流式中间态产生的废弃 pHash，避免长思考内存膨胀
    if (segStates.size > activeKeys.size + 12) {
      for (const [k, v] of segStates.entries()) {
        if (!activeKeys.has(k) && !v?.inFlight) {
          segStates.delete(k);
        }
      }
    }

    const joined = parts.join('\n\n');
    const status = anyTranslating
      ? 'translating'
      : anyError && (!allDone || parts.length === 0)
        ? 'error'
        : allDone && parts.length > 0
          ? 'done'
          : isGenerating
            ? 'translating'
            : parts.length > 0
              ? 'done'
              : prevLive?.status || 'translating';

    // 整条思考完成且全部段落译完时写入整条 fullKey 缓存，重启瞬间零成本命中
    if (!isGenerating && allDone && joined) {
      putDiskCache(fullKey, joined);
    }

    liveStates.set(itemId, {
      sourceHash: fullKey,
      sourceLen: rawText.length,
      translated: joined,
      status,
      error: lastErr,
      model: lastModel,
      lastReqAt: Date.now(),
      inFlight: anyTranslating,
    });
    pruneMemoryMaps();
  }

  function triggerTranslate(item, settings) {
    const rawText = (item.thinking || '').trim();
    if (!rawText) return;
    const style = settings.translateStyle || 'natural';
    const fullKey = cacheKeyFor(rawText, style);

    if (containsMostlyChinese(rawText)) {
      liveStates.set(item.id, {
        sourceHash: fullKey,
        sourceLen: rawText.length,
        translated: rawText,
        status: 'done',
        error: '',
        model: 'native-zh',
        lastReqAt: Date.now(),
        inFlight: false,
      });
      pruneMemoryMaps();
      return;
    }

    const fullCached = diskCache.get(fullKey);
    if (fullCached) {
      liveStates.set(item.id, {
        sourceHash: fullKey,
        sourceLen: rawText.length,
        translated: fullCached,
        status: 'done',
        error: '',
        model: 'cache',
        lastReqAt: Date.now(),
        inFlight: false,
      });
      pruneMemoryMaps();
      return;
    }

    const isGenerating = item.status === 'generating';
    const paragraphs = splitParagraphs(rawText);
    if (paragraphs.length === 0) return;

    latestItemSnapshots.set(item.id, {
      rawText,
      fullKey,
      style,
      isGenerating,
      paragraphs,
    });

    let segStates = segmentMap.get(item.id);
    if (!segStates) {
      segStates = new Map();
      segmentMap.set(item.id, segStates);
    }

    const jobGlobalEpoch = globalEpoch;
    const jobItemEpoch = getItemEpoch(item.id);

    for (let idx = 0; idx < paragraphs.length; idx++) {
      const para = paragraphs[idx];
      const pHash = cacheKeyFor(para, style);
      const isTail = isGenerating && idx === paragraphs.length - 1;

      if (containsMostlyChinese(para)) {
        segStates.set(pHash, { translated: para, status: 'done', error: '', model: 'native-zh', lastReqAt: Date.now(), inFlight: false });
        segStates.set(slotKey(idx), { translated: para });
        continue;
      }

      const cachedSeg = diskCache.get(pHash);
      if (cachedSeg) {
        segStates.set(pHash, { translated: cachedSeg, status: 'done', error: '', model: 'cache', lastReqAt: Date.now(), inFlight: false });
        segStates.set(slotKey(idx), { translated: cachedSeg });
        continue;
      }

      const existing = segStates.get(pHash);
      if (existing?.inFlight) continue;
      if (existing?.status === 'done') {
        if (!isTail && existing.translated) putDiskCache(pHash, existing.translated);
        continue;
      }
      if (existing?.status === 'error' && Date.now() - existing.lastReqAt < 20000) continue;

      if (isTail) {
        const lastSlot = segStates.get(slotKey(idx));
        if (lastSlot?.inFlight) continue;
        if (lastSlot?.lastSourceLen && para.length - lastSlot.lastSourceLen < 48 && Date.now() - (lastSlot.lastReqAt || 0) < 1600) {
          continue;
        }
        if (para.length < 28 && paragraphs.length > 1) continue;
      }

      const slotSnapshot = segStates.get(slotKey(idx)) || { translated: '', lastSourceLen: 0, lastReqAt: 0, inFlight: false };
      slotSnapshot.inFlight = true;
      slotSnapshot.lastReqAt = Date.now();
      slotSnapshot.lastSourceLen = para.length;
      segStates.set(slotKey(idx), slotSnapshot);

      const segState = {
        translated: slotSnapshot.translated || '',
        status: 'translating',
        error: '',
        model: '',
        lastReqAt: Date.now(),
        inFlight: true,
      };
      segStates.set(pHash, segState);

      const controller = new AbortController();
      trackController(item.id, controller);

      enqueueJob(async () => {
        const isStale = () =>
          controller.signal.aborted ||
          jobGlobalEpoch !== globalEpoch ||
          jobItemEpoch !== getItemEpoch(item.id) ||
          segmentMap.get(item.id) !== segStates;

        if (isStale()) {
          segState.inFlight = false;
          slotSnapshot.inFlight = false;
          untrackController(item.id, controller);
          return;
        }

        try {
          const prevShownLen = (slotSnapshot.translated || '').length;
          let lastNotifyAt = 0;
          const { result, model } = await translateWithFallback(
            para,
            settings,
            (partial) => {
              if (isStale()) return;
              if (partial.length >= prevShownLen || prevShownLen === 0) {
                segState.translated = partial;
                slotSnapshot.translated = partial;
              }
              const now = Date.now();
              if (now - lastNotifyAt >= 85) {
                lastNotifyAt = now;
                buildOutputForItem(item.id);
                onProgress?.();
              }
            },
            controller.signal
          );
          if (isStale()) return;
          segState.translated = result;
          slotSnapshot.translated = result;
          segState.model = model;
          segState.status = 'done';
          segState.error = '';
          if (!isTail) {
            putDiskCache(pHash, result);
          }
        } catch (err) {
          if (isStale()) return;
          segState.status = 'error';
          segState.error = err?.message || '翻译失败';
        } finally {
          segState.inFlight = false;
          slotSnapshot.inFlight = false;
          untrackController(item.id, controller);
          if (!isStale()) {
            buildOutputForItem(item.id);
            onProgress?.();
          }
        }
      });
    }

    buildOutputForItem(item.id);
  }

  function enrichTurns(turns, options = {}) {
    const settings = getSettings();
    const enabled = settings.translateEnabled !== false;
    const hasKey = Boolean(settings.translateApiKey) || isLocalGatewayUrl(settings.translateBaseUrl);
    const triggerNew = options.triggerNew !== false;

    for (const turn of turns || []) {
      for (const item of turn.items || []) {
        if (item.kind !== 'think' || !item.thinking) continue;
        if (!enabled) {
          item.translateStatus = 'off';
          continue;
        }
        if (!hasKey && !containsMostlyChinese(item.thinking)) {
          item.translateStatus = 'no-key';
          continue;
        }

        if (triggerNew) {
          triggerTranslate(item, settings);
        }
        const st = liveStates.get(item.id);
        if (st) {
          item.translatedThinking = st.translated;
          item.translateStatus = st.status;
          item.translateError = st.error;
          item.translateModel = st.model;
        }
      }
    }
    return turns;
  }

  /**
   * 调用当前网关的 /models 接口，自动识别该 Key 下可用于翻译的对话模型并给出三维评分。
   */
  async function discoverModels(overrideSettings = {}) {
    const saved = getSettings();
    const baseUrl = (overrideSettings.translateBaseUrl || saved.translateBaseUrl || '').trim().replace(/\/+$/, '');
    const sameProvider = normalizeBaseUrl(baseUrl) === normalizeBaseUrl(saved.translateBaseUrl);
    const hasExplicitKey = typeof overrideSettings.translateApiKey === 'string' && overrideSettings.translateApiKey.trim() !== '';
    const apiKey = hasExplicitKey
      ? overrideSettings.translateApiKey.trim()
      : (sameProvider ? (saved.translateApiKey || '').trim() : '');

    if (!baseUrl) {
      throw new Error('请先填写 API Base URL');
    }
    if (!apiKey && !isLocalGatewayUrl(baseUrl)) {
      throw new Error(sameProvider ? '请先填写 API Key 再识别可用模型' : '已切换服务商地址，请先填写该服务商的 API Key');
    }

    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const targetUrl = isSiliconFlowUrl(baseUrl) ? `${baseUrl}/models?type=text` : `${baseUrl}/models`;
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`拉取模型列表失败 (HTTP ${res.status}): ${errText.slice(0, 120)}`);
    }

    const payload = await res.json();
    const rawList = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];

    const seen = new Set();
    const rated = [];
    for (const item of rawList) {
      const id = typeof item === 'string' ? item : (item?.id || item?.name || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (!isUsableTranslationModel(id)) continue;
      rated.push(evaluateModelForTranslation(id, baseUrl));
    }

    rated.sort((a, b) => b.overall - a.overall || a.id.localeCompare(b.id));
    return {
      ok: true,
      baseUrl,
      totalRaw: rawList.length,
      count: rated.length,
      models: rated,
    };
  }

  async function testConnection(overrideSettings = {}) {
    const saved = getSettings();
    const settings = { ...saved, ...overrideSettings };
    const sameProvider = normalizeBaseUrl(settings.translateBaseUrl) === normalizeBaseUrl(saved.translateBaseUrl);
    const hasExplicitKey = typeof overrideSettings.translateApiKey === 'string' && overrideSettings.translateApiKey.trim() !== '';
    if (!sameProvider && !hasExplicitKey) {
      settings.translateApiKey = '';
    }
    if (!settings.translateApiKey && !isLocalGatewayUrl(settings.translateBaseUrl)) {
      throw new Error(sameProvider ? '请先填写 API Key' : '已切换服务商地址，请先填写该服务商的 API Key');
    }
    const { result, model, ttftMs, totalMs } = await translateWithFallback(
      'I should check the config files first and make sure the layout looks clean without repeating the first line.',
      settings
    );
    return { ok: true, model, sample: result, ttftMs, totalMs };
  }

  function resetErrors() {
    modelCooldownUntil.clear();
    for (const [id, st] of liveStates.entries()) {
      if (st.status === 'error' || st.status === 'no-key') {
        itemEpochs.set(id, getItemEpoch(id) + 1);
        abortItemControllers(id);
        liveStates.delete(id);
        segmentMap.delete(id);
        latestItemSnapshots.delete(id);
      }
    }
  }

  function resetForStyleChange() {
    globalEpoch += 1;
    abortAllControllers();
    liveStates.clear();
    segmentMap.clear();
    latestItemSnapshots.clear();
    itemEpochs.clear();
  }

  function retryItem(itemId, rawText = '') {
    modelCooldownUntil.clear();
    const style = getSettings().translateStyle || 'natural';
    if (itemId) {
      itemEpochs.set(itemId, getItemEpoch(itemId) + 1);
      abortItemControllers(itemId);
      liveStates.delete(itemId);
      segmentMap.delete(itemId);
      latestItemSnapshots.delete(itemId);
      if (rawText) {
        diskCache.delete(cacheKeyFor(rawText.trim(), style));
        for (const para of splitParagraphs(rawText.trim())) {
          diskCache.delete(cacheKeyFor(para, style));
        }
        scheduleSave();
      }
      onProgress?.();
      return;
    }
    resetErrors();
    onProgress?.();
  }

  function clearCache() {
    globalEpoch += 1;
    abortAllControllers();
    diskCache.clear();
    liveStates.clear();
    segmentMap.clear();
    latestItemSnapshots.clear();
    itemEpochs.clear();
    modelCooldownUntil.clear();
    cacheDirty = true;
    flushCacheNow();
    onProgress?.();
  }

  function getStats() {
    return {
      cacheCount: diskCache.size,
      activeModel: lastActiveModel,
      inFlightCount: runningJobs,
      queuedCount: pendingJobs.length,
    };
  }

  return {
    enrichTurns,
    discoverModels,
    testConnection,
    resetErrors,
    resetForStyleChange,
    retryItem,
    clearCache,
    flushCache: flushCacheNow,
    getStats,
  };
}

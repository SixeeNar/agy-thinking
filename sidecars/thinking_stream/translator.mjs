import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const STYLE_PROMPTS = {
  steps: [
    '你正在把一段英文 AI 内部思考过程整理成清晰易读的「分步思路脉络」（简体中文），让人一眼看清每一步在想什么、判断出了什么。',
    '规则：',
    '1. 彻底删掉反复自我纠结、原地绕圈的废话（例如反复的 Wait / actually / let me re-check），只保留真正推进思路的动作、发现与决策。',
    '2. 按逻辑推进拆成 1~3 条简洁的思路节点（短内容只写 1 条，绝不硬凑）；每条必须严格采用如下列表格式：',
    '   - **4~12字短标题**：用 1~2 句干脆利落、无翻译腔的口语说清这一步查了什么、发现什么或准备怎么改。',
    '3. 严禁写成一整大段纯文字墙，严禁加任何开头说明、总结语或思考标签。',
    '4. 原样保留反引号内的代码、文件名、路径、函数名和命令行，绝不翻译代码标识符。',
  ].join('\n'),
  natural: [
    '你是一个母语为中文的资深工程师，请把下面这段英文 AI 内部思考过程转述成自然地道的简体中文。',
    '规则：',
    '1. 语气要像真人在边想边自言自语一样口语化、顺滑自然，彻底去掉「为了确保……」「需要系统地……」「值得注意的是……」这类生硬翻译腔。',
    '2. 每段可对 1 处最关键的结论或问题点使用 `**加粗**` 方便扫读（不要滥用），原样保留所有 Markdown 格式、反引号内的代码、文件路径、命令行、JSON 字段名、函数名和专有名词，绝不翻译代码标识符。',
    '3. 只输出中文正文，不要加任何开头说明、思考标签或总结。',
  ].join('\n'),
  technical: [
    '你是一个专业的技术文档与代码审阅译者。请把下面的英文 AI 内部思考过程精准、克制、清晰地翻译成简体中文。',
    '规则：',
    '1. 准确传达技术逻辑与因果关系，行文干练无废话，避免生硬直译。',
    '2. 每段可对 1 处核心定位或结论用 `**加粗**` 突出重点，原样保留所有 Markdown 格式、反引号内的代码、文件路径、命令行、JSON 字段名、函数名和专有名词，绝不翻译代码标识符。',
    '3. 只输出翻译后的中文正文，不要加任何开头说明、思考标签或总结。',
  ].join('\n'),
  concise: [
    '请把下面这段英文 AI 内部思考过程提炼并转译为极其简明直白的简体中文，让人扫一眼就懂。',
    '规则：',
    '1. 合并啰嗦铺垫，保留所有核心判断、排查动作与结论，口语直白无翻译腔，关键结论可用 `**加粗**` 点出。',
    '2. 原样保留反引号内的代码、文件路径、命令行与关键标识符。',
    '3. 只输出精简后的中文正文，不要加任何开头说明、思考标签或总结。',
  ].join('\n'),
};

const DISTILL_STEPS_PROMPT = [
  '下面是一整段完整的英文 AI 内部思考过程，里面可能存在反复犹豫、多次回头检查或表述重复。',
  '请你忠实原意做一次「去重归并」，按内容体量提炼成清晰递进的「分步思路脉络」（中等篇幅 1~3 步，长篇幅 3~6 步，绝不硬凑，最多不超过 6 步）。',
  '规则：',
  '1. 把同类或反复纠结的段落合并成同一步，彻底砍掉兜圈子的废话（如反复的 Wait / Actually / Let me re-check），只留真正推进结论的排查动作、关键发现和最终决定。',
  '2. 每一步严格采用如下 Markdown 列表格式：',
  '   - **4~12字短标题**：用 1~2 句干脆直白、无翻译腔的简体中文忠实说清这一步查了什么、发现什么或决定怎么改。',
  '3. 严禁写成一大段散文墙，严禁添加原文没有的发挥、角色扮演、开头语、结尾总结或任何思考标签。',
  '4. 原样保留反引号内的文件名、路径、函数名、CSS 类名和命令，绝不翻译代码标识符。',
].join('\n');

const NARRATIVE_PROMPTS = {
  steps: [
    '把下面这段 AI 内部思考过程浓缩成一句极简中文进展（15~55 字），让人扫一眼就懂这一步干了什么或判断出了什么。',
    '规则：',
    '1. 语气自然干脆、零翻译腔，直接说清核心动作或结论。',
    '2. 关键文件名/符号用反引号保留，最多 1 处 `**加粗**`。',
    '3. 只输出这一句话，不要列表、标题或前缀。',
  ].join('\n'),
  natural: [
    '你正在把一段 AI 内部思考过程提炼成展示给用户看的极简步骤进展（1~2 句简体中文，总长控制在 25~85 字）。',
    '规则：',
    '1. 直接说清这一步查到了什么、判断出什么、或者准备干什么，语气像真人在一步步顺口汇报进度，干脆利落、零翻译腔。',
    '2. 只在最关键的转折词或结论词上用 `**加粗**`（最多 1~2 处，不滥用），文件名、命令、代码标识用反引号原样保留。',
    '3. 只输出这 1~2 句正文，严禁分点列表、严禁加标题或前缀说明。',
  ].join('\n'),
  technical: [
    '把下面这段 AI 内部思考过程压缩成 1~2 句干练克制的简体中文技术进度摘要（25~85 字）。',
    '规则：',
    '1. 直接交代定位结论、根因或下一步技术动作，无铺垫废话。',
    '2. 仅对最核心的判断词做 1 处 `**加粗**`，文件名、函数名、命令用反引号原样保留。',
    '3. 只输出这 1~2 句正文，不要标题、列表或额外说明。',
  ].join('\n'),
  concise: [
    '把下面这段 AI 内部思考过程浓缩成极简的一句话中文进展（15~48 字），直白干脆，去掉全部铺垫。',
    '规则：',
    '1. 保留核心动作或结论，关键文件名/符号用反引号保留，最多 1 处 `**加粗**`。',
    '2. 只输出这一句话，不要列表、标题或前缀。',
  ].join('\n'),
};

const MAX_CONCURRENCY = 4;

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
    match: /(deepseek-r1|qwq|glm-z1|seed-thinking|reasoner|o1-|o3-|o4-|-thinking)/i,
    overall: 64,
    value: 66,
    natural: 62,
    costTag: '推理型·偏慢',
    costTone: 'slow',
    reason: '自带内部思考链，首字延迟高，不适合做实时译者',
  },
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
    match: /(^|\/)(qwen3\.5-flash|qwen-flash|qwen-?2\.5[-:]7b(-instruct)?|qwen3[-:]8b|qwen3[-:]4b)/i,
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
 * 剥离某些兼容接口可能夹带在响应开头的 <think>...</think> 推理块，
 * 仅处理前缀标签，避免误伤正文中讨论到的 `<think>` 字面量；支持流式半截前缀增量隐藏。
 */
export function stripThinkTags(raw, isFinal = false) {
  if (!raw) return '';
  let out = String(raw).trimStart();
  while (/^<think>/i.test(out)) {
    const closeMatch = out.match(/<\/think>/i);
    if (closeMatch) {
      out = out.slice(closeMatch.index + closeMatch[0].length).trimStart();
    } else {
      return '';
    }
  }
  out = out.replace(/^(?:<\/think>\s*)+/i, '');
  if (!isFinal && out.length < '<think>'.length) {
    const lower = out.toLowerCase();
    if ('<think>'.startsWith(lower) || '</think>'.startsWith(lower)) {
      return '';
    }
  }
  return out;
}

export function buildTranslateRequestBody({
  baseUrl,
  model,
  text,
  disableTranslatorThinking = true,
  translateStyle = 'natural',
  promptMode = 'full',
}) {
  if (isQwenMtModel(model)) {
    // DashScope qwen-mt 专用翻译接口要求使用 translation_options，不支持 system 角色
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
    // 腾讯混元专用翻译模型严禁附加 enable_thinking；按 promptMode 选择对应指令
    const userPrompt = promptMode === 'distill'
      ? `${DISTILL_STEPS_PROMPT}\n\n${text}`
      : promptMode === 'narrative'
        ? `${NARRATIVE_PROMPTS[translateStyle] || NARRATIVE_PROMPTS.natural}\n\n${text}`
        : `把下面的文本翻译成自然口语化的简体中文，避免书面翻译腔，原样保留所有 Markdown 格式、反引号代码、路径和专有名词，不要额外解释。\n${text}`;
    return {
      model,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: promptMode === 'full' ? 0.25 : 0.2,
      stream: true,
    };
  }

  if (promptMode === 'distill') {
    const body = {
      model,
      messages: [
        { role: 'system', content: DISTILL_STEPS_PROMPT },
        { role: 'user', content: text },
      ],
      temperature: 0.2,
      stream: true,
    };
    if (disableTranslatorThinking !== false) {
      if (isLocalGatewayUrl(baseUrl)) body.reasoning_effort = 'none';
      else if (supportsZhipuThinkingDisable(baseUrl, model)) body.thinking = { type: 'disabled' };
      else if (supportsEnableThinkingFlag(baseUrl, model)) body.enable_thinking = false;
    }
    return body;
  }

  const promptTable = promptMode === 'narrative' ? NARRATIVE_PROMPTS : STYLE_PROMPTS;
  const systemPrompt = promptTable[translateStyle] || promptTable.natural;
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
  promptMode = 'full',
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
    promptMode,
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
  let rawNonSse = '';
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
    const chunkText = decoder.decode(value, { stream: true });
    if (!sawSseData && rawNonSse.length < 65536) {
      rawNonSse += chunkText.slice(0, 65536 - rawNonSse.length);
    }
    buffer += chunkText;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) processLine(line);
  }

  // Flush UTF-8 解码器尾字节并处理流尾未换行的残留数据
  const tailDecoded = decoder.decode();
  if (!sawSseData && tailDecoded && rawNonSse.length < 65536) {
    rawNonSse += tailDecoded.slice(0, 65536 - rawNonSse.length);
  }
  buffer += tailDecoded;
  if (buffer.trim()) {
    const tailLines = buffer.split(/\r?\n/);
    for (const line of tailLines) processLine(line);
  }
  if (!sawSseData && rawNonSse.trim()) {
    // 兼容部分网关返回非流式 JSON（含多行缩进或末尾带换行）或 HTTP 200 错误体
    try {
      const parsed = JSON.parse(rawNonSse.trim());
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

  const finalClean = stripThinkTags(rawFull, true).trim();
  const totalMs = Date.now() - startedAt;
  return { text: finalClean, ttftMs: ttftMs ?? totalMs, totalMs };
}

export function createTranslator(getSettings, onProgress) {
  const cachePath = getCachePath();
  const diskCache = new Map();
  const liveStates = new Map();
  const distillStates = new Map(); // itemId -> 长思考结束后的整篇去重提炼状态（合并成 3~6 步）
  const fullDetailStates = new Map(); // itemId -> 按需点击「看完整」时生成的全量自然译文状态
  const narrativeStates = new Map(); // itemId -> { sourceHash, sourceLen, text, status, error, model, lastReqAt, inFlight, seq, controller }
  const fullRequestedIds = new Set(); // 在「分步脉络」模式下用户按需点开「看完整」的 itemId
  const modelCooldownUntil = new Map();
  const segmentMap = new Map();
  const latestItemSnapshots = new Map(); // itemId -> { rawText, fullKey, style, isGenerating, paragraphs }
  const itemEpochs = new Map(); // itemId -> number
  const itemControllers = new Map(); // itemId -> Set<AbortController>
  let globalEpoch = 0;
  let cacheEpoch = 0;
  let lastActiveModel = '';

  const MAX_LIVE_ITEMS = 200;

  const fullTrackKey = (itemId) => `full:${itemId}`;
  const distillTrackKey = (itemId) => `distill:${itemId}`;
  const detailTrackKey = (itemId) => `detail:${itemId}`;
  const narrTrackKey = (itemId) => `narr:${itemId}`;
  const getItemEpoch = (trackKey) => itemEpochs.get(trackKey) || 0;

  const abortItemControllers = (trackKey) => {
    const set = itemControllers.get(trackKey);
    if (!set) return;
    for (const ctrl of set) {
      try { ctrl.abort(); } catch {}
    }
    set.clear();
    itemControllers.delete(trackKey);
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

  const trackController = (trackKey, ctrl) => {
    let set = itemControllers.get(trackKey);
    if (!set) {
      set = new Set();
      itemControllers.set(trackKey, set);
    }
    set.add(ctrl);
  };

  const untrackController = (trackKey, ctrl) => {
    const set = itemControllers.get(trackKey);
    if (!set) return;
    set.delete(ctrl);
    if (set.size === 0) itemControllers.delete(trackKey);
  };

  const pruneMemoryMaps = () => {
    if (liveStates.size > MAX_LIVE_ITEMS) {
      for (const [id, st] of liveStates.entries()) {
        if (liveStates.size <= MAX_LIVE_ITEMS) break;
        if (st?.inFlight) continue;
        liveStates.delete(id);
        distillStates.delete(id);
        fullDetailStates.delete(id);
        segmentMap.delete(id);
        latestItemSnapshots.delete(id);
        itemEpochs.delete(fullTrackKey(id));
        itemEpochs.delete(distillTrackKey(id));
        itemEpochs.delete(detailTrackKey(id));
        fullRequestedIds.delete(id);
      }
    }
    if (narrativeStates.size > MAX_LIVE_ITEMS) {
      for (const [id, st] of narrativeStates.entries()) {
        if (narrativeStates.size <= MAX_LIVE_ITEMS) break;
        if (st?.inFlight) continue;
        narrativeStates.delete(id);
        itemEpochs.delete(narrTrackKey(id));
      }
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

  const MAX_AUTO_RETRIES = 3;
  const isPermanentError = (err) => Boolean(err && [401, 402, 403].includes(err.status));
  const shouldSkipErrorRetry = (st) => {
    if (!st || st.status !== 'error') return false;
    if (st.permanentError) return true;
    if ((st.errorCount || 0) >= MAX_AUTO_RETRIES) return true;
    const retryAt = st.nextRetryAt || ((st.lastReqAt || 0) + 20000);
    return Date.now() < retryAt;
  };
  const computeErrorRetryMeta = (err, prevErrorCount = 0) => {
    const now = Date.now();
    const errorCount = prevErrorCount + 1;
    const permanentError = isPermanentError(err);
    const backoffMs = Math.min(120000, 20000 * (2 ** Math.min(errorCount - 1, 2)));
    const nextRetryAt = permanentError
      ? Infinity
      : Math.max(now + backoffMs, err?.retryAfterAt || 0);
    return { lastReqAt: now, errorCount, permanentError, nextRetryAt };
  };

  async function translateWithFallback(text, settings, onChunk, externalSignal, promptMode = 'full', timeoutMs = 22000, options = {}) {
    const models = parseModels(settings.translateModels);
    if (models.length === 0) throw new Error('未配置翻译模型名称');

    const orderedModels = (promptMode === 'distill' || promptMode === 'narrative')
      ? [
          ...models.filter((m) => !isQwenMtModel(m) && !isHunyuanMtModel(m)),
          ...models.filter((m) => isHunyuanMtModel(m)),
          ...models.filter((m) => isQwenMtModel(m)),
        ]
      : models;

    const now = Date.now();
    const activeModels = orderedModels.filter((m) => (modelCooldownUntil.get(m) || 0) <= now);
    if (activeModels.length === 0 && !options.bypassCooldown) {
      const earliestReady = Math.min(...orderedModels.map((m) => modelCooldownUntil.get(m) || now));
      const waitSec = Math.max(1, Math.ceil((earliestReady - now) / 1000));
      const err = new Error(`翻译模型冷却中（约 ${waitSec}s 后恢复，或点「重试失败」立即重试）`);
      err.retryAfterAt = earliestReady;
      throw err;
    }
    const candidates = activeModels.length > 0 ? activeModels : orderedModels;

    let lastErr = null;
    for (const model of candidates) {
      if (externalSignal?.aborted) {
        const abortErr = new Error('翻译已取消');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      const runOnce = async (disableThink) => {
        const timeoutSig = AbortSignal.timeout(timeoutMs);
        const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSig]) : timeoutSig;
        return streamChatCompletion({
          baseUrl: settings.translateBaseUrl,
          apiKey: settings.translateApiKey,
          model,
          text,
          disableTranslatorThinking: disableThink,
          translateStyle: settings.translateStyle || 'steps',
          promptMode,
          onChunk,
          signal,
        });
      };

      try {
        let res;
        try {
          res = await runOnce(settings.disableTranslatorThinking !== false);
        } catch (err) {
          // 兼容部分网关不支持 reasoning_effort / enable_thinking / thinking 参数返回 400/422：自动剥离重试一次
          if (
            (err?.status === 400 || err?.status === 422) &&
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
          modelCooldownUntil.delete(model);
          lastActiveModel = model;
          return { result: res.text, model, ttftMs: res.ttftMs, totalMs: res.totalMs };
        }
        lastErr = new Error(`模型 ${model} 返回空译文`);
      } catch (err) {
        if (externalSignal?.aborted) throw err;
        lastErr = err;
        if ([400, 401, 402, 403, 404, 422, 429].includes(err.status)) {
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

  const BRIEF_THINK_CHAR_LIMIT = 220;

  function buildOutputForItem(itemId) {
    const snap = latestItemSnapshots.get(itemId);
    const segStates = segmentMap.get(itemId);
    if (!snap || !segStates) return;

    const { rawText, fullKey, cacheFullKey, style, segStyle, isGenerating, paragraphs } = snap;
    const effectiveSegStyle = segStyle || style;
    const diskFullKey = cacheFullKey || fullKey;
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
      const pHash = cacheKeyFor(para, effectiveSegStyle);
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

    // 整条思考完成且全部段落译完时写入对应风格的整条缓存（纯 qwen-mt 降级直译写到 natural 键，避免污染 steps）
    if (!isGenerating && allDone && joined) {
      putDiskCache(diskFullKey, joined);
    }

    liveStates.set(itemId, {
      sourceHash: fullKey,
      sourceLen: rawText.length,
      translated: joined,
      status,
      phase: isGenerating || anyTranslating ? 'streaming' : '',
      error: lastErr,
      model: lastModel,
      lastReqAt: Date.now(),
      inFlight: anyTranslating,
    });
    pruneMemoryMaps();
  }

  function sampleForDistill(rawText) {
    if (rawText.length <= 9000) return rawText;
    return `${rawText.slice(0, 4800)}\n\n[...中间过程已略...]\n\n${rawText.slice(-3800)}`;
  }

  function triggerDistillSteps(item, settings, fullKey) {
    const rawText = (item.thinking || '').trim();
    if (!rawText) return;
    const prev = distillStates.get(item.id);
    if (prev && prev.sourceHash === fullKey) {
      if (prev.inFlight || prev.status === 'done') return;
      if (shouldSkipErrorRetry(prev)) return;
    }
    const prevErrorCount = prev && prev.sourceHash === fullKey && prev.status === 'error' ? (prev.errorCount || 0) : 0;

    const fKey = fullTrackKey(item.id);
    abortItemControllers(fKey);
    const dsKey = distillTrackKey(item.id);
    abortItemControllers(dsKey);
    const controller = new AbortController();
    trackController(dsKey, controller);

    const existingLive = liveStates.get(item.id);
    const fallbackText = existingLive?.translated || '';
    const fallbackComplete = Boolean(
      fallbackText &&
      existingLive?.status === 'done' &&
      !existingLive?.inFlight &&
      existingLive?.sourceLen === rawText.length
    );
    const state = {
      sourceHash: fullKey,
      text: fallbackText,
      status: 'translating',
      error: '',
      model: existingLive?.model || '',
      lastReqAt: Date.now(),
      errorCount: prevErrorCount,
      permanentError: false,
      nextRetryAt: 0,
      inFlight: true,
    };
    distillStates.set(item.id, state);
    liveStates.set(item.id, {
      sourceHash: fullKey,
      sourceLen: rawText.length,
      translated: fallbackText,
      status: 'translating',
      phase: 'distilling',
      error: '',
      model: state.model,
      lastReqAt: Date.now(),
      inFlight: true,
    });

    const jobGlobalEpoch = globalEpoch;
    const jobItemEpoch = getItemEpoch(dsKey);
    const inputSample = sampleForDistill(rawText);

    enqueueJob(async () => {
      const isStale = () =>
        controller.signal.aborted ||
        jobGlobalEpoch !== globalEpoch ||
        jobItemEpoch !== getItemEpoch(dsKey) ||
        distillStates.get(item.id) !== state;

      if (isStale()) {
        state.inFlight = false;
        untrackController(dsKey, controller);
        return;
      }

      try {
        let lastNotifyAt = 0;
        const { result, model } = await translateWithFallback(
          inputSample,
          settings,
          (partial) => {
            if (isStale()) return;
            state.text = partial;
            // 若已有流式实时译文，保留它直到整篇精炼完成再一次性无缝替换，避免画面突然变短跳水；无草稿（如回看历史）则实时流式展示
            if (!fallbackText) {
              liveStates.set(item.id, {
                sourceHash: fullKey,
                sourceLen: rawText.length,
                translated: partial,
                status: 'translating',
                phase: 'distilling',
                error: '',
                model: state.model,
                lastReqAt: Date.now(),
                inFlight: true,
              });
              const now = Date.now();
              if (now - lastNotifyAt >= 90) {
                lastNotifyAt = now;
                onProgress?.();
              }
            }
          },
          controller.signal,
          'distill',
          35000
        );
        if (isStale()) return;
        state.text = result;
        state.model = model;
        state.status = 'done';
        state.error = '';
        state.errorCount = 0;
        state.permanentError = false;
        state.nextRetryAt = 0;
        putDiskCache(fullKey, result);
        liveStates.set(item.id, {
          sourceHash: fullKey,
          sourceLen: rawText.length,
          translated: result,
          status: 'done',
          phase: '',
          error: '',
          model,
          lastReqAt: Date.now(),
          inFlight: false,
        });
      } catch (err) {
        if (isStale()) return;
        state.status = 'error';
        state.error = err?.message || '脉络提炼失败';
        Object.assign(state, computeErrorRetryMeta(err, prevErrorCount));
        liveStates.set(item.id, {
          sourceHash: fullKey,
          sourceLen: rawText.length,
          translated: fallbackText,
          status: fallbackComplete ? 'done' : 'error',
          phase: '',
          error: fallbackComplete
            ? ''
            : (fallbackText ? `脉络提炼失败（当前仅显示部分草稿）：${state.error}` : state.error),
          model: state.model,
          lastReqAt: state.lastReqAt,
          inFlight: false,
        });
      } finally {
        state.inFlight = false;
        untrackController(dsKey, controller);
        pruneMemoryMaps();
        if (!isStale()) onProgress?.();
      }
    });
  }

  function triggerTranslate(item, settings) {
    const rawText = (item.thinking || '').trim();
    if (!rawText) return;
    const style = settings.translateStyle || 'steps';
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

    // 中长思考结束后，在「分步脉络」模式下整篇去重提炼成 1~6 步；极短思考（<220字且<3段）保持轻量自然直译不硬拆编号
    const configuredModels = parseModels(settings.translateModels);
    const onlyPureQwenMt = configuredModels.length > 0 && configuredModels.every((m) => isQwenMtModel(m));
    const isLongForSteps = paragraphs.length >= 3 || rawText.length >= BRIEF_THINK_CHAR_LIMIT;
    const shouldDistill = !isGenerating && style === 'steps' && !onlyPureQwenMt && isLongForSteps;
    if (shouldDistill) {
      triggerDistillSteps(item, settings, fullKey);
      return;
    }

    // 纯 qwen-mt 在 steps 模式下走降级直译：复用并落盘到 natural 缓存键，绝不污染 steps 缓存键
    const degradedMtFallback = style === 'steps' && onlyPureQwenMt && isLongForSteps;
    const cacheFullKey = degradedMtFallback ? cacheKeyFor(rawText, 'natural') : fullKey;
    if (degradedMtFallback) {
      const natCached = diskCache.get(cacheFullKey);
      if (natCached) {
        liveStates.set(item.id, {
          sourceHash: fullKey,
          sourceLen: rawText.length,
          translated: natCached,
          status: 'done',
          phase: '',
          error: '',
          model: 'cache',
          lastReqAt: Date.now(),
          inFlight: false,
        });
        pruneMemoryMaps();
        return;
      }
    }

    // 流式直播阶段与极短思考在 steps 模式下均采用自然直译，避免逐段硬拆出几十个临时编号节点
    const segStyle = style === 'steps' ? 'natural' : style;
    const segSettings = segStyle === settings.translateStyle ? settings : { ...settings, translateStyle: segStyle };

    latestItemSnapshots.set(item.id, {
      rawText,
      fullKey,
      cacheFullKey,
      style,
      segStyle,
      isGenerating,
      paragraphs,
    });

    let segStates = segmentMap.get(item.id);
    if (!segStates) {
      segStates = new Map();
      segmentMap.set(item.id, segStates);
    }

    const jobGlobalEpoch = globalEpoch;
    const fKey = fullTrackKey(item.id);
    const jobItemEpoch = getItemEpoch(fKey);

    const cancelSlotInFlight = (idx) => {
      const oldSlot = segStates.get(slotKey(idx));
      if (!oldSlot) return;
      oldSlot.seq = (oldSlot.seq || 0) + 1;
      oldSlot.inFlight = false;
      if (oldSlot.controller) {
        try { oldSlot.controller.abort(); } catch {}
        untrackController(fKey, oldSlot.controller);
        oldSlot.controller = null;
      }
    };

    for (let idx = 0; idx < paragraphs.length; idx++) {
      const para = paragraphs[idx];
      const pHash = cacheKeyFor(para, segStyle);
      const isTail = isGenerating && idx === paragraphs.length - 1;

      if (containsMostlyChinese(para)) {
        cancelSlotInFlight(idx);
        segStates.set(pHash, { translated: para, status: 'done', error: '', model: 'native-zh', lastReqAt: Date.now(), inFlight: false });
        segStates.set(slotKey(idx), { translated: para });
        continue;
      }

      const cachedSeg = diskCache.get(pHash);
      if (cachedSeg) {
        cancelSlotInFlight(idx);
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
      if (shouldSkipErrorRetry(existing)) continue;
      const prevSegErrorCount = existing?.status === 'error' ? (existing.errorCount || 0) : 0;

      if (isTail) {
        const lastSlot = segStates.get(slotKey(idx));
        if (lastSlot?.inFlight) continue;
        const deltaLen = lastSlot?.lastSourceLen ? para.length - lastSlot.lastSourceLen : para.length;
        if (
          lastSlot?.lastSourceLen &&
          (deltaLen < 12 || (deltaLen < 48 && Date.now() - (lastSlot.lastReqAt || 0) < 1600))
        ) {
          continue;
        }
        if (para.length < 28 && paragraphs.length > 1) continue;
      }

      const slotSnapshot = segStates.get(slotKey(idx)) || {
        translated: '',
        lastSourceLen: 0,
        lastReqAt: 0,
        inFlight: false,
        seq: 0,
        controller: null,
      };
      // 同 slot 若仍有旧的流式半截请求在跑（例如从尾段转为最终整段），立即中止旧请求并递增世代号防止回写覆盖
      if (slotSnapshot.controller) {
        try { slotSnapshot.controller.abort(); } catch {}
        untrackController(fKey, slotSnapshot.controller);
        slotSnapshot.controller = null;
      }
      const mySlotSeq = (slotSnapshot.seq || 0) + 1;
      slotSnapshot.seq = mySlotSeq;
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
        errorCount: prevSegErrorCount,
        permanentError: false,
        nextRetryAt: 0,
        inFlight: true,
      };
      segStates.set(pHash, segState);

      const controller = new AbortController();
      slotSnapshot.controller = controller;
      trackController(fKey, controller);

      enqueueJob(async () => {
        const isStale = () =>
          controller.signal.aborted ||
          jobGlobalEpoch !== globalEpoch ||
          jobItemEpoch !== getItemEpoch(fKey) ||
          segmentMap.get(item.id) !== segStates ||
          slotSnapshot.seq !== mySlotSeq;

        if (isStale()) {
          segState.inFlight = false;
          if (slotSnapshot.seq === mySlotSeq) {
            slotSnapshot.inFlight = false;
            if (slotSnapshot.controller === controller) slotSnapshot.controller = null;
          }
          untrackController(fKey, controller);
          return;
        }

        try {
          let bestShownLen = (slotSnapshot.translated || '').length;
          let lastNotifyAt = 0;
          const { result, model } = await translateWithFallback(
            para,
            segSettings,
            (partial) => {
              if (isStale()) return;
              if (partial.length >= bestShownLen || bestShownLen === 0) {
                bestShownLen = partial.length;
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
          segState.errorCount = 0;
          segState.permanentError = false;
          segState.nextRetryAt = 0;
          if (!isTail) {
            putDiskCache(pHash, result);
          }
        } catch (err) {
          if (isStale()) return;
          segState.status = 'error';
          segState.error = err?.message || '翻译失败';
          Object.assign(segState, computeErrorRetryMeta(err, prevSegErrorCount));
        } finally {
          segState.inFlight = false;
          if (slotSnapshot.seq === mySlotSeq) {
            slotSnapshot.inFlight = false;
            if (slotSnapshot.controller === controller) slotSnapshot.controller = null;
          }
          untrackController(fKey, controller);
          if (!isStale()) {
            buildOutputForItem(item.id);
            onProgress?.();
          }
        }
      });
    }

    buildOutputForItem(item.id);
  }

  function sampleForNarrative(rawText) {
    if (rawText.length <= 4200) return rawText;
    return `${rawText.slice(0, 2400)}\n\n...\n\n${rawText.slice(-1600)}`;
  }

  function narrativeCacheKey(rawText, style = 'natural') {
    return hashText(`narr:${style}:${rawText}`);
  }

  function triggerNarrativeSummary(item, settings) {
    const rawText = (item.thinking || '').trim();
    if (!rawText) return;
    const style = settings.translateStyle || 'steps';
    const nKey = narrativeCacheKey(rawText, style);
    const isGenerating = item.status === 'generating';

    const nTrackKey = narrTrackKey(item.id);
    const abortPrevNarr = (oldState) => {
      if (oldState?.controller) {
        try { oldState.controller.abort(); } catch {}
        untrackController(nTrackKey, oldState.controller);
        oldState.controller = null;
      }
    };

    // 原文本身就是简短中文且无多段堆叠，直接零请求复用
    if (containsMostlyChinese(rawText) && rawText.length <= 120 && !/\n\s*\n/.test(rawText)) {
      const oldNarr = narrativeStates.get(item.id);
      abortPrevNarr(oldNarr);
      narrativeStates.set(item.id, {
        sourceHash: nKey,
        sourceLen: rawText.length,
        text: rawText,
        status: 'done',
        error: '',
        model: 'native-zh',
        lastReqAt: Date.now(),
        inFlight: false,
        seq: (oldNarr?.seq || 0) + 1,
        controller: null,
      });
      pruneMemoryMaps();
      return;
    }

    const cached = diskCache.get(nKey);
    if (cached) {
      const oldNarr = narrativeStates.get(item.id);
      abortPrevNarr(oldNarr);
      narrativeStates.set(item.id, {
        sourceHash: nKey,
        sourceLen: rawText.length,
        text: cached,
        status: 'done',
        error: '',
        model: 'cache',
        lastReqAt: Date.now(),
        inFlight: false,
        seq: (oldNarr?.seq || 0) + 1,
        controller: null,
      });
      pruneMemoryMaps();
      return;
    }

    const prev = narrativeStates.get(item.id);
    if (prev && prev.sourceHash === nKey) {
      if (prev.inFlight) return;
      if (prev.status === 'done') {
        if (!isGenerating && prev.text && prev.model !== 'native-zh') {
          putDiskCache(nKey, prev.text);
        }
        return;
      }
      if (shouldSkipErrorRetry(prev)) return;
    }
    const prevNarrErrorCount = prev && prev.sourceHash === nKey && prev.status === 'error' ? (prev.errorCount || 0) : 0;

    // 流式生成中的节流：先攒够 40 字再首翻，后续至少新增 40 字且满足（涨 >=180 字或隔 >=2.4s）再刷；思考完成立刻发最终提炼
    if (isGenerating) {
      if (rawText.length < 40) return;
      if (prev?.inFlight) return;
      const deltaLen = prev?.sourceLen ? rawText.length - prev.sourceLen : rawText.length;
      if (
        prev?.sourceLen &&
        (deltaLen < 40 || (deltaLen < 180 && Date.now() - (prev.lastReqAt || 0) < 2400))
      ) {
        return;
      }
    }

    abortPrevNarr(prev);

    const mySeq = (prev?.seq || 0) + 1;
    const controller = new AbortController();
    const state = {
      sourceHash: nKey,
      sourceLen: rawText.length,
      text: prev?.text || '',
      status: 'translating',
      error: '',
      model: prev?.model || '',
      lastReqAt: Date.now(),
      errorCount: prevNarrErrorCount,
      permanentError: false,
      nextRetryAt: 0,
      inFlight: true,
      seq: mySeq,
      controller,
    };
    narrativeStates.set(item.id, state);
    trackController(nTrackKey, controller);
    pruneMemoryMaps();

    const jobGlobalEpoch = globalEpoch;
    const jobItemEpoch = getItemEpoch(nTrackKey);
    const inputSample = sampleForNarrative(rawText);

    enqueueJob(async () => {
      const isStale = () =>
        controller.signal.aborted ||
        jobGlobalEpoch !== globalEpoch ||
        jobItemEpoch !== getItemEpoch(nTrackKey) ||
        narrativeStates.get(item.id)?.seq !== mySeq;

      if (isStale()) {
        state.inFlight = false;
        if (state.controller === controller) state.controller = null;
        untrackController(nTrackKey, controller);
        return;
      }

      try {
        let lastNotifyAt = 0;
        const { result, model } = await translateWithFallback(
          inputSample,
          settings,
          (partial) => {
            if (isStale()) return;
            state.text = partial;
            const now = Date.now();
            if (now - lastNotifyAt >= 90) {
              lastNotifyAt = now;
              onProgress?.();
            }
          },
          controller.signal,
          'narrative'
        );
        if (isStale()) return;
        state.text = result;
        state.model = model;
        state.status = 'done';
        state.error = '';
        state.errorCount = 0;
        state.permanentError = false;
        state.nextRetryAt = 0;
        if (!isGenerating) {
          putDiskCache(nKey, result);
        }
      } catch (err) {
        if (isStale()) return;
        state.status = 'error';
        state.error = err?.message || '摘要提炼失败';
        Object.assign(state, computeErrorRetryMeta(err, prevNarrErrorCount));
      } finally {
        state.inFlight = false;
        if (state.controller === controller) state.controller = null;
        untrackController(nTrackKey, controller);
        if (!isStale()) {
          onProgress?.();
        }
      }
    });
  }

  function triggerFullDetailTranslate(item, settings) {
    const rawText = (item.thinking || '').trim();
    if (!rawText) return;
    // 流式思考阶段在 steps 模式下本就是自然直译，等思考结束后再触发整篇完整译文，防止每 350ms 取消重发打爆接口
    if (item.status === 'generating') return;
    const style = 'natural';
    const dKey = cacheKeyFor(rawText, style);

    if (containsMostlyChinese(rawText)) {
      fullDetailStates.set(item.id, {
        sourceHash: dKey,
        translated: rawText,
        status: 'done',
        error: '',
        model: 'native-zh',
        lastReqAt: Date.now(),
        inFlight: false,
      });
      return;
    }

    const cached = diskCache.get(dKey);
    if (cached) {
      fullDetailStates.set(item.id, {
        sourceHash: dKey,
        translated: cached,
        status: 'done',
        error: '',
        model: 'cache',
        lastReqAt: Date.now(),
        inFlight: false,
      });
      return;
    }

    const prev = fullDetailStates.get(item.id);
    if (prev && prev.sourceHash === dKey) {
      if (prev.inFlight || prev.status === 'done') return;
      if (shouldSkipErrorRetry(prev)) return;
    }
    const prevDetailErrorCount = prev && prev.sourceHash === dKey && prev.status === 'error' ? (prev.errorCount || 0) : 0;

    const dTrackKey = detailTrackKey(item.id);
    abortItemControllers(dTrackKey);
    const controller = new AbortController();
    trackController(dTrackKey, controller);

    const state = {
      sourceHash: dKey,
      translated: prev?.translated || '',
      status: 'translating',
      error: '',
      model: '',
      lastReqAt: Date.now(),
      errorCount: prevDetailErrorCount,
      permanentError: false,
      nextRetryAt: 0,
      inFlight: true,
    };
    fullDetailStates.set(item.id, state);

    const jobGlobalEpoch = globalEpoch;
    const jobItemEpoch = getItemEpoch(dTrackKey);
    const fullSettings = { ...settings, translateStyle: 'natural' };
    const isGenerating = item.status === 'generating';

    enqueueJob(async () => {
      const isStale = () =>
        controller.signal.aborted ||
        jobGlobalEpoch !== globalEpoch ||
        jobItemEpoch !== getItemEpoch(dTrackKey) ||
        fullDetailStates.get(item.id) !== state;

      if (isStale()) {
        state.inFlight = false;
        untrackController(dTrackKey, controller);
        return;
      }

      try {
        let lastNotifyAt = 0;
        const { result, model } = await translateWithFallback(
          rawText,
          fullSettings,
          (partial) => {
            if (isStale()) return;
            state.translated = partial;
            const now = Date.now();
            if (now - lastNotifyAt >= 90) {
              lastNotifyAt = now;
              onProgress?.();
            }
          },
          controller.signal,
          'full',
          45000
        );
        if (isStale()) return;
        state.translated = result;
        state.model = model;
        state.status = 'done';
        state.error = '';
        state.errorCount = 0;
        state.permanentError = false;
        state.nextRetryAt = 0;
        if (!isGenerating) putDiskCache(dKey, result);
      } catch (err) {
        if (isStale()) return;
        state.status = 'error';
        state.error = err?.message || '完整翻译失败';
        Object.assign(state, computeErrorRetryMeta(err, prevDetailErrorCount));
      } finally {
        state.inFlight = false;
        untrackController(dTrackKey, controller);
        if (!isStale()) onProgress?.();
      }
    });
  }

  function enrichTurns(turns, options = {}) {
    const settings = getSettings();
    const enabled = settings.translateEnabled !== false;
    const style = settings.translateStyle || 'steps';
    const summaryEnabled = settings.summaryEnabled === true && style !== 'steps';
    const hasKey = Boolean(settings.translateApiKey) || isLocalGatewayUrl(settings.translateBaseUrl);
    const triggerNew = options.triggerNew !== false;

    for (const turn of turns || []) {
      for (const item of turn.items || []) {
        if (item.kind !== 'think' || !item.thinking) continue;
        if (!enabled) {
          item.translateStatus = 'off';
          item.narrativeStatus = 'off';
          continue;
        }
        const rawTrim = item.thinking.trim();
        const mostlyZh = containsMostlyChinese(rawTrim);

        if (!hasKey && !mostlyZh) {
          item.translateStatus = 'no-key';
          item.narrativeStatus = 'no-key';
          continue;
        }

        // 1) 完整全中文流式翻译（同时供给主窗口「微光思考小长方形」与侧边栏「详尽档案室」）
        if (triggerNew) {
          triggerTranslate(item, settings);
        }
        const st = liveStates.get(item.id);
        if (st) {
          item.translatedThinking = st.translated;
          item.translateStatus = st.status;
          item.translatePhase = st.phase || '';
          item.translateError = st.error;
          item.translateModel = st.model;
        } else if (mostlyZh) {
          item.translatedThinking = rawTrim;
          item.translateStatus = 'done';
          item.translatePhase = '';
          item.translateModel = 'native-zh';
        }

        // 1b) 在「分步脉络」模式下，若用户按需点了「看完整」，补译并附带完整逐句中文
        if ((settings.translateStyle || 'steps') === 'steps' && fullRequestedIds.has(item.id)) {
          if (triggerNew && (hasKey || mostlyZh)) {
            triggerFullDetailTranslate(item, settings);
          }
          const dst = fullDetailStates.get(item.id);
          if (dst) {
            item.fullTranslatedThinking = dst.translated;
            item.fullTranslateStatus = dst.status;
            item.fullTranslateError = dst.error;
            item.fullTranslateModel = dst.model;
          } else if (mostlyZh) {
            item.fullTranslatedThinking = rawTrim;
            item.fullTranslateStatus = 'done';
            item.fullTranslateModel = 'native-zh';
          }
        }

        // 2) 1~2 句精简中文小总结（仅在开启 summaryEnabled 时生成，关闭则 0 额外请求）
        if (summaryEnabled) {
          const isShortSingleZh = mostlyZh && rawTrim.length <= 120 && !/\n\s*\n/.test(rawTrim);
          if (triggerNew && (hasKey || isShortSingleZh)) {
            triggerNarrativeSummary(item, settings);
          } else if (!hasKey && mostlyZh) {
            const oldNst = narrativeStates.get(item.id);
            if (oldNst && (oldNst.sourceLen !== rawTrim.length || oldNst.status === 'error' || !oldNst.text)) {
              narrativeStates.delete(item.id);
            }
            const firstPara = splitParagraphs(rawTrim)[0] || rawTrim;
            item.narrativeSummary = firstPara.length > 140 ? `${firstPara.slice(0, 140)}…` : firstPara;
            item.narrativeStatus = 'done';
            item.narrativeModel = 'native-zh';
          }
          const nst = narrativeStates.get(item.id);
          if (nst) {
            item.narrativeSummary = nst.text;
            item.narrativeStatus = nst.status;
            item.narrativeError = nst.error;
            item.narrativeModel = nst.model;
          }
        } else {
          item.narrativeStatus = 'off';
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
      settings,
      undefined,
      undefined,
      'full',
      22000,
      { bypassCooldown: true }
    );
    return { ok: true, model, sample: result, ttftMs, totalMs };
  }

  function resetErrors() {
    modelCooldownUntil.clear();
    for (const [id, st] of liveStates.entries()) {
      if (st.status === 'error' || st.status === 'no-key') {
        const fk = fullTrackKey(id);
        itemEpochs.set(fk, getItemEpoch(fk) + 1);
        abortItemControllers(fk);
        liveStates.delete(id);
        segmentMap.delete(id);
        latestItemSnapshots.delete(id);
      }
    }
    for (const [id, st] of distillStates.entries()) {
      if (st.status === 'error' || st.status === 'no-key') {
        const dsk = distillTrackKey(id);
        itemEpochs.set(dsk, getItemEpoch(dsk) + 1);
        abortItemControllers(dsk);
        distillStates.delete(id);
      }
    }
    for (const [id, st] of fullDetailStates.entries()) {
      if (st.status === 'error' || st.status === 'no-key') {
        const dk = detailTrackKey(id);
        itemEpochs.set(dk, getItemEpoch(dk) + 1);
        abortItemControllers(dk);
        fullDetailStates.delete(id);
      }
    }
    for (const [id, st] of narrativeStates.entries()) {
      if (st.status === 'error' || st.status === 'no-key') {
        const nk = narrTrackKey(id);
        itemEpochs.set(nk, getItemEpoch(nk) + 1);
        abortItemControllers(nk);
        narrativeStates.delete(id);
      }
    }
  }

  function resetForConfigChange() {
    globalEpoch += 1;
    abortAllControllers();
    modelCooldownUntil.clear();
    for (const [id, st] of liveStates.entries()) {
      if (st.status !== 'done' || st.inFlight) {
        liveStates.delete(id);
        segmentMap.delete(id);
        latestItemSnapshots.delete(id);
      }
    }
    for (const [id, st] of distillStates.entries()) {
      if (st.status !== 'done' || st.inFlight) {
        distillStates.delete(id);
      }
    }
    for (const [id, st] of fullDetailStates.entries()) {
      if (st.status !== 'done' || st.inFlight) {
        fullDetailStates.delete(id);
      }
    }
    for (const [id, st] of narrativeStates.entries()) {
      if (st.status !== 'done' || st.inFlight) {
        narrativeStates.delete(id);
      }
    }
  }

  function resetForStyleChange() {
    globalEpoch += 1;
    abortAllControllers();
    modelCooldownUntil.clear();
    liveStates.clear();
    distillStates.clear();
    fullDetailStates.clear();
    narrativeStates.clear();
    segmentMap.clear();
    latestItemSnapshots.clear();
    itemEpochs.clear();
  }

  function requestFullTranslation(itemId) {
    if (!itemId) return;
    fullRequestedIds.add(itemId);
    onProgress?.();
  }

  function retryItem(itemId, rawText = '') {
    modelCooldownUntil.clear();
    const style = getSettings().translateStyle || 'steps';
    if (itemId) {
      const fk = fullTrackKey(itemId);
      const dsk = distillTrackKey(itemId);
      const dk = detailTrackKey(itemId);
      const nk = narrTrackKey(itemId);
      itemEpochs.set(fk, getItemEpoch(fk) + 1);
      itemEpochs.set(dsk, getItemEpoch(dsk) + 1);
      itemEpochs.set(dk, getItemEpoch(dk) + 1);
      itemEpochs.set(nk, getItemEpoch(nk) + 1);
      abortItemControllers(fk);
      abortItemControllers(dsk);
      abortItemControllers(dk);
      abortItemControllers(nk);
      liveStates.delete(itemId);
      distillStates.delete(itemId);
      fullDetailStates.delete(itemId);
      narrativeStates.delete(itemId);
      segmentMap.delete(itemId);
      latestItemSnapshots.delete(itemId);
      if (rawText) {
        const trimmed = rawText.trim();
        diskCache.delete(cacheKeyFor(trimmed, style));
        diskCache.delete(cacheKeyFor(trimmed, 'natural'));
        diskCache.delete(narrativeCacheKey(trimmed, style));
        for (const para of splitParagraphs(trimmed)) {
          diskCache.delete(cacheKeyFor(para, style));
          if (style !== 'natural') diskCache.delete(cacheKeyFor(para, 'natural'));
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
    cacheEpoch += 1;
    abortAllControllers();
    diskCache.clear();
    liveStates.clear();
    distillStates.clear();
    fullDetailStates.clear();
    narrativeStates.clear();
    fullRequestedIds.clear();
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
      cacheEpoch,
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
    resetForConfigChange,
    resetForStyleChange,
    requestFullTranslation,
    retryItem,
    clearCache,
    flushCache: flushCacheNow,
    getStats,
  };
}

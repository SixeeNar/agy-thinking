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
 * 过滤掉明显不是纯文本对话/翻译模型的 ID（嵌入、重排、文生图、视觉多模态、语音、视频、审核、微调 LoRA 等）
 */
const NON_TRANSLATION_RE =
  /(embed|bge-|rerank|whisper|tts|speech|audio|voice|flux|stable-diffusion|sdxl|sd3|kolors|dall-e|midjourney|cogvideo|cogview|wan2\.|wanx|sora|veo|imagen|janus|moderation|guard|ocr|realtime|live-|transcribe|music|paint|sketch|upscale|inpaint|clip-|siglip|cosyvoice|fish-speech|sensevoice|funasr|paraformer|sambert|(^|\/)lora\/|^ft:|-vl(\b|-)|vl-|vision|multimodal|omni|qvq|glm-4v|glm-4\.1v|glm-4\.5v|internvl|minicpm-v|pixtral|llava|molmo)/i;

/**
 * 硅基流动长期免费模型白名单（仅限非 Pro/ 通道，具体仍以官网模型广场实时标注为准）
 */
const SILICONFLOW_FREE_RE =
  /^(qwen\/qwen2\.5-7b-instruct|qwen\/qwen3-8b|qwen\/qwen3-4b|qwen\/qwen2-7b-instruct|qwen\/qwen2\.5-3b-instruct|qwen\/qwen2\.5-1\.5b-instruct|thudm\/glm-4-9b-chat|thudm\/glm-4-9b-0414|zai-org\/glm-4-9b-0414|tencent\/hunyuan-mt-7b|internlm\/internlm2_5-7b-chat|01-ai\/yi-1\.5-9b-chat-16k)$/i;

/**
 * 智谱开放平台官方常驻免费 Flash 模型（不含付费版 glm-4-flashx / air / plus）
 */
const ZHIPU_FREE_RE = /^(glm-4\.7-flash|glm-4\.5-flash|glm-4-flash)(-\d{4})?$/i;

export const PROVIDER_NAMES = Object.freeze({
  siliconflow: '硅基流动',
  modelscope: '魔搭',
  zhipu: '智谱',
  hunyuan: '混元',
  deepseek: 'DeepSeek',
  qwen: '百炼',
  openrouter: 'OpenRouter',
  local: '本地',
  custom: '自定义',
});

const PROVIDER_CURATED_IDS = Object.freeze({
  siliconflow: [
    'Qwen/Qwen2.5-7B-Instruct',
    'THUDM/glm-4-9b-chat',
    'Qwen/Qwen3-8B',
    'deepseek-ai/DeepSeek-V3',
    'tencent/Hunyuan-MT-7B',
  ],
  modelscope: [
    'deepseek-ai/DeepSeek-V3',
    'Qwen/Qwen2.5-72B-Instruct',
    'Qwen/Qwen3-32B',
    'Qwen/Qwen3-8B',
  ],
  zhipu: ['glm-4.7-flash', 'glm-4.5-flash', 'glm-4-flash', 'glm-4.5-air'],
  hunyuan: ['hunyuan-lite', 'hunyuan-turbos-latest', 'hunyuan-turbo'],
  deepseek: ['deepseek-chat'],
  qwen: ['qwen-flash', 'qwen-turbo', 'qwen-mt-plus', 'qwen-mt-flash'],
  openrouter: ['deepseek/deepseek-chat', 'google/gemini-2.5-flash-lite', 'qwen/qwen-2.5-7b-instruct', 'anthropic/claude-3.5-haiku'],
  local: ['qwen2.5:7b', 'qwen3:8b', 'gemma3:4b'],
});

const QUALIFIED_MODEL_RE = /^(siliconflow|modelscope|zhipu|hunyuan|deepseek|qwen|openrouter|local|custom)::(.+)$/i;

export function splitModelSpec(rawSpec) {
  const clean = String(rawSpec || '').trim();
  const m = clean.match(QUALIFIED_MODEL_RE);
  if (m) {
    return { provider: m[1].toLowerCase(), modelId: m[2].trim(), qualified: true };
  }
  return { provider: '', modelId: clean, qualified: false };
}

export function detectProviderKey(baseUrl) {
  const clean = String(baseUrl || '').trim();
  if (!clean) return 'custom';
  if (isLocalGatewayUrl(clean)) return 'local';
  const host = getHostnameSafe(clean);
  if (/(^|\.)siliconflow\.(cn|com)$/i.test(host)) return 'siliconflow';
  if (/(^|\.)deepseek\.com$/i.test(host)) return 'deepseek';
  if (/(^|\.)bigmodel\.cn$/i.test(host)) return 'zhipu';
  if (/(^|\.)modelscope\.(cn|ai)$/i.test(host)) return 'modelscope';
  if (/(^|\.)(hunyuan\.cloud\.tencent\.com|tencentmaas\.com)$/i.test(host)) return 'hunyuan';
  if (/(^|\.)dashscope\.aliyuncs\.com$/i.test(host)) return 'qwen';
  if (/(^|\.)openrouter\.ai$/i.test(host)) return 'openrouter';
  return 'custom';
}

function formatUsdRateTag(inPerM, outPerM) {
  const fmt = (v) => {
    if (!Number.isFinite(v) || v <= 0) return '0';
    if (v < 0.01) return v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    if (v < 1) return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    return v.toFixed(2).replace(/\.00$/, '');
  };
  return `$${fmt(inPerM)}/$${fmt(outPerM)}`;
}

/**
 * 三维翻译模型评估规则（基础语义手感与参考单价；免费/收费与 Pro 标签由渠道感知层精确核定）
 */
const MODEL_RATING_RULES = [
  {
    match: /(deepseek-r1|qwq|glm-z1|seed-thinking|reasoner|o1-|o3-|o4-|-thinking)/i,
    overall: 64,
    value: 66,
    natural: 62,
    costTag: '推理型·偏慢',
    costTone: 'slow',
    priceIn: 4,
    priceOut: 16,
    reason: '自带长思考链，首字延迟高，不适合做实时译者',
  },
  {
    match: /(^|\/)(deepseek-chat|deepseek-flash|deepseek-v3(\.\d+)?)$/i,
    overall: 96,
    value: 88,
    natural: 99,
    costTag: '收费 · ¥2/¥8',
    costTone: 'cheap',
    priceIn: 2,
    priceOut: 8,
    cacheIn: 0.04,
    reason: '外译中母语级自然、几乎零机翻味，按量计费',
  },
  {
    match: /(^|\/)(glm-4\.7-flash|glm-4\.5-flash|glm-4-flash)(-\d{4})?$/i,
    overall: 96,
    value: 92,
    natural: 91,
    costTag: '收费 · 低价',
    costTone: 'cheap',
    priceIn: 0.5,
    priceOut: 0.5,
    reason: '轻量高速 GLM Flash，中文表达顺滑自然',
  },
  {
    match: /(^|\/)(glm-4-9b-chat|glm-4-9b-0414)$/i,
    overall: 94,
    value: 90,
    natural: 91,
    costTag: '收费 · 低价',
    costTone: 'cheap',
    priceIn: 0.5,
    priceOut: 0.5,
    reason: '经典 9B 开源对话模型，口语流畅稳定、低延迟',
  },
  {
    match: /(^|\/)(qwen3\.5-flash|qwen-flash)$/i,
    overall: 95,
    value: 94,
    natural: 93,
    costTag: '收费 · ¥0.15起',
    costTone: 'cheap',
    priceIn: 0.15,
    priceOut: 1.5,
    reason: '超低价通用快模，技术语感佳、首字极快（非永久免费）',
  },
  {
    match: /(^|\/)(qwen-?2\.5[-:]7b(-instruct)?|qwen3[-:]8b|qwen3[-:]4b)/i,
    overall: 94,
    value: 91,
    natural: 93,
    costTag: '收费 · 极低价',
    costTone: 'cheap',
    priceIn: 0.35,
    priceOut: 0.7,
    reason: '中文技术语感自然、代码标识符零误翻，首字响应快',
  },
  {
    match: /(^|\/)qwen-turbo/i,
    overall: 93,
    value: 92,
    natural: 91,
    costTag: '收费 · ¥0.3起',
    costTone: 'cheap',
    priceIn: 0.3,
    priceOut: 0.6,
    reason: '经济高速通用模型，延迟低、技术表达干净利落',
  },
  {
    match: /(^|\/)qwen-mt-plus/i,
    overall: 92,
    value: 84,
    natural: 96,
    costTag: '收费 · ¥1.8/M',
    costTone: 'cheap',
    priceIn: 1.8,
    priceOut: 5.4,
    reason: '高质量专职翻译模型，复杂语境与专业术语极准',
  },
  {
    match: /(^|\/)deepseek-v3/i,
    overall: 94,
    value: 86,
    natural: 97,
    costTag: '收费 · ¥2/¥8',
    costTone: 'cheap',
    priceIn: 2,
    priceOut: 8,
    reason: 'DeepSeek V3 衍生版，中文自然顺口、极少翻译腔',
  },
  {
    match: /(^|\/)(claude-haiku|claude-3-5-haiku|claude-3\.5-haiku|claude-haiku-4)/i,
    overall: 88,
    value: 74,
    natural: 97,
    costTag: '收费 · 中等',
    costTone: 'mid',
    priceIn: 5.8,
    priceOut: 29,
    reason: '中文表达极自然有网感，但单价偏高',
  },
  {
    match: /(^|\/)(gemini-2\.5-flash-lite|gemini-2\.5-flash$|gemini-2\.0-flash)/i,
    overall: 91,
    value: 92,
    natural: 88,
    costTag: '收费 · 极低价',
    costTone: 'cheap',
    priceIn: 0.7,
    priceOut: 2.8,
    reason: '吞吐极快、单价极薄，长思考流也不易卡顿',
  },
  {
    match: /(^|\/)(qwen2\.5-72b|qwen3-32b)/i,
    overall: 93,
    value: 82,
    natural: 96,
    costTag: '收费 · 中等',
    costTone: 'cheap',
    priceIn: 2.0,
    priceOut: 6.0,
    reason: '大参数开源通义主力，复杂技术逻辑与长难句极稳',
  },
  {
    match: /(^|\/)(qwen2\.5-14b|qwen2\.5-32b|qwen3-14b|qwen3-30b-a3b|qwen-plus)/i,
    overall: 90,
    value: 84,
    natural: 94,
    costTag: '收费 · 适中',
    costTone: 'cheap',
    priceIn: 0.8,
    priceOut: 2.4,
    reason: '中大参数通义，长难句拆解稳、行文自然不生硬',
  },
  {
    match: /(^|\/)hunyuan-lite$/i,
    overall: 93,
    value: 96,
    natural: 87,
    costTag: '收费 · 轻量',
    costTone: 'cheap',
    priceIn: 0,
    priceOut: 0,
    reason: '轻量高速腾讯混元，中文顺滑自然、延迟低',
  },
  {
    match: /(^|\/)(hunyuan-turbos|hunyuan-turbo)/i,
    overall: 92,
    value: 90,
    natural: 93,
    costTag: '收费 · 低价',
    costTone: 'cheap',
    priceIn: 0.8,
    priceOut: 2.0,
    reason: '腾讯混元高速主力，中文地道流畅、并发余量足',
  },
  {
    match: /(^|\/)(qwen-mt-flash|qwen-mt-turbo|qwen-mt-lite)/i,
    overall: 87,
    value: 88,
    natural: 84,
    costTag: '收费 · ¥0.7/M',
    costTone: 'cheap',
    priceIn: 0.7,
    priceOut: 2.1,
    reason: '专职快译便宜高速，风格略工整偏直白',
  },
  {
    match: /(^|\/)(hunyuan-mt|hy-mt)/i,
    overall: 85,
    value: 90,
    natural: 78,
    costTag: '收费 · 轻量',
    costTone: 'cheap',
    priceIn: 0.5,
    priceOut: 1.0,
    reason: '专职多语快译、速度极快，但略带书面翻译腔',
  },
  {
    match: /(^|\/)(glm-4\.5-air|glm-4-air|glm-4-flashx|glm-4\.6|glm-4\.5$)/i,
    overall: 87,
    value: 84,
    natural: 90,
    costTag: '收费 · 轻量',
    costTone: 'cheap',
    priceIn: 0.8,
    priceOut: 2.0,
    reason: '智谱付费轻量/主力档，中文语感自然、并发限制较宽',
  },
  {
    match: /(^|\/)(gpt-4\.1-mini|gpt-4\.1-nano|gpt-4o-mini)/i,
    overall: 85,
    value: 84,
    natural: 85,
    costTag: '收费 · 低价',
    costTone: 'cheap',
    priceIn: 1.1,
    priceOut: 4.4,
    reason: '语法严谨、代码格式稳定，中文略保守直白',
  },
  {
    match: /(^|\/)(doubao.*lite|doubao.*mini|minimax|kimi|moonshot|internlm|yi-|step-1-flash|ernie-speed|ernie-lite|gemma)/i,
    overall: 84,
    value: 86,
    natural: 84,
    costTag: '收费 · 轻量',
    costTone: 'cheap',
    priceIn: 0.6,
    priceOut: 1.8,
    reason: '轻量中文友好模型，适合日常流式翻译',
  },
  {
    match: /(^|\/)(qwen2-7b|qwen1\.5-7b|qwen2\.5-3b|qwen2\.5-1\.5b)/i,
    overall: 80,
    value: 88,
    natural: 75,
    costTag: '收费 · 极轻',
    costTone: 'cheap',
    priceIn: 0.2,
    priceOut: 0.4,
    reason: '轻量小参数模型，速度快但偶有语句略平淡',
  },
  {
    match: /(gpt-4o$|gpt-4\.1$|gpt-5|claude-sonnet|claude-opus|claude-3-7|qwen-max|qwen3-235b|glm-4-plus|gemini-2\.5-pro|deepseek-v4-pro)/i,
    overall: 78,
    value: 56,
    natural: 96,
    costTag: '收费 · 旗舰贵',
    costTone: 'mid',
    priceIn: 10,
    priceOut: 30,
    reason: '译文自然度顶级，但用于实时翻思考流成本偏高',
  },
];

function gradeFromScore(score) {
  if (score >= 95) return 'S+';
  if (score >= 90) return 'S';
  if (score >= 84) return 'A+';
  if (score >= 76) return 'A';
  return 'B';
}

export function evaluateModelForTranslation(modelId, baseUrl = '', rawItem = null) {
  const id = String(modelId || '').trim();
  const provider = detectProviderKey(baseUrl);
  const isLocal = provider === 'local';
  const isSiliconPro = provider === 'siliconflow' && /^Pro\//i.test(id);
  const matchId = isSiliconPro ? id.replace(/^Pro\//i, '') : id;

  let base = null;
  for (const rule of MODEL_RATING_RULES) {
    if (rule.match.test(matchId)) {
      base = { ...rule };
      break;
    }
  }
  if (!base) {
    const lower = matchId.toLowerCase();
    if (/(flash|lite|mini|nano|turbo|7b|8b|9b)/i.test(lower)) {
      base = {
        overall: 80,
        value: 84,
        natural: 78,
        costTag: provider === 'custom' ? '轻量快模' : '收费 · 轻量',
        costTone: 'cheap',
        priceIn: 0.5,
        priceOut: 1.5,
        reason: '轻量快速模型，适合实时流式翻译实测',
      };
    } else {
      base = {
        overall: 72,
        value: 70,
        natural: 74,
        costTag: provider === 'custom' ? '按网关计费' : '收费 · 通用',
        costTone: 'neutral',
        priceIn: 2,
        priceOut: 6,
        reason: '平台可用对话模型，可勾选实测翻译手感',
      };
    }
  }

  let { overall, value, natural, costTag, costTone, reason } = base;
  let priceIn = Number(base.priceIn || 0);
  let priceOut = Number(base.priceOut || 0);
  let cacheIn = Number(base.cacheIn || 0);
  let currency = provider === 'openrouter' ? 'USD' : 'CNY';
  let isFree = false;

  if (isLocal) {
    isFree = true;
    priceIn = 0;
    priceOut = 0;
    cacheIn = 0;
    currency = 'CNY';
    value = 100;
    overall = Math.min(99, Math.round(natural * 0.65 + value * 0.35));
    costTag = '本机免费';
    costTone = 'free';
  } else if (provider === 'openrouter') {
    currency = 'USD';
    const rawPrompt = rawItem?.pricing?.prompt;
    const rawComp = rawItem?.pricing?.completion;
    const promptNum = (rawPrompt !== undefined && rawPrompt !== null && String(rawPrompt).trim() !== '') ? Number(rawPrompt) : NaN;
    const compNum = (rawComp !== undefined && rawComp !== null && String(rawComp).trim() !== '') ? Number(rawComp) : NaN;
    const hasLivePricing = Number.isFinite(promptNum) && Number.isFinite(compNum) && promptNum >= 0 && compNum >= 0;
    const pIn = hasLivePricing ? promptNum * 1e6 : (priceIn / 7.2);
    const pOut = hasLivePricing ? compNum * 1e6 : (priceOut / 7.2);
    const liveFree = /:free$/i.test(id) || (hasLivePricing && pIn === 0 && pOut === 0);
    if (liveFree) {
      isFree = true;
      priceIn = 0;
      priceOut = 0;
      cacheIn = 0;
      value = 98;
      overall = Math.min(97, Math.round(natural * 0.62 + value * 0.38));
      costTag = '平台免费';
      costTone = 'free';
      reason = `${reason}（OpenRouter 免费通道，有限速）`;
    } else {
      isFree = false;
      priceIn = Number.isFinite(pIn) && pIn > 0 ? pIn : 0.3;
      priceOut = Number.isFinite(pOut) && pOut > 0 ? pOut : 0.9;
      cacheIn = 0;
      if (hasLivePricing) {
        costTag = `收费 · ${formatUsdRateTag(priceIn, priceOut)}`;
        if (priceOut <= 1.2) {
          costTone = costTone === 'slow' ? 'slow' : 'cheap';
          value = Math.max(value, 90);
        } else if (priceOut <= 5) {
          costTone = costTone === 'slow' ? 'slow' : 'cheap';
        } else {
          costTone = costTone === 'slow' ? 'slow' : 'mid';
          value = Math.min(value, 72);
        }
        overall = Math.min(98, Math.round(natural * 0.62 + value * 0.38));
      } else if (costTone === 'free' || /¥/.test(costTag)) {
        costTone = costTone === 'slow' ? 'slow' : 'cheap';
        costTag = '收费 · 低价';
      }
    }
  } else if (provider === 'siliconflow') {
    if (isSiliconPro) {
      isFree = false;
      costTag = 'Pro · 需充值';
      costTone = costTone === 'slow' ? 'slow' : 'mid';
      value = Math.max(52, value - 12);
      overall = Math.max(60, Math.round(natural * 0.56 + value * 0.44));
      reason = '需真实充值余额（不可用赠送金/免费额度），高并发独享通道';
    } else if (SILICONFLOW_FREE_RE.test(id)) {
      isFree = true;
      priceIn = 0;
      priceOut = 0;
      cacheIn = 0;
      value = 99;
      overall = Math.min(97, Math.round(natural * 0.58 + value * 0.42));
      costTag = '平台免费';
      costTone = 'free';
      reason = `${reason}（硅基流动非 Pro 免费档，有限速）`;
    } else if (/(^|\/)deepseek-v3(\.\d+)?$/i.test(id)) {
      isFree = false;
      priceIn = 2;
      priceOut = 8;
      cacheIn = 0;
      value = 88;
      overall = 95;
      costTag = '收费 · ¥2/¥8';
      costTone = 'cheap';
      reason = '外译中母语级自然，可用充值余额或赠送金，按量计费';
    }
  } else if (provider === 'zhipu') {
    if (ZHIPU_FREE_RE.test(id)) {
      isFree = true;
      priceIn = 0;
      priceOut = 0;
      cacheIn = 0;
      value = 100;
      overall = Math.min(97, Math.round(natural * 0.58 + value * 0.42));
      costTag = '官方免费';
      costTone = 'free';
      reason = '官方输入输出全免费，插件自动单并发防 429 限流';
    }
  } else if (provider === 'modelscope') {
    isFree = true;
    priceIn = 0;
    priceOut = 0;
    cacheIn = 0;
    currency = 'CNY';
    if (costTone !== 'slow') {
      value = 98;
      overall = Math.min(98, Math.round(natural * 0.62 + value * 0.38));
      costTag = '每日免费额度';
      costTone = 'free';
      reason = `${reason}（魔搭每日免费 API 推理额度，实名绑定阿里云可用）`;
    } else {
      costTag = '推理型 · 免费额度';
    }
  } else if (provider === 'hunyuan') {
    if (/^hunyuan-lite$/i.test(id)) {
      isFree = true;
      priceIn = 0;
      priceOut = 0;
      cacheIn = 0;
      value = 100;
      overall = 93;
      costTag = '官方免费';
      costTone = 'free';
      reason = '腾讯混元官方免费轻量档，中文顺畅、自动低并发防限流';
    } else if (/^hunyuan-turbos/i.test(id)) {
      isFree = false;
      priceIn = 0.8;
      priceOut = 2.0;
      costTag = '收费 · ¥0.8/¥2';
      costTone = 'cheap';
    } else if (/^hunyuan-turbo/i.test(id)) {
      isFree = false;
      priceIn = 0.8;
      priceOut = 2.0;
      costTag = '收费 · 低价';
      costTone = 'cheap';
    }
  } else if (provider === 'deepseek') {
    if (/^(deepseek-chat|deepseek-flash)$/i.test(id)) {
      isFree = false;
      priceIn = 2;
      priceOut = 8;
      cacheIn = 0.04;
      value = 94;
      overall = 98;
      costTag = '收费 · 缓存省';
      costTone = 'cheap';
      reason = '官方直连母语级自然，支持自动前缀缓存与空闲时段 5 折';
    }
  } else if (provider === 'qwen') {
    if (/^(qwen-flash|qwen3\.5-flash)$/i.test(id)) {
      isFree = false;
      priceIn = 0.15;
      priceOut = 1.5;
      costTag = '收费 · ¥0.15起';
      costTone = 'cheap';
      reason = '百炼白菜价通用快模，新户常含限时体验额度，用完按量计费';
    }
  } else {
    // 自定义第三方网关：除明确带 :free 后缀外绝不虚标免费
    if (/:free$/i.test(id)) {
      isFree = true;
      priceIn = 0;
      priceOut = 0;
      costTag = '标注免费';
      costTone = 'free';
    } else if (costTone === 'free') {
      costTone = 'neutral';
      costTag = '按网关计费';
    }
  }

  return {
    id,
    overall,
    value,
    natural,
    score: overall,
    grade: gradeFromScore(overall),
    costTag,
    costTone,
    isFree,
    isPro: isSiliconPro,
    priceIn,
    priceOut,
    cacheIn,
    currency,
    reason,
    recommended: overall >= 84 && !isSiliconPro,
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

function getUsagePath() {
  return join(homedir(), '.gemini', 'config', 'agy-thinking', 'usage-stats.json');
}

function estimateTokenCount(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const rest = Math.max(0, s.length - cjk);
  return Math.max(1, Math.round(cjk * 1.45 + rest / 3.6));
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

function getHostnameSafe(baseUrl) {
  try {
    return new URL(String(baseUrl || '').trim()).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isLocalGatewayUrl(baseUrl) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(String(baseUrl || '').trim());
}

function isSiliconFlowUrl(baseUrl) {
  return /(^|\.)siliconflow\.(cn|com)$/i.test(getHostnameSafe(baseUrl));
}

function isZhipuUrl(baseUrl) {
  return /(^|\.)bigmodel\.cn$/i.test(getHostnameSafe(baseUrl));
}

function normalizeBaseUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|completions|models)$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function isHunyuanMtModel(model) {
  const { modelId } = splitModelSpec(model);
  return /(^|\/)(hunyuan-mt|hy-mt)/i.test(modelId);
}

function isQwenMtModel(model) {
  const { modelId } = splitModelSpec(model);
  return /(^|\/)qwen-mt/i.test(modelId);
}

function supportsEnableThinkingFlag(baseUrl, model) {
  const m = String(model || '').toLowerCase();
  if (isHunyuanMtModel(m) || isQwenMtModel(m)) return false;
  const host = getHostnameSafe(baseUrl);
  if (isSiliconFlowUrl(baseUrl) || /(^|\.)(dashscope\.aliyuncs\.com|modelscope\.(cn|ai))$/i.test(host)) {
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
  if (!isFinal && out.length < '</think>'.length) {
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
  includeUsage = true,
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
    const body = {
      model,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: promptMode === 'full' ? 0.25 : 0.2,
      stream: true,
    };
    if (includeUsage) body.stream_options = { include_usage: true };
    return body;
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
    if (includeUsage) body.stream_options = { include_usage: true };
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
  if (includeUsage) body.stream_options = { include_usage: true };

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
  includeUsage = true,
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
    includeUsage,
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
  let sawDelta = false;
  let usageInfo = null;

  const extractUsage = (parsed) => {
    const u = parsed?.usage;
    if (!u || typeof u !== 'object') return;
    const promptTokens = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
    const completionTokens = Number(u.completion_tokens ?? u.output_tokens ?? 0);
    const cachedTokens = Number(
      u.prompt_cache_hit_tokens ??
      u.prompt_tokens_details?.cached_tokens ??
      u.cached_tokens ??
      0
    );
    if (promptTokens > 0 || completionTokens > 0) {
      usageInfo = {
        promptTokens: Math.max(0, promptTokens),
        completionTokens: Math.max(0, completionTokens),
        cachedTokens: Math.max(0, Math.min(promptTokens, cachedTokens)),
        estimated: false,
      };
    }
  };

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
      extractUsage(parsed);
      const deltaContent = parsed?.choices?.[0]?.delta?.content;
      const msgContent = parsed?.choices?.[0]?.message?.content;
      let updated = false;
      if (typeof deltaContent === 'string' && deltaContent) {
        sawDelta = true;
        rawFull += deltaContent;
        updated = true;
      } else if (!sawDelta && typeof msgContent === 'string' && msgContent) {
        // 仅在尚未收到增量 delta 时接受完整 message.content，防止部分中转网关在尾包同时附带 message.content 导致译文翻倍重复
        rawFull = msgContent;
        updated = true;
      }
      if (updated) {
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
      extractUsage(parsed);
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
  if (!usageInfo) {
    const sysText = Array.isArray(body.messages) ? body.messages.map((m) => m.content || '').join('\n') : String(text || '');
    usageInfo = {
      promptTokens: estimateTokenCount(sysText),
      completionTokens: estimateTokenCount(rawFull || finalClean),
      cachedTokens: 0,
      estimated: true,
    };
  }
  return { text: finalClean, ttftMs: ttftMs ?? totalMs, totalMs, usage: usageInfo };
}

export function createTranslator(getSettings, onProgress) {
  const cachePath = getCachePath();
  const usagePath = getUsagePath();
  const diskCache = new Map();
  const livePricingMap = new Map(); // `${provider}:${modelId}` -> { priceIn, priceOut, cacheIn, currency, isFree }
  const liveStates = new Map();
  const distillStates = new Map(); // itemId -> 长思考结束后的整篇去重提炼状态（合并成 3~6 步）
  const fullDetailStates = new Map(); // itemId -> 按需点击「看完整」时生成的全量自然译文状态
  const narrativeStates = new Map(); // itemId -> { sourceHash, sourceLen, text, status, error, model, lastReqAt, inFlight, seq, controller }
  const fullRequestedIds = new Set(); // 在「分步脉络」模式下用户按需点开「看完整」的 itemId
  const modelCooldownUntil = new Map();
  const rateLimitHits = new Map(); // model -> consecutive 429 count
  const segmentMap = new Map();
  const latestItemSnapshots = new Map(); // itemId -> { rawText, fullKey, style, isGenerating, paragraphs }
  const itemEpochs = new Map(); // itemId -> number
  const itemControllers = new Map(); // itemId -> Set<AbortController>
  let globalEpoch = 0;
  let cacheEpoch = 0;
  let lastActiveModel = '';

  const emptyUsageBucket = () => ({
    requests: 0,
    freeRequests: 0,
    cacheHits: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costCny: 0,
    costUsd: 0,
    hasEstimated: false,
    updatedAt: 0,
  });
  const sessionUsage = emptyUsageBucket();
  let totalUsage = emptyUsageBucket();
  let byModelUsage = {};

  try {
    const rawUsage = JSON.parse(readFileSync(usagePath, 'utf-8'));
    if (rawUsage && typeof rawUsage === 'object') {
      if (rawUsage.total && typeof rawUsage.total === 'object') {
        totalUsage = { ...emptyUsageBucket(), ...rawUsage.total };
      }
      if (rawUsage.byModel && typeof rawUsage.byModel === 'object') {
        byModelUsage = rawUsage.byModel;
      }
    }
  } catch {}

  let usageSaveTimer = null;
  let usageDirty = false;
  const flushUsageNow = () => {
    clearTimeout(usageSaveTimer);
    usageSaveTimer = null;
    if (!usageDirty) return;
    usageDirty = false;
    const tmp = `${usagePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      mkdirSync(dirname(usagePath), { recursive: true });
      const serialized = JSON.stringify({ total: totalUsage, byModel: byModelUsage }, null, 2);
      try {
        writeFileSync(tmp, serialized, 'utf-8');
        renameSync(tmp, usagePath);
      } catch {
        try { unlinkSync(tmp); } catch {}
        writeFileSync(usagePath, serialized, 'utf-8');
      }
    } catch {
      try { unlinkSync(tmp); } catch {}
    }
  };
  const scheduleUsageSave = () => {
    usageDirty = true;
    if (usageSaveTimer) return;
    usageSaveTimer = setTimeout(flushUsageNow, 1800);
  };

  const recordUsage = (baseUrl, model, usage) => {
    if (!usage) return;
    const provider = detectProviderKey(baseUrl);
    const livePrice = livePricingMap.get(`${provider}:${model}`);
    const evalInfo = livePrice || evaluateModelForTranslation(model, baseUrl);
    const inTok = Math.max(0, Number(usage.promptTokens || 0));
    const outTok = Math.max(0, Number(usage.completionTokens || 0));
    const cachedTok = Math.max(0, Math.min(inTok, Number(usage.cachedTokens || 0)));
    const uncachedIn = Math.max(0, inTok - cachedTok);
    const isFree = Boolean(evalInfo.isFree);
    const pIn = isFree ? 0 : Number(evalInfo.priceIn || 0);
    const pOut = isFree ? 0 : Number(evalInfo.priceOut || 0);
    const pCache = isFree ? 0 : (Number(evalInfo.cacheIn || 0) || pIn * 0.2);
    const cost = isFree ? 0 : ((uncachedIn * pIn + cachedTok * pCache + outTok * pOut) / 1e6);
    const isUsd = evalInfo.currency === 'USD';
    const now = Date.now();

    for (const bucket of [sessionUsage, totalUsage]) {
      bucket.requests += 1;
      if (isFree) bucket.freeRequests += 1;
      bucket.inputTokens += inTok;
      bucket.outputTokens += outTok;
      bucket.cachedInputTokens += cachedTok;
      if (isUsd) bucket.costUsd += cost;
      else bucket.costCny += cost;
      if (usage.estimated) bucket.hasEstimated = true;
      bucket.updatedAt = now;
    }

    const mKey = `${provider}:${model}`;
    const prevM = byModelUsage[mKey] || {
      provider,
      model,
      isFree,
      currency: isUsd ? 'USD' : 'CNY',
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };
    prevM.requests += 1;
    prevM.inputTokens += inTok;
    prevM.outputTokens += outTok;
    prevM.cost += cost;
    prevM.isFree = isFree;
    byModelUsage[mKey] = prevM;
    scheduleUsageSave();
  };

  const recordCacheHit = () => {
    sessionUsage.cacheHits += 1;
    totalUsage.cacheHits += 1;
    totalUsage.updatedAt = Date.now();
    scheduleUsageSave();
  };

  const getUsageSummary = () => ({
    session: { ...sessionUsage },
    total: { ...totalUsage },
    byModel: Object.values(byModelUsage)
      .sort((a, b) => (b.cost - a.cost) || (b.requests - a.requests))
      .slice(0, 8),
  });

  const resetUsageStats = () => {
    Object.assign(sessionUsage, emptyUsageBucket());
    totalUsage = emptyUsageBucket();
    byModelUsage = {};
    usageDirty = true;
    flushUsageNow();
    onProgress?.();
  };

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
  function resolveModelCandidate(rawSpec, settings) {
    const { provider: explicitProv, modelId } = splitModelSpec(rawSpec);
    if (!modelId) return null;
    const profiles = settings?.providerProfiles || {};
    const legacyUrl = String(settings?.translateBaseUrl || '').trim();
    const legacyKey = String(settings?.translateApiKey || '').trim();
    const legacyProv = detectProviderKey(legacyUrl);

    if (explicitProv) {
      const prof = profiles[explicitProv];
      const baseUrl = (prof?.baseUrl || (explicitProv === legacyProv ? legacyUrl : '') || '').trim();
      const apiKey = (prof?.apiKey || (explicitProv === legacyProv ? legacyKey : '') || '').trim();
      return {
        rawSpec,
        provider: explicitProv,
        providerName: PROVIDER_NAMES[explicitProv] || explicitProv,
        modelId,
        baseUrl,
        apiKey,
        cooldownKey: `${explicitProv}::${modelId}`,
      };
    }

    const prof = profiles[legacyProv];
    const baseUrl = (legacyUrl || prof?.baseUrl || '').trim();
    const apiKey = (legacyKey || prof?.apiKey || '').trim();
    return {
      rawSpec,
      provider: legacyProv,
      providerName: PROVIDER_NAMES[legacyProv] || legacyProv,
      modelId,
      baseUrl,
      apiKey,
      cooldownKey: `${legacyProv}::${modelId}`,
    };
  }

  function hasAnyConfiguredProvider(settings) {
    if (settings?.translateApiKey) return true;
    const profiles = settings?.providerProfiles;
    if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) {
      for (const [k, v] of Object.entries(profiles)) {
        if (!v || !v.baseUrl || v.enabled === false) continue;
        if (k === 'local' || v.apiKey) return true;
      }
      return false;
    }
    return isLocalGatewayUrl(settings?.translateBaseUrl);
  }

  const getMaxConcurrency = () => {
    try {
      const s = getSettings();
      const specs = parseModels(s?.translateModels);
      const now = Date.now();
      let activeCand = null;
      let firstCand = null;
      for (const spec of specs) {
        const c = resolveModelCandidate(spec, s);
        if (!c || !c.baseUrl || (!c.apiKey && !isLocalGatewayUrl(c.baseUrl))) continue;
        if (!firstCand) firstCand = c;
        if ((modelCooldownUntil.get(c.cooldownKey) || 0) <= now) {
          activeCand = c;
          break;
        }
      }
      const cand = activeCand || firstCand;
      const provider = cand?.provider || detectProviderKey(s?.translateBaseUrl);
      // 智谱免费 Flash 系列官方并发限制极严（常为 1 并发），自动降为单并发防止 429 限流雪崩
      if (provider === 'zhipu') return 1;
      // 魔搭每日免费推理与腾讯混元免费档降为 2 并发，兼顾速度与防 429
      if (provider === 'modelscope' || provider === 'hunyuan') return 2;
    } catch {}
    return MAX_CONCURRENCY;
  };
  const enqueueJob = (fn) => {
    const runNext = () => {
      while (runningJobs < getMaxConcurrency() && pendingJobs.length > 0) {
        const next = pendingJobs.shift();
        runningJobs += 1;
        void Promise.resolve()
          .then(next)
          .finally(() => {
            runningJobs -= 1;
            runNext();
          });
      }
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
    const rawSpecs = parseModels(settings.translateModels);
    if (rawSpecs.length === 0) throw new Error('未配置翻译模型名称');

    const resolvedAll = rawSpecs
      .map((spec) => resolveModelCandidate(spec, settings))
      .filter((c) => c && c.baseUrl && (c.apiKey || isLocalGatewayUrl(c.baseUrl)));
    if (resolvedAll.length === 0) {
      throw new Error('所选翻译模型对应的平台尚未配置 API Key');
    }

    const orderedCandidates = (promptMode === 'distill' || promptMode === 'narrative')
      ? [
          ...resolvedAll.filter((c) => !isQwenMtModel(c.modelId) && !isHunyuanMtModel(c.modelId)),
          ...resolvedAll.filter((c) => isHunyuanMtModel(c.modelId)),
          ...resolvedAll.filter((c) => isQwenMtModel(c.modelId)),
        ]
      : resolvedAll;

    const now = Date.now();
    const activeCandidates = orderedCandidates.filter((c) => (modelCooldownUntil.get(c.cooldownKey) || 0) <= now);
    if (activeCandidates.length === 0 && !options.bypassCooldown) {
      const earliestReady = Math.min(...orderedCandidates.map((c) => modelCooldownUntil.get(c.cooldownKey) || now));
      const waitSec = Math.max(1, Math.ceil((earliestReady - now) / 1000));
      const err = new Error(`翻译模型冷却中（约 ${waitSec}s 后恢复，或点「重试失败」立即重试）`);
      err.retryAfterAt = earliestReady;
      throw err;
    }
    const candidates = activeCandidates.length > 0 ? activeCandidates : orderedCandidates;

    let lastErr = null;
    let sawTransientErr = false;
    let earliestTransientRetryAt = Infinity;
    for (const cand of candidates) {
      if (externalSignal?.aborted) {
        const abortErr = new Error('翻译已取消');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      const runOnce = async (disableThink, includeUsage = true) => {
        const timeoutSig = AbortSignal.timeout(timeoutMs);
        const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSig]) : timeoutSig;
        return streamChatCompletion({
          baseUrl: cand.baseUrl,
          apiKey: cand.apiKey,
          model: cand.modelId,
          text,
          disableTranslatorThinking: disableThink,
          translateStyle: settings.translateStyle || 'natural',
          promptMode,
          includeUsage,
          onChunk,
          signal,
        });
      };

      try {
        let res;
        let wantDisableThink = settings.disableTranslatorThinking !== false;
        let wantUsage = true;
        try {
          res = await runOnce(wantDisableThink, wantUsage);
        } catch (err) {
          // 兼容部分网关不支持 reasoning_effort / enable_thinking / thinking / stream_options 返回 400/422：自动剥离重试一次
          const errStr = err?.responseText || err?.message || '';
          const isBadParam = (err?.status === 400 || err?.status === 422) && !externalSignal?.aborted;
          const genericBadParam = isBadParam && /(unknown|unrecognized|unsupported|extra_forbidden|不支持|无效参数|未知参数|非法参数)/i.test(errStr);
          const badUsage = isBadParam && wantUsage && (/(stream_options|include_usage)/i.test(errStr) || genericBadParam);
          const badThink = isBadParam && wantDisableThink && (/(reasoning_effort|enable_thinking|thinking)/i.test(errStr) || genericBadParam);
          if (badUsage || badThink) {
            if (badUsage) wantUsage = false;
            if (badThink) wantDisableThink = false;
            res = await runOnce(wantDisableThink, wantUsage);
          } else {
            throw err;
          }
        }
        if (res.text) {
          modelCooldownUntil.delete(cand.cooldownKey);
          rateLimitHits.delete(cand.cooldownKey);
          lastActiveModel = `${cand.providerName}/${cand.modelId}`;
          recordUsage(cand.baseUrl, cand.modelId, res.usage);
          return { result: res.text, model: cand.modelId, provider: cand.provider, providerName: cand.providerName, ttftMs: res.ttftMs, totalMs: res.totalMs, usage: res.usage };
        }
        // 即使返回空译文，网关可能已计费，照实记录用量并短暂冷却，避免 350ms 高频死打坏模型
        if (res.usage) recordUsage(cand.baseUrl, cand.modelId, res.usage);
        const emptyCooldownUntil = Date.now() + 30000;
        modelCooldownUntil.set(cand.cooldownKey, emptyCooldownUntil);
        sawTransientErr = true;
        earliestTransientRetryAt = Math.min(earliestTransientRetryAt, emptyCooldownUntil);
        lastErr = new Error(`模型 ${cand.providerName}/${cand.modelId} 返回空译文`);
      } catch (err) {
        if (externalSignal?.aborted) throw err;
        lastErr = err;
        if (err.status === 429) {
          const hits = (rateLimitHits.get(cand.cooldownKey) || 0) + 1;
          rateLimitHits.set(cand.cooldownKey, hits);
          const cooldownMs = Math.min(90000, hits === 1 ? 15000 : hits === 2 ? 30000 : 60000);
          const until = Date.now() + cooldownMs;
          modelCooldownUntil.set(cand.cooldownKey, until);
          sawTransientErr = true;
          earliestTransientRetryAt = Math.min(earliestTransientRetryAt, until);
          continue;
        }
        if ([400, 401, 402, 403, 404, 422].includes(err.status)) {
          modelCooldownUntil.set(cand.cooldownKey, Date.now() + 5 * 60 * 1000);
          continue;
        }
        if ([500, 502, 503, 504].includes(err.status) || err?.name === 'TimeoutError' || err?.name === 'AbortError' || !err.status) {
          const until = Date.now() + 60 * 1000;
          modelCooldownUntil.set(cand.cooldownKey, until);
          sawTransientErr = true;
          earliestTransientRetryAt = Math.min(earliestTransientRetryAt, until);
          continue;
        }
        throw err;
      }
    }
    // 队列中若既有临时故障（如 429/超时）又有永久错（如备选 403），切勿把最后一个 403 判成全队列永久失败导致锁死重试
    if (sawTransientErr && isPermanentError(lastErr)) {
      const wrapped = new Error(lastErr?.message || '部分备选模型暂不可用，稍后自动重试');
      if (Number.isFinite(earliestTransientRetryAt)) wrapped.retryAfterAt = earliestTransientRetryAt;
      throw wrapped;
    }
    if (sawTransientErr && lastErr && Number.isFinite(earliestTransientRetryAt) && !lastErr.retryAfterAt) {
      lastErr.retryAfterAt = earliestTransientRetryAt;
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
      if (st?.status === 'translating' || (!st && fallbackSlot?.inFlight)) anyTranslating = true;
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
        // 若 distill 队列降级命中了专用直译模型 qwen-mt（忽略分步指令），落盘到 natural 键避免永久污染 steps 缓存
        putDiskCache(isQwenMtModel(model) ? cacheKeyFor(rawText, 'natural') : fullKey, result);
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
        // 若已有完整可用的自然直译兜底，不再每隔 20s 后台偷偷重新触发 distilling 导致卡片闪烁，保留用户点「重译」手动重提炼
        if (fallbackComplete) {
          state.permanentError = true;
          state.nextRetryAt = Infinity;
        }
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
    const style = settings.translateStyle || 'natural';
    const fullKey = cacheKeyFor(rawText, style);

    const stopPendingItemTranslate = () => {
      const fKey = fullTrackKey(item.id);
      const dsKey = distillTrackKey(item.id);
      itemEpochs.set(fKey, getItemEpoch(fKey) + 1);
      itemEpochs.set(dsKey, getItemEpoch(dsKey) + 1);
      abortItemControllers(fKey);
      abortItemControllers(dsKey);
      segmentMap.delete(item.id);
      latestItemSnapshots.delete(item.id);
    };

    if (containsMostlyChinese(rawText)) {
      stopPendingItemTranslate();
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
      stopPendingItemTranslate();
      const prevSt = liveStates.get(item.id);
      if (!prevSt || prevSt.sourceHash !== fullKey || prevSt.status !== 'done') {
        recordCacheHit();
      }
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
    const usableModels = configuredModels
      .map((spec) => resolveModelCandidate(spec, settings))
      .filter((c) => c && c.baseUrl && (c.apiKey || isLocalGatewayUrl(c.baseUrl)));
    const effectiveModelIds = usableModels.length > 0 ? usableModels.map((c) => c.modelId) : configuredModels;
    const onlyPureQwenMt = effectiveModelIds.length > 0 && effectiveModelIds.every((m) => isQwenMtModel(m));
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
        stopPendingItemTranslate();
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
    const style = settings.translateStyle || 'natural';
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
    const isRawDisplay = settings.displayMode === 'raw';
    const style = settings.translateStyle || 'natural';
    const summaryEnabled = settings.summaryEnabled === true && style !== 'steps';
    const hasKey = hasAnyConfiguredProvider(settings);
    const hasModels = parseModels(settings.translateModels).length > 0;
    const triggerNew = options.triggerNew !== false && !isRawDisplay;

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
        if (!hasModels && !mostlyZh) {
          item.translateStatus = 'no-model';
          item.narrativeStatus = 'no-model';
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
        if ((settings.translateStyle || 'natural') === 'steps' && fullRequestedIds.has(item.id)) {
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
          if (triggerNew && ((hasKey && hasModels) || isShortSingleZh)) {
            triggerNarrativeSummary(item, settings);
          } else if ((!hasKey || !hasModels) && mostlyZh) {
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

  async function fetchModelsForSingleProvider(baseUrl, apiKey, provider) {
    const providerName = PROVIDER_NAMES[provider] || provider;
    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const candidateUrls = [];
    if (provider === 'siliconflow') {
      candidateUrls.push(`${baseUrl}/models?type=text&sub_type=chat`, `${baseUrl}/models?type=text`);
    } else if (provider === 'local') {
      candidateUrls.push(`${baseUrl}/models`);
      try {
        const origin = new URL(baseUrl).origin;
        candidateUrls.push(`${origin}/v1/models`, `${origin}/api/tags`);
      } catch {}
    } else {
      candidateUrls.push(`${baseUrl}/models`);
    }

    let payload = null;
    let lastStatus = 0;
    let lastErrText = '';
    for (const targetUrl of [...new Set(candidateUrls)]) {
      try {
        const res = await fetch(targetUrl, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          lastStatus = res.status;
          lastErrText = await res.text().catch(() => '');
          continue;
        }
        payload = await res.json();
        break;
      } catch (err) {
        lastErrText = err?.message || String(err);
      }
    }

    const decorate = (ev) => ({
      ...ev,
      provider,
      providerName,
      baseUrl,
      qualifiedId: `${provider}::${ev.id}`,
    });

    if (!payload) {
      const curatedIds = PROVIDER_CURATED_IDS[provider] || [];
      if (curatedIds.length > 0 && (provider === 'zhipu' || provider === 'modelscope' || provider === 'hunyuan' || lastStatus === 404 || lastStatus === 405)) {
        const fallbackModels = curatedIds.map((id) => decorate(evaluateModelForTranslation(id, baseUrl)));
        return {
          ok: true,
          source: 'curated',
          provider,
          providerName,
          baseUrl,
          totalRaw: fallbackModels.length,
          models: fallbackModels,
          notice: provider === 'zhipu'
            ? '智谱官方未开放 /models 枚举接口，已自动载入核实精选模型。'
            : provider === 'modelscope'
              ? '魔搭 API-Inference 未开放全量 /models，已自动载入热门免费主力模型。'
              : provider === 'hunyuan'
                ? '腾讯混元未开放 /models 枚举接口，已自动载入官方核实模型。'
                : '该渠道未开放 /models，已自动载入核实参考模型。',
        };
      }
      const statusLabel = lastStatus ? ` (HTTP ${lastStatus})` : '';
      throw new Error(`拉取 ${providerName} 模型列表失败${statusLabel}: ${lastErrText.slice(0, 120)}`);
    }

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
      const evaluated = decorate(evaluateModelForTranslation(id, baseUrl, item));
      livePricingMap.set(`${provider}:${id}`, {
        priceIn: evaluated.priceIn,
        priceOut: evaluated.priceOut,
        cacheIn: evaluated.cacheIn,
        currency: evaluated.currency,
        isFree: evaluated.isFree,
      });
      rated.push(evaluated);
    }

    if (rated.length === 0 && (PROVIDER_CURATED_IDS[provider] || []).length > 0) {
      const fallbackModels = PROVIDER_CURATED_IDS[provider].map((id) => decorate(evaluateModelForTranslation(id, baseUrl)));
      return {
        ok: true,
        source: 'curated',
        provider,
        providerName,
        baseUrl,
        totalRaw: fallbackModels.length,
        models: fallbackModels,
      };
    }

    rated.sort((a, b) => Number(a.isPro) - Number(b.isPro) || b.overall - a.overall || a.id.localeCompare(b.id));
    return {
      ok: true,
      source: 'live',
      provider,
      providerName,
      baseUrl,
      totalRaw: rawList.length,
      models: rated,
    };
  }

  /**
   * 汇总所有「用户已配置」平台的可用模型，统一打标与三维度评分。
   */
  async function discoverAllConfiguredModels(overrideSettings = {}) {
    const saved = getSettings();
    const profileMap = new Map();
    const hasProfilesObj = saved.providerProfiles && typeof saved.providerProfiles === 'object' && !Array.isArray(saved.providerProfiles);
    for (const [k, prof] of Object.entries(saved.providerProfiles || {})) {
      if (!prof || !prof.baseUrl || prof.enabled === false) continue;
      if (k !== 'local' && !prof.apiKey) continue;
      profileMap.set(k, { provider: k, baseUrl: prof.baseUrl.replace(/\/+$/, ''), apiKey: prof.apiKey || '' });
    }
    // 兼容旧单渠道已保存 Key（有 providerProfiles 时不再把已删 local 复活）
    if (profileMap.size === 0 && saved.translateBaseUrl && (saved.translateApiKey || (!hasProfilesObj && isLocalGatewayUrl(saved.translateBaseUrl)))) {
      const k = detectProviderKey(saved.translateBaseUrl);
      profileMap.set(k, { provider: k, baseUrl: saved.translateBaseUrl.replace(/\/+$/, ''), apiKey: saved.translateApiKey || '' });
    }
    // 若用户在表单里刚填了尚未保存的新渠道 Key（或免 Key 的本地 Ollama 地址），也实时纳入汇总预览
    const ovUrl = String(overrideSettings.translateBaseUrl || '').trim().replace(/\/+$/, '');
    const ovKey = typeof overrideSettings.translateApiKey === 'string' ? overrideSettings.translateApiKey.trim() : '';
    if (ovUrl && (ovKey || isLocalGatewayUrl(ovUrl))) {
      const k = detectProviderKey(ovUrl);
      profileMap.set(k, { provider: k, baseUrl: ovUrl, apiKey: ovKey });
    }

    const targets = Array.from(profileMap.values());
    if (targets.length === 0) {
      return {
        ok: true,
        scope: 'all',
        configuredCount: 0,
        providers: [],
        count: 0,
        freeCount: 0,
        models: [],
      };
    }

    const settled = await Promise.all(
      targets.map(async (t) => {
        try {
          const res = await fetchModelsForSingleProvider(t.baseUrl, t.apiKey, t.provider);
          return {
            ok: true,
            key: t.provider,
            name: PROVIDER_NAMES[t.provider] || t.provider,
            baseUrl: t.baseUrl,
            source: res.source,
            count: res.models.length,
            freeCount: res.models.filter((m) => m.isFree).length,
            models: res.models,
          };
        } catch (err) {
          // 单家拉取失败不拖垮其它已配平台：若该渠道有内置核实参考则兜底
          const fallbackIds = PROVIDER_CURATED_IDS[t.provider] || [];
          const fallbackModels = fallbackIds.map((id) => ({
            ...evaluateModelForTranslation(id, t.baseUrl),
            provider: t.provider,
            providerName: PROVIDER_NAMES[t.provider] || t.provider,
            baseUrl: t.baseUrl,
            qualifiedId: `${t.provider}::${id}`,
          }));
          return {
            ok: fallbackModels.length > 0,
            key: t.provider,
            name: PROVIDER_NAMES[t.provider] || t.provider,
            baseUrl: t.baseUrl,
            source: fallbackModels.length > 0 ? 'curated' : 'error',
            error: err?.message || String(err),
            count: fallbackModels.length,
            freeCount: fallbackModels.filter((m) => m.isFree).length,
            models: fallbackModels,
          };
        }
      })
    );

    const allModels = [];
    const seenQualified = new Set();
    for (const p of settled) {
      for (const m of p.models || []) {
        if (seenQualified.has(m.qualifiedId)) continue;
        seenQualified.add(m.qualifiedId);
        allModels.push(m);
      }
    }
    allModels.sort((a, b) => Number(a.isPro) - Number(b.isPro) || b.overall - a.overall || a.id.localeCompare(b.id));
    return {
      ok: true,
      scope: 'all',
      configuredCount: targets.length,
      providers: settled.map(({ models: _m, ...meta }) => meta),
      count: allModels.length,
      freeCount: allModels.filter((m) => m.isFree).length,
      models: allModels,
    };
  }

  /**
   * 调用单个网关的 /models 接口（Ollama 兼容 /api/tags 回退），自动识别可用对话模型并按平台精确核定收费/免费与三维评分。
   */
  async function discoverModels(overrideSettings = {}) {
    const saved = getSettings();
    const baseUrl = (overrideSettings.translateBaseUrl || saved.translateBaseUrl || '').trim().replace(/\/+$/, '');
    const provider = detectProviderKey(baseUrl);
    const savedProf = saved.providerProfiles?.[provider];
    const sameProvider = normalizeBaseUrl(baseUrl) === normalizeBaseUrl(saved.translateBaseUrl);
    const hasExplicitKey = typeof overrideSettings.translateApiKey === 'string' && overrideSettings.translateApiKey.trim() !== '';
    const apiKey = hasExplicitKey
      ? overrideSettings.translateApiKey.trim()
      : (savedProf?.apiKey || (sameProvider ? (saved.translateApiKey || '').trim() : ''));

    if (!baseUrl) {
      throw new Error('请先填写 API Base URL');
    }
    if (!apiKey && !isLocalGatewayUrl(baseUrl)) {
      throw new Error(sameProvider ? '请先填写 API Key 再识别可用模型' : '已切换服务商地址，请先填写该服务商的 API Key');
    }

    const res = await fetchModelsForSingleProvider(baseUrl, apiKey, provider);
    const freeCount = res.models.filter((m) => m.isFree).length;
    return {
      ok: true,
      scope: 'single',
      baseUrl,
      provider,
      fallbackCurated: res.source === 'curated',
      notice: res.notice || '',
      totalRaw: res.totalRaw,
      count: res.models.length,
      freeCount,
      models: res.models,
    };
  }

  /**
   * 对官方提供余额查询接口的平台（DeepSeek / 硅基流动 / OpenRouter）直查真实余额。
   */
  async function fetchAccountBalance(overrideSettings = {}) {
    const saved = getSettings();
    const baseUrl = (overrideSettings.translateBaseUrl || saved.translateBaseUrl || '').trim().replace(/\/+$/, '');
    const provider = detectProviderKey(baseUrl);
    const savedProf = saved.providerProfiles?.[provider];
    const sameProvider = normalizeBaseUrl(baseUrl) === normalizeBaseUrl(saved.translateBaseUrl);
    const hasExplicitKey = typeof overrideSettings.translateApiKey === 'string' && overrideSettings.translateApiKey.trim() !== '';
    const apiKey = hasExplicitKey
      ? overrideSettings.translateApiKey.trim()
      : (savedProf?.apiKey || (sameProvider ? (saved.translateApiKey || '').trim() : ''));

    if (provider === 'local') {
      return { ok: true, provider, supported: true, summary: '本地模型运行 · 零 API 费用' };
    }
    if (!apiKey) {
      throw new Error('请先填写或保存该服务商的 API Key 再查询余额');
    }

    const headers = { Accept: 'application/json', Authorization: `Bearer ${apiKey}` };
    if (provider === 'deepseek') {
      const origin = new URL(baseUrl).origin;
      const res = await fetch(`${origin}/user/balance`, { method: 'GET', headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`DeepSeek 余额接口返回 HTTP ${res.status}`);
      const data = await res.json();
      const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : null;
      if (!info) throw new Error('未解析到 DeepSeek 余额字段');
      const sym = info.currency === 'USD' ? '$' : '¥';
      return {
        ok: true,
        provider,
        supported: true,
        summary: `余额 ${sym}${info.total_balance}（充 ${sym}${info.topped_up_balance} / 赠 ${sym}${info.granted_balance}）`,
        raw: data,
      };
    }

    if (provider === 'siliconflow') {
      const origin = new URL(baseUrl).origin;
      const res = await fetch(`${origin}/v1/user/info`, { method: 'GET', headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`硅基流动用户信息接口返回 HTTP ${res.status}（请前往官网控制台核对）`);
      const data = await res.json();
      const d = data?.data || data || {};
      const total = d.totalBalance ?? d.balance;
      if (total === undefined || total === null) throw new Error('接口未返回余额字段，请前往官网控制台核对');
      const charge = d.chargeBalance ?? '0';
      const gift = d.balance ?? '0';
      return {
        ok: true,
        provider,
        supported: true,
        summary: `总余额 ¥${total}（充 ¥${charge} / 赠 ¥${gift}）`,
        raw: d,
      };
    }

    if (provider === 'openrouter') {
      const res = await fetch('https://openrouter.ai/api/v1/key', { method: 'GET', headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`OpenRouter 额度接口返回 HTTP ${res.status}`);
      const payload = await res.json();
      const d = payload?.data || payload || {};
      const used = Number(d.usage ?? 0);
      const rem = d.limit_remaining;
      const remTxt = rem !== null && rem !== undefined ? ` / 剩余 $${Number(rem).toFixed(4)}` : (d.is_free_tier ? ' / 免费档' : '');
      return {
        ok: true,
        provider,
        supported: true,
        summary: `Key 已用 $${used.toFixed(4)}${remTxt}`,
        raw: d,
      };
    }

    if (provider === 'modelscope') {
      return {
        ok: true,
        provider,
        supported: false,
        summary: '魔搭每日免费推理额度请在官网个人中心查看（插件已实时统计本地调用次数与 Token，点右侧可直达官网）',
      };
    }

    if (provider === 'hunyuan') {
      return {
        ok: true,
        provider,
        supported: false,
        summary: '腾讯混元无单 Key 余额 API：hunyuan-lite 官方免费不扣费，付费档请点右侧前往混元控制台核对',
      };
    }

    return {
      ok: true,
      provider,
      supported: false,
      summary: '该渠道暂不开放单 Key 余额 API，已自动统计本地 Token 与预估花费（可点右侧前往官方账单核对）',
    };
  }

  async function testConnection(overrideSettings = {}) {
    const saved = getSettings();
    const settings = { ...saved, ...overrideSettings };
    const baseUrl = (settings.translateBaseUrl || '').trim();
    const provider = detectProviderKey(baseUrl);
    const savedProf = saved.providerProfiles?.[provider];
    const sameProvider = normalizeBaseUrl(baseUrl) === normalizeBaseUrl(saved.translateBaseUrl);
    const hasExplicitKey = typeof overrideSettings.translateApiKey === 'string' && overrideSettings.translateApiKey.trim() !== '';
    if (hasExplicitKey) {
      settings.translateApiKey = overrideSettings.translateApiKey.trim();
      settings.providerProfiles = {
        ...(saved.providerProfiles || {}),
        [provider]: { baseUrl, apiKey: settings.translateApiKey, enabled: true },
      };
    } else if (provider === 'local' && baseUrl) {
      settings.translateApiKey = '';
      settings.providerProfiles = {
        ...(saved.providerProfiles || {}),
        local: { baseUrl, apiKey: '', enabled: true },
      };
    } else if (savedProf?.apiKey) {
      settings.translateApiKey = savedProf.apiKey;
    } else if (sameProvider) {
      settings.translateApiKey = (saved.translateApiKey || '').trim();
    } else {
      settings.translateApiKey = '';
    }
    if (!hasAnyConfiguredProvider(settings)) {
      throw new Error('请先至少配置一个平台的 API Key（或启用本地 Ollama）');
    }
    const { result, model, providerName, ttftMs, totalMs } = await translateWithFallback(
      'I should check the config files first and make sure the layout looks clean without repeating the first line.',
      settings,
      undefined,
      undefined,
      'full',
      22000,
      { bypassCooldown: true }
    );
    return { ok: true, model: providerName ? `${providerName}/${model}` : model, sample: result, ttftMs, totalMs };
  }

  function resetErrors() {
    modelCooldownUntil.clear();
    rateLimitHits.clear();
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
    rateLimitHits.clear();
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
    rateLimitHits.clear();
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
    const prev = fullDetailStates.get(itemId);
    if (prev && (prev.status === 'error' || prev.status === 'no-key')) {
      const dk = detailTrackKey(itemId);
      itemEpochs.set(dk, getItemEpoch(dk) + 1);
      abortItemControllers(dk);
      fullDetailStates.delete(itemId);
      modelCooldownUntil.clear();
      rateLimitHits.clear();
    }
    onProgress?.();
  }

  function retryItem(itemId, rawText = '') {
    modelCooldownUntil.clear();
    rateLimitHits.clear();
    const style = getSettings().translateStyle || 'natural';
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
    rateLimitHits.clear();
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
      usage: getUsageSummary(),
    };
  }

  return {
    enrichTurns,
    discoverModels,
    discoverAllConfiguredModels,
    fetchAccountBalance,
    testConnection,
    resetErrors,
    resetForConfigChange,
    resetForStyleChange,
    requestFullTranslation,
    retryItem,
    clearCache,
    flushCache: () => {
      flushCacheNow();
      flushUsageNow();
    },
    getUsageSummary,
    resetUsageStats,
    getStats,
  };
}

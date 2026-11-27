import { basename } from 'node:path';

function parseIsoMs(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function parseDurationSec(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.match(/^([\d.]+)s$/);
  if (!match) return null;
  const val = parseFloat(match[1]);
  return Number.isFinite(val) ? Math.round(val * 10) / 10 : null;
}

function parseJsonSafe(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function extractUserPrompt(step) {
  const items = step?.userInput?.items;
  if (Array.isArray(items) && items.length > 0) {
    const text = items
      .map((item) => item?.text || '')
      .join(' ')
      .replace(/<\/?USER_REQUEST>/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text.slice(0, 120);
  }
  const raw = step?.userInput?.userResponse || '';
  return raw.replace(/<\/?USER_REQUEST>/gi, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function isRunningStatus(status) {
  return (
    status === 'CORTEX_STEP_STATUS_RUNNING' ||
    status === 'CORTEX_STEP_STATUS_GENERATING' ||
    status === 'CORTEX_STEP_STATUS_PENDING' ||
    status === 'CORTEX_STEP_STATUS_WAITING'
  );
}

function decodeFilePath(uriOrPath) {
  if (!uriOrPath || typeof uriOrPath !== 'string') return '';
  let clean = uriOrPath;
  if (/^file:\/\//i.test(clean)) {
    clean = clean.replace(/^file:\/\//i, '');
    try {
      clean = decodeURIComponent(clean);
    } catch {
      // 非法百分比编码时保留原文，避免抛错
    }
    if (/^\/[A-Za-z]:[\\/]/.test(clean)) clean = clean.slice(1);
  }
  return clean;
}

function fileBasename(uriOrPath) {
  const clean = decodeFilePath(uriOrPath).replace(/\\/g, '/');
  if (!clean) return '';
  return basename(clean) || clean;
}

const LIVE_DETAIL_KEYS = [
  'toolSummary',
  'title',
  'description',
  'objective',
  'task',
  'task_name',
  'name',
  'question',
  'questions',
  'prompt',
  'message',
  'CommandLine',
  'command',
  'cmd',
  'queries',
  'query',
  'Query',
  'pattern',
  'url',
  'uri',
  'Path',
  'file_path',
  'path',
  'target',
  'action',
  'status',
];

function normalizeLiveDetail(val) {
  let text = '';
  if (typeof val === 'string') {
    text = val;
  } else if (Array.isArray(val) && val.every((v) => typeof v === 'string')) {
    text = val.join(', ');
  } else if (Array.isArray(val)) {
    for (const entry of val) {
      if (entry && typeof entry === 'object' && typeof entry.question === 'string' && entry.question.trim()) {
        text = entry.question;
        break;
      }
    }
  }
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > 160 ? `${clean.slice(0, 159).trimEnd()}…` : clean;
}

function extractLiveToolDetail(args, toolName, fallbackSummary = '') {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    for (const key of LIVE_DETAIL_KEYS) {
      if (!(key in args)) continue;
      let val = args[key];
      if ((key === 'Path' || key === 'file_path' || key === 'path') && typeof val === 'string') {
        val = fileBasename(val) || val;
      }
      const detail = normalizeLiveDetail(val);
      if (detail) return detail;
    }
  }
  return normalizeLiveDetail(fallbackSummary) || normalizeLiveDetail(toolName);
}

function buildToolItem(step, fallbackIdx, activeId, allocId) {
  const meta = step?.metadata || {};
  const toolCall = meta.toolCall || {};
  const stepIdx = meta.sourceTrajectoryStepInfo?.stepIndex ?? fallbackIdx;
  const parsedArgs = parseJsonSafe(toolCall.argumentsJson);
  const args = (parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs))
    ? parsedArgs
    : (step?.generic?.args && typeof step.generic.args === 'object' ? step.generic.args : {});
  const toolName = toolCall.name || '';
  const type = step?.type || '';
  const running = isRunningStatus(step?.status);
  const status = running ? 'running' : step?.status === 'CORTEX_STEP_STATUS_ERROR' ? 'error' : 'done';

  const startedAtMs = parseIsoMs(meta.startedAt || meta.viewableAt || meta.createdAt);
  const completedAtMs = parseIsoMs(meta.completedAt);
  const durationSec =
    startedAtMs && completedAtMs && completedAtMs >= startedAtMs
      ? Math.round(((completedAtMs - startedAtMs) / 1000) * 10) / 10
      : null;

  if (type === 'CORTEX_STEP_TYPE_RUN_COMMAND' || toolName === 'run_command') {
    const cmd = typeof args.CommandLine === 'string'
      ? args.CommandLine
      : (typeof step?.runCommand?.command === 'string' ? step.runCommand.command : '');
    const summary = args.toolSummary || step?.runCommand?.toolSummary || cmd.slice(0, 56) || '执行命令';
    const cwd = args.Cwd || step?.runCommand?.cwd || '';
    return {
      id: allocId(`${activeId}:s${stepIdx}`, fallbackIdx),
      kind: 'cmd',
      toolName: toolName || 'run_command',
      stepIndex: stepIdx,
      status,
      label: '运行命令',
      summary,
      liveDetail: extractLiveToolDetail(args, toolName || 'run_command', summary),
      detail: [cwd ? `# cwd: ${cwd}` : '', cmd].filter(Boolean).join('\n'),
      durationSec,
      startedAtMs,
    };
  }

  if (
    type === 'CORTEX_STEP_TYPE_VIEW_FILE' ||
    type === 'CORTEX_STEP_TYPE_CODE_ACTION' ||
    ['read_file', 'write_file', 'edit_file'].includes(toolName)
  ) {
    const fileUri =
      args.Path ||
      step?.viewFile?.absolutePathUri ||
      step?.codeAction?.actionSpec?.command?.file?.absoluteUri ||
      '';
    const name = fileBasename(fileUri) || toolName || '文件操作';
    const isEdit =
      toolName === 'write_file' ||
      toolName === 'edit_file' ||
      Boolean(step?.codeAction?.actionSpec?.command?.isEdit) ||
      type === 'CORTEX_STEP_TYPE_CODE_ACTION';
    const label = toolName === 'write_file' ? '写入文件' : isEdit ? '修改文件' : '读取文件';
    const resolvedToolName = toolName || (isEdit ? 'edit_file' : 'read_file');
    const hasRange = args.StartLine != null || args.EndLine != null;
    const range = hasRange ? ` (${args.StartLine ?? 1}-${args.EndLine ?? ''})` : '';
    const decodedPath = decodeFilePath(fileUri);
    return {
      id: allocId(`${activeId}:s${stepIdx}`, fallbackIdx),
      kind: 'file',
      toolName: resolvedToolName,
      stepIndex: stepIdx,
      status,
      label,
      summary: `${name}${range}`,
      liveDetail: extractLiveToolDetail(args, resolvedToolName, `${name}${range}`),
      detail: decodedPath ? `${decodedPath}${range}` : JSON.stringify(args, null, 2),
      durationSec,
      startedAtMs,
    };
  }

  if (type === 'CORTEX_STEP_TYPE_SEARCH_WEB' || toolName === 'search_web') {
    const query = typeof args.query === 'string' ? args.query : '';
    return {
      id: allocId(`${activeId}:s${stepIdx}`, fallbackIdx),
      kind: 'search',
      toolName: toolName || 'search_web',
      stepIndex: stepIdx,
      status,
      label: '网页搜索',
      summary: query || '搜索资料',
      liveDetail: extractLiveToolDetail(args, toolName || 'search_web', query || '搜索资料'),
      detail: query ? `query: ${query}` : JSON.stringify(args, null, 2),
      durationSec,
      startedAtMs,
    };
  }

  if (!toolName) return null;

  const previewKeys = Object.entries(args)
    .slice(0, 2)
    .map(([k, v]) => {
      const rawVal = typeof v === 'string' ? v : JSON.stringify(v);
      const shortVal = rawVal && rawVal.length > 36 ? `${rawVal.slice(0, 35)}…` : (rawVal || '');
      return `${k}=${shortVal}`;
    })
    .join(', ');

  return {
    id: allocId(`${activeId}:s${stepIdx}`, fallbackIdx),
    kind: 'tool',
    toolName,
    stepIndex: stepIdx,
    status,
    label: '工具调用',
    summary: previewKeys ? `${toolName} · ${previewKeys}` : toolName,
    liveDetail: extractLiveToolDetail(args, toolName, previewKeys),
    detail: Object.keys(args).length ? JSON.stringify(args, null, 2) : '{}',
    durationSec,
    startedAtMs,
  };
}

export function buildTurnsPayload(conversations, activeId, trajectoryData, options = {}) {
  const includeTools = options.includeTools !== false;
  const steps = Array.isArray(trajectoryData?.trajectory?.steps)
    ? trajectoryData.trajectory.steps
    : [];

  const turns = [];
  const usedIds = new Set();
  const allocId = (baseId, fallbackIdx) => {
    const id = usedIds.has(baseId) ? `${baseId}_${fallbackIdx}` : baseId;
    usedIds.add(id);
    return id;
  };
  let currentTurn = null;
  let turnCounter = 0;

  const ensureTurn = (prompt = '当前会话', createdAt = '') => {
    if (!currentTurn) {
      turnCounter += 1;
      currentTurn = {
        turnIndex: turnCounter,
        prompt,
        createdAt,
        startedAtMs: parseIsoMs(createdAt),
        completedAtMs: null,
        hasGeneratingStep: false,
        items: [],
      };
      turns.push(currentTurn);
    }
    return currentTurn;
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const type = step?.type;

    if (type === 'CORTEX_STEP_TYPE_USER_INPUT') {
      turnCounter += 1;
      const createdAt = step?.metadata?.createdAt || '';
      currentTurn = {
        turnIndex: turnCounter,
        prompt: extractUserPrompt(step) || `第 ${turnCounter} 轮对话`,
        createdAt,
        startedAtMs: parseIsoMs(createdAt),
        completedAtMs: null,
        hasGeneratingStep: false,
        items: [],
      };
      turns.push(currentTurn);
      continue;
    }

    if (type === 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE') continue;

    if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
      const pr = step.plannerResponse || {};
      const thinking = typeof pr.thinking === 'string' ? pr.thinking : '';
      const hasThinking = Boolean(thinking.trim());
      const replyText = String(pr.modifiedResponse || pr.response || '').trim();
      const hasResponse = Boolean(replyText);
      const isGenerating = isRunningStatus(step.status);
      const meta = step.metadata || {};
      const completedMs = parseIsoMs(meta.completedAt || meta.finishedGeneratingAt);
      const thinkDurationSec = parseDurationSec(pr.thinkingDuration);
      const toolCalls = Array.isArray(pr.toolCalls)
        ? pr.toolCalls.map((t) => t?.name).filter(Boolean)
        : [];
      // 只要正文已出、已有工具调用、已带完成时间戳，或思考耗时严格 > 0（防止 protobuf 默认 "0s" 误判），思考阶段即已结束
      const thinkingDone = Boolean(
        hasResponse ||
        toolCalls.length > 0 ||
        completedMs ||
        (typeof thinkDurationSec === 'number' && thinkDurationSec > 0)
      );
      const isThinkGenerating = isGenerating && !thinkingDone;
      const turn = ensureTurn('当前会话', meta.createdAt || '');
      if (isGenerating) turn.hasGeneratingStep = true;
      if (completedMs) turn.completedAtMs = Math.max(turn.completedAtMs || 0, completedMs);

      const stepIdx = meta.sourceTrajectoryStepInfo?.stepIndex ?? i;
      const viewableAtMs = parseIsoMs(meta.viewableAt || meta.createdAt);
      if (thinkingDone && !completedMs && viewableAtMs && typeof thinkDurationSec === 'number' && thinkDurationSec > 0) {
        const estEndMs = viewableAtMs + Math.round(thinkDurationSec * 1000);
        turn.completedAtMs = Math.max(turn.completedAtMs || 0, estEndMs);
      }

      if (hasThinking || isThinkGenerating) {
        turn.items.push({
          id: allocId(`${activeId}:t${stepIdx}`, i),
          kind: 'think',
          stepIndex: stepIdx,
          status: isThinkGenerating ? 'generating' : 'done',
          label: '思考',
          thinking,
          durationSec: thinkDurationSec,
          startedAtMs: viewableAtMs,
          thinkingTokens: Number(meta.modelUsage?.thinkingOutputTokens || 0),
          tools: toolCalls,
          hasResponse,
        });
      }

      // DSH 分组边界：任何非空助手回复都会截断前一个过程组，使阶段回复前后自然分为 G1 / G2
      if (hasResponse) {
        turn.items.push({
          id: allocId(`${activeId}:rb${stepIdx}`, i),
          kind: 'reply-boundary',
          stepIndex: stepIdx,
          status: isGenerating ? 'generating' : 'done',
          preview: replyText.replace(/\s+/g, ' ').slice(0, 120),
        });
      }
      continue;
    }

    // 即使隐藏工具胶囊，也需同步追踪在途步骤与完成时间，避免工具执行期间误判整轮已完成
    const stepIsRunning = isRunningStatus(step?.status);
    const stepCompletedMs = parseIsoMs(step?.metadata?.completedAt);
    if (stepIsRunning) {
      const turn = ensureTurn('当前会话', step?.metadata?.createdAt || '');
      turn.hasGeneratingStep = true;
    }
    if (stepCompletedMs && currentTurn) {
      currentTurn.completedAtMs = Math.max(currentTurn.completedAtMs || 0, stepCompletedMs);
    }

    if (includeTools) {
      const item = buildToolItem(step, i, activeId, allocId);
      if (item) {
        const turn = ensureTurn('当前会话', step?.metadata?.createdAt || '');
        if (stepCompletedMs) turn.completedAtMs = Math.max(turn.completedAtMs || 0, stepCompletedMs);
        turn.items.push(item);
      }
    }
  }

  for (const turn of turns) {
    let thinkCount = 0;
    let toolCount = 0;
    let running = Boolean(turn.hasGeneratingStep);
    let hasError = false;
    let firstProcessMs = null;
    for (const item of turn.items) {
      if (item.kind === 'reply-boundary') {
        if (item.status === 'generating') running = true;
        continue;
      }
      if (firstProcessMs === null && item.startedAtMs) firstProcessMs = item.startedAtMs;
      if (item.kind === 'think') {
        thinkCount += 1;
        if (item.status === 'generating') running = true;
      } else {
        toolCount += 1;
        if (item.status === 'running') running = true;
        if (item.status === 'error') hasError = true;
      }
    }
    const firstMs = firstProcessMs ?? turn.startedAtMs;
    const endMs = turn.completedAtMs;
    turn.thinkCount = thinkCount;
    turn.toolCount = toolCount;
    turn.stepCount = thinkCount + toolCount;
    turn.hasProcess = thinkCount > 0 || toolCount > 0;
    turn.isRunning = running;
    turn.hasError = hasError;
    turn.endReason = running ? 'running' : hasError ? 'error' : 'done';
    turn.durationSec =
      firstMs && endMs && endMs >= firstMs
        ? Math.round(((endMs - firstMs) / 1000) * 10) / 10
        : null;
    turn.startedAtMs = firstMs || turn.startedAtMs;
  }

  const activeMeta = conversations.find((c) => c.id === activeId) || null;
  const activeStatus =
    trajectoryData?.status ||
    trajectoryData?.trajectory?.status ||
    activeMeta?.status ||
    '';

  // 当会话整体仍处于 CASCADE_RUN_STATUS_RUNNING（例如工具刚执行完、下一次思考尚未落盘的空窗期），
  // 保持最后一轮处于运行态，防止卡片在步骤衔接间隙误判完成并提前自动收起
  if (activeStatus === 'CASCADE_RUN_STATUS_RUNNING' && turns.length > 0) {
    const lastTurn = turns[turns.length - 1];
    if (!lastTurn.isRunning) {
      lastTurn.isRunning = true;
      lastTurn.endReason = 'running';
    }
  }

  const isGenerating = turns.some((t) => t.isRunning) || activeStatus === 'CASCADE_RUN_STATUS_RUNNING';

  return {
    activeId,
    activeTitle: activeMeta?.summary || '未命名对话',
    activeStatus,
    isGenerating,
    conversations: conversations.slice(0, 30),
    turns,
    updatedAt: Date.now(),
  };
}

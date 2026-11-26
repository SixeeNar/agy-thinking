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
    status === 'CORTEX_STEP_STATUS_PENDING'
  );
}

function fileBasename(uriOrPath) {
  if (!uriOrPath || typeof uriOrPath !== 'string') return '';
  const clean = uriOrPath.replace(/^file:\/\//i, '').replace(/\\/g, '/');
  return basename(clean) || clean;
}

function buildToolItem(step, fallbackIdx, activeId, allocId) {
  const meta = step?.metadata || {};
  const toolCall = meta.toolCall || {};
  const stepIdx = meta.sourceTrajectoryStepInfo?.stepIndex ?? fallbackIdx;
  const args = parseJsonSafe(toolCall.argumentsJson) || step?.generic?.args || {};
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
      stepIndex: stepIdx,
      status,
      label: '运行命令',
      summary,
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
    const hasRange = args.StartLine != null || args.EndLine != null;
    const range = hasRange ? ` (${args.StartLine ?? 1}-${args.EndLine ?? ''})` : '';
    return {
      id: allocId(`${activeId}:s${stepIdx}`, fallbackIdx),
      kind: 'file',
      stepIndex: stepIdx,
      status,
      label,
      summary: `${name}${range}`,
      detail: fileUri ? `${fileUri}${range}` : JSON.stringify(args, null, 2),
      durationSec,
      startedAtMs,
    };
  }

  if (type === 'CORTEX_STEP_TYPE_SEARCH_WEB' || toolName === 'search_web') {
    const query = typeof args.query === 'string' ? args.query : '';
    return {
      id: allocId(`${activeId}:s${stepIdx}`, fallbackIdx),
      kind: 'search',
      stepIndex: stepIdx,
      status,
      label: '网页搜索',
      summary: query || '搜索资料',
      detail: query ? `query: ${query}` : JSON.stringify(args, null, 2),
      durationSec,
      startedAtMs,
    };
  }

  if (!toolName) return null;

  const previewKeys = Object.entries(args)
    .slice(0, 2)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 36) : JSON.stringify(v)}`)
    .join(', ');

  return {
    id: allocId(`${activeId}:s${stepIdx}`, fallbackIdx),
    kind: 'tool',
    stepIndex: stepIdx,
    status,
    label: '工具调用',
    summary: previewKeys ? `${toolName} · ${previewKeys}` : toolName,
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
        items: [],
      };
      turns.push(currentTurn);
      continue;
    }

    if (type === 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE') continue;

    if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
      const pr = step.plannerResponse || {};
      const thinking = typeof pr.thinking === 'string' ? pr.thinking : '';
      const isGenerating = isRunningStatus(step.status);
      const meta = step.metadata || {};
      const completedMs = parseIsoMs(meta.completedAt || meta.finishedGeneratingAt);
      const turn = ensureTurn('当前会话', meta.createdAt || '');
      if (completedMs) turn.completedAtMs = Math.max(turn.completedAtMs || 0, completedMs);

      if (!thinking && !isGenerating) continue;

      const stepIdx = meta.sourceTrajectoryStepInfo?.stepIndex ?? i;
      const viewableAtMs = parseIsoMs(meta.viewableAt || meta.createdAt);
      const toolCalls = Array.isArray(pr.toolCalls)
        ? pr.toolCalls.map((t) => t?.name).filter(Boolean)
        : [];

      turn.items.push({
        id: allocId(`${activeId}:t${stepIdx}`, i),
        kind: 'think',
        stepIndex: stepIdx,
        status: isGenerating ? 'generating' : 'done',
        label: '思考',
        thinking,
        durationSec: parseDurationSec(pr.thinkingDuration),
        startedAtMs: viewableAtMs,
        thinkingTokens: Number(meta.modelUsage?.thinkingOutputTokens || 0),
        tools: toolCalls,
        hasResponse: Boolean(pr.response || pr.modifiedResponse),
      });
      continue;
    }

    if (includeTools) {
      const item = buildToolItem(step, i, activeId, allocId);
      if (item) {
        const turn = ensureTurn('当前会话', step?.metadata?.createdAt || '');
        const completedMs = parseIsoMs(step?.metadata?.completedAt);
        if (completedMs) turn.completedAtMs = Math.max(turn.completedAtMs || 0, completedMs);
        turn.items.push(item);
      }
    }
  }

  for (const turn of turns) {
    let thinkCount = 0;
    let toolCount = 0;
    let running = false;
    for (const item of turn.items) {
      if (item.kind === 'think') {
        thinkCount += 1;
        if (item.status === 'generating') running = true;
      } else {
        toolCount += 1;
        if (item.status === 'running') running = true;
      }
    }
    const firstMs = turn.items[0]?.startedAtMs ?? turn.startedAtMs;
    const endMs = turn.completedAtMs;
    turn.thinkCount = thinkCount;
    turn.toolCount = toolCount;
    turn.isRunning = running;
    turn.durationSec =
      firstMs && endMs && endMs >= firstMs
        ? Math.round(((endMs - firstMs) / 1000) * 10) / 10
        : null;
    turn.startedAtMs = firstMs || turn.startedAtMs;
  }

  const activeMeta = conversations.find((c) => c.id === activeId) || null;
  const isGenerating = turns.some((t) => t.isRunning);

  return {
    activeId,
    activeTitle: activeMeta?.summary || '未命名对话',
    activeStatus: activeMeta?.status || '',
    isGenerating,
    conversations: conversations.slice(0, 30),
    turns,
    updatedAt: Date.now(),
  };
}

'use client';

import { useState } from 'react';
import { Plan, ExecutionState } from '@/lib/orion';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, XCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';

interface AgentDashboardProps {
  plan: Plan | null;
  state: ExecutionState;
  summary: {
    totalTasks: number;
    completed: number;
    failed: number;
    pending: number;
    inProgress: number;
  };
  memory: Record<string, unknown>;
  taskResults?: Record<string, any>;
  metrics?: {
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    totalCost: number;
    estimatedCost: number;
    averageConfidence: number;
    totalLatency: number;
    tasksPerSecond: number;
  };
}

interface TaskMetricDetail {
  description: string;
  status: string;
  model: string;
  latency: number;
  latencyIsEst: boolean;
  latencyFormula: string;
  tokens: number;
  tokensIsEst: boolean;
  tokensFormula: string;
  cost: number;
  costIsEst: boolean;
  costFormula: string;
  confidence: number;
  confidenceIsEst: boolean;
  confidenceFormula: string;
}

interface AgentMetrics {
  status: 'idle' | 'running' | 'completed' | 'error';
  model: string;
  tokens: number;
  latency: number;
  confidence: number;
  cost: number;
  isEstimated: boolean;
  tasksDetail: TaskMetricDetail[];
}

const MODEL_SPECS: Record<
  string,
  { speed: number; cost: number; capability: number; promptPrice: number; completionPrice: number }
> = {
  'deepseek/deepseek-chat': { speed: 7, cost: 15000, capability: 9, promptPrice: 0.14, completionPrice: 0.28 },
  'deepseek/deepseek-chat-v3.1:free': {
    speed: 7,
    cost: 100000,
    capability: 9,
    promptPrice: 0,
    completionPrice: 0,
  },
  'deepseek/deepseek-r1': { speed: 5, cost: 10000, capability: 10, promptPrice: 0.55, completionPrice: 2.19 },
  'deepseek/deepseek-r1:free': { speed: 5, cost: 100000, capability: 10, promptPrice: 0, completionPrice: 0 },
  'qwen/qwen3-coder:free': { speed: 6, cost: 100000, capability: 9, promptPrice: 0, completionPrice: 0 },
  'qwen/qwen3.6-plus:free': { speed: 8, cost: 100000, capability: 8, promptPrice: 0, completionPrice: 0 },
  'minimax/minimax-m2.5:free': { speed: 9, cost: 100000, capability: 7, promptPrice: 0, completionPrice: 0 },
  'openrouter/auto': { speed: 8, cost: 50000, capability: 8, promptPrice: 0.15, completionPrice: 0.3 },
  unknown: { speed: 7, cost: 15000, capability: 8, promptPrice: 0.15, completionPrice: 0.3 },
};

const AGENTS = [
  { id: 'planner', name: 'Planner' },
  { id: 'engineering', name: 'Engineering' },
  { id: 'research', name: 'Research' },
  { id: 'marketing', name: 'Marketing' },
];

export function AgentDashboard({ plan, state, summary, memory, metrics }: AgentDashboardProps) {
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  const getModelName = (agentId: string): string => {
    const models: Record<string, string> = {
      planner: 'deepseek/deepseek-chat',
      engineering: 'deepseek/deepseek-chat',
      research: 'deepseek/deepseek-r1',
      marketing: 'google/gemini-2.5-flash',
    };
    return models[agentId] || 'openrouter/auto';
  };

  const getAgentMetrics = (agentId: string): AgentMetrics => {
    const isRunning = state.runningAgents.includes(agentId as any);
    const tasks = plan?.tasks.filter((t) => t.assignedTo === agentId) || [];
    const completedTasks = tasks.filter((t) => t.status === 'completed');
    const failedTasks = tasks.filter((t) => t.status === 'failed');

    if (tasks.length === 0) {
      return {
        status: 'idle',
        model: getModelName(agentId),
        tokens: 0,
        latency: 0,
        confidence: 0,
        cost: 0,
        isEstimated: true,
        tasksDetail: [],
      };
    }

    const modelName =
      completedTasks[0]?.metadata?.selectedModel ||
      tasks[0]?.metadata?.selectedModel ||
      getModelName(agentId);
    const modelSpec = MODEL_SPECS[modelName] || MODEL_SPECS.unknown;

    let latencySum = 0;
    let tokensSum = 0;
    let costSum = 0;
    let confidenceSum = 0;
    const tasksDetail: TaskMetricDetail[] = [];
    let hasRealMetrics = false;

    tasks.forEach((task) => {
      const meta = task.metadata;
      let latency = 0;
      let latencyIsEst = true;
      let latencyFormula = 'Estimated from model speed';

      if (meta?.latency != null && meta.latency > 0) {
        latency = meta.latency;
        latencyIsEst = false;
        latencyFormula = 'From task metadata.latency';
        hasRealMetrics = true;
      } else if (meta?.executionStartTime && meta?.executionEndTime) {
        latency = new Date(meta.executionEndTime).getTime() - new Date(meta.executionStartTime).getTime();
        latencyIsEst = false;
        latencyFormula = 'endTime − startTime';
        hasRealMetrics = true;
      } else if (task.status === 'in_progress' && meta?.executionStartTime) {
        latency = Date.now() - new Date(meta.executionStartTime).getTime();
        latencyIsEst = false;
        latencyFormula = 'now − startTime (in progress)';
      } else {
        latency = Math.round((100 / modelSpec.speed) * 1000);
      }

      let tokens = meta?.tokens ?? 0;
      let tokensIsEst = !(meta?.tokens != null && meta.tokens > 0);
      let tokensFormula = !tokensIsEst
        ? 'From task metadata.tokens'
        : `Estimate ≈ ${Math.round((task.description?.length || 40) * 1.3)} tokens`;

      if (tokensIsEst) {
        tokens = Math.round((task.description?.length || 40) * 1.3 + 800);
      } else {
        hasRealMetrics = true;
      }

      const reportedCost = meta?.actualCost ?? meta?.estimatedCost;
      let cost = reportedCost ?? 0;
      let costIsEst = reportedCost == null || (meta?.actualCost == null && meta?.estimatedCost != null);
      let costFormula =
        meta?.actualCost != null
          ? 'From metadata.actualCost'
          : meta?.estimatedCost != null
            ? 'From metadata.estimatedCost'
            : '(tokens/1000) × blended price';

      if (reportedCost == null) {
        cost = (tokens / 1000) * ((modelSpec.promptPrice + modelSpec.completionPrice) / 2);
      } else {
        hasRealMetrics = true;
      }

      let confidence = meta?.confidence != null ? Math.round(meta.confidence * 100) : 0;
      let confidenceIsEst = meta?.confidence == null;
      let confidenceFormula =
        meta?.confidence != null ? 'Agent confidence score' : 'Default until task completes';

      if (meta?.confidence == null && task.status === 'completed') {
        confidence = 85;
      }

      latencySum += latency;
      tokensSum += tokens;
      costSum += cost;
      confidenceSum += confidence;

      tasksDetail.push({
        description: task.description,
        status: task.status,
        model: meta?.selectedModel || modelName,
        latency,
        latencyIsEst,
        latencyFormula,
        tokens,
        tokensIsEst,
        tokensFormula,
        cost,
        costIsEst,
        costFormula,
        confidence,
        confidenceIsEst,
        confidenceFormula,
      });
    });

    const avgConfidence = tasksDetail.length > 0 ? Math.round(confidenceSum / tasksDetail.length) : 0;

    return {
      status: isRunning
        ? 'running'
        : failedTasks.length > 0
          ? 'error'
          : completedTasks.length > 0
            ? 'completed'
            : 'idle',
      model: modelName,
      tokens: tokensSum,
      latency: latencySum,
      confidence: avgConfidence,
      cost: costSum,
      isEstimated: !hasRealMetrics,
      tasksDetail,
    };
  };

  if (!plan) return null;

  const progress = Math.round(
    ((summary.completed + summary.failed) / (summary.totalTasks || 1)) * 100,
  );

  return (
    <div className="h-full bg-orion-elevated/40 flex flex-col border-r border-orion-hairline">
      <div className="px-4 py-3 border-b border-orion-hairline flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-orion-paper">Agents</h2>
          <p className="text-[11px] font-mono text-muted-foreground mt-0.5">
            {summary.completed}/{summary.totalTasks || 0} tasks · {progress}%
          </p>
        </div>
        {metrics && (
          <div className="text-right text-[11px] font-mono text-muted-foreground">
            <div>${(metrics.totalCost || 0).toFixed(4)}</div>
            <div>{Math.round(metrics.totalLatency || 0)}ms</div>
          </div>
        )}
      </div>

      <div className="h-1 bg-secondary/80">
        <div
          className="h-full bg-orion-ink transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="divide-y divide-orion-hairline">
          {AGENTS.map((agent) => {
            const agentMetrics = getAgentMetrics(agent.id);
            const tasks = plan.tasks.filter((t) => t.assignedTo === agent.id);
            if (tasks.length === 0 && agentMetrics.status === 'idle') return null;

            const expanded = expandedAgent === agent.id;

            return (
              <motion.div
                key={agent.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="px-4 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-medium text-foreground">{agent.name}</h3>
                      <StatusBadge status={agentMetrics.status} />
                      {agentMetrics.isEstimated && (
                        <span className="text-[10px] text-muted-foreground/80">est.</span>
                      )}
                    </div>
                    <p className="text-[11px] font-mono text-muted-foreground truncate mt-0.5">
                      {agentMetrics.model}
                    </p>
                  </div>
                </div>

                <div className="mt-2.5 grid grid-cols-4 gap-2 text-[11px]">
                  <Metric label="Latency" value={`${agentMetrics.latency.toLocaleString()}ms`} />
                  <Metric label="Tokens" value={agentMetrics.tokens.toLocaleString()} />
                  <Metric label="Conf." value={`${agentMetrics.confidence}%`} />
                  <Metric label="Cost" value={`$${agentMetrics.cost.toFixed(4)}`} />
                </div>

                <button
                  type="button"
                  onClick={() => setExpandedAgent(expanded ? null : agent.id)}
                  className="mt-2 w-full flex items-center justify-between text-[11px] text-muted-foreground hover:text-orion-ink py-1"
                >
                  <span>{expanded ? 'Hide details' : 'Details'}</span>
                  {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>

                <AnimatePresence>
                  {expanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="pt-2 space-y-2">
                        {tasks.map((task) => (
                          <div
                            key={task.id}
                            className="rounded-md border border-orion-hairline bg-orion-surface/60 p-2.5"
                          >
                            <div className="flex items-center justify-between gap-2 mb-1.5">
                              <p className="text-xs text-foreground truncate">{task.description}</p>
                              <span className="text-[10px] font-mono text-muted-foreground capitalize shrink-0">
                                {task.status}
                              </span>
                            </div>
                            {task.metadata?.toolsUsed && task.metadata.toolsUsed.length > 0 && (
                              <p className="mb-1.5 text-[10px] font-mono text-orion-ink">
                                Tools: {task.metadata.toolsUsed.join(', ')}
                              </p>
                            )}
                            {task.result != null && (
                              <pre className="text-[10px] font-mono text-muted-foreground whitespace-pre-wrap max-h-28 overflow-auto">
                                {typeof task.result === 'string'
                                  ? task.result
                                  : JSON.stringify(task.result, null, 2)}
                              </pre>
                            )}
                          </div>
                        ))}
                        {agentMetrics.tasksDetail.map((detail, idx) => (
                          <div
                            key={`formula-${idx}`}
                            className="text-[10px] font-mono text-muted-foreground/90 space-y-1 border border-orion-hairline/70 rounded-md p-2"
                          >
                            <div>
                              latency: {detail.latency}ms
                              {detail.latencyIsEst ? ' (est.)' : ''} — {detail.latencyFormula}
                            </div>
                            <div>
                              tokens: {detail.tokens}
                              {detail.tokensIsEst ? ' (est.)' : ''} — {detail.tokensFormula}
                            </div>
                            <div>
                              cost: ${detail.cost.toFixed(6)}
                              {detail.costIsEst ? ' (est.)' : ''} — {detail.costFormula}
                            </div>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>

        <div className="px-4 py-3 border-t border-orion-hairline grid grid-cols-4 gap-2">
          <Stat label="Total" value={summary.totalTasks} />
          <Stat label="Done" value={summary.completed} />
          <Stat label="Failed" value={summary.failed} />
          <Stat label="Pending" value={summary.pending} />
        </div>

        {Object.keys(memory).length > 0 && (
          <div className="px-4 py-3 border-t border-orion-hairline">
            <h3 className="text-xs font-medium text-muted-foreground mb-2">Shared memory</h3>
            <pre className="text-[10px] font-mono text-muted-foreground overflow-auto max-h-36">
              {JSON.stringify(memory, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: AgentMetrics['status'] }) {
  const config = {
    idle: { text: 'text-muted-foreground', label: 'Idle' },
    running: { text: 'text-orion-ink', label: 'Running' },
    completed: { text: 'text-emerald-400/90', label: 'Done' },
    error: { text: 'text-red-400/90', label: 'Error' },
  };
  const { text, label } = config[status];

  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium ${text}`}>
      {status === 'running' && <Loader2 className="w-3 h-3 animate-spin" />}
      {status === 'completed' && <CheckCircle className="w-3 h-3" />}
      {status === 'error' && <XCircle className="w-3 h-3" />}
      {label}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground/80">{label}</p>
      <p className="font-mono text-foreground tabular-nums truncate">{value}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <p className="text-sm font-semibold tabular-nums text-foreground">{value}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}

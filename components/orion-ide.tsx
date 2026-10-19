'use client';

import { ChangeEvent, useEffect, useRef, useState } from 'react';
import { Plan, ExecutionState } from '@/lib/orion';
import { motion, AnimatePresence } from 'framer-motion';
import { AgentDashboard } from '@/components/ide/agent-dashboard';
import { ArtifactWorkspace } from '@/components/ide/artifact-workspace';
import { ErrorBoundary } from '@/components/error-boundary';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { FileText, Loader2, Paperclip, Square, Play, X } from 'lucide-react';
import Link from 'next/link';
import {
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_TOTAL_BYTES,
} from '@/lib/orion/rag';

type Priority = 'speed' | 'quality' | 'cost' | 'balanced';

interface IDEState {
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
  loading: boolean;
  error: string | null;
  taskResults?: Record<string, any>;
  artifacts?: Record<string, any>;
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
  streamStatus: string;
}

const INITIAL_STATE: IDEState = {
  plan: null,
  state: {
    currentPlanId: '',
    currentTaskId: '',
    runningAgents: [],
    completedTasks: [],
    failedTasks: [],
    lastUpdate: '',
  },
  summary: {
    totalTasks: 0,
    completed: 0,
    failed: 0,
    pending: 0,
    inProgress: 0,
  },
  memory: {},
  loading: false,
  error: null,
  streamStatus: '',
};

const PRIORITIES: { id: Priority; label: string }[] = [
  { id: 'balanced', label: 'Balanced' },
  { id: 'quality', label: 'Quality' },
  { id: 'speed', label: 'Speed' },
  { id: 'cost', label: 'Cost' },
];

const PROMPT_CHIPS = [
  {
    label: 'SaaS landing page',
    prompt:
      'Build a polished Next.js SaaS landing page with pricing, testimonials, and a contact form. Use clean typography and a restrained dark theme.',
  },
  {
    label: 'Market research brief',
    prompt:
      'Research leading AI developer tools, summarize strengths and gaps, and propose a differentiation strategy for a new entrant.',
  },
  {
    label: 'Python data scraper',
    prompt:
      'Write a production-minded Python scraper that fetches public market index pages, handles rate limits, and exports cleaned CSV.',
  },
];

export function OrionIDE() {
  const [ideState, setIdeState] = useState<IDEState>(INITIAL_STATE);
  const [objective, setObjective] = useState('');
  const [priority, setPriority] = useState<Priority>('balanced');
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  function handleStop() {
    abortRef.current?.abort();
    setIdeState((prev) => ({
      ...prev,
      loading: false,
      streamStatus: '',
    }));
  }

  function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const additions = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (additions.length === 0) return;

    const invalid = additions.find((file) => !/\.(pdf|docx)$/i.test(file.name));
    if (invalid) {
      setIdeState((prev) => ({
        ...prev,
        error: `${invalid.name}: only PDF and DOCX Word files are supported.`,
      }));
      return;
    }
    const oversized = additions.find((file) => file.size > MAX_UPLOAD_FILE_BYTES);
    if (oversized) {
      setIdeState((prev) => ({ ...prev, error: `${oversized.name} exceeds the 5 MB file limit.` }));
      return;
    }
    if (uploadedFiles.length + additions.length > MAX_UPLOAD_FILES) {
      setIdeState((prev) => ({
        ...prev,
        error: `Upload no more than ${MAX_UPLOAD_FILES} files per run.`,
      }));
      return;
    }
    const nextFiles = [...uploadedFiles, ...additions];
    if (nextFiles.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_TOTAL_BYTES) {
      setIdeState((prev) => ({ ...prev, error: 'The combined upload size must not exceed 15 MB.' }));
      return;
    }

    setUploadedFiles(nextFiles);
    setIdeState((prev) => ({ ...prev, error: null }));
  }

  function removeUploadedFile(index: number) {
    setUploadedFiles((current) => current.filter((_, fileIndex) => fileIndex !== index));
  }

  async function handleCreatePlan(customObjective?: string) {
    const finalObjective = customObjective !== undefined ? customObjective : objective;
    if (!finalObjective.trim()) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIdeState({
      ...INITIAL_STATE,
      loading: true,
      error: null,
      streamStatus: 'Connecting…',
    });

    try {
      const formData = new FormData();
      formData.set('objective', finalObjective);
      formData.set('priority', priority);
      uploadedFiles.forEach((file) => formData.append('files', file, file.name));
      const response = await fetch('/api/orion/execute', {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Failed to execute plan' }));
        throw new Error(err.error || `HTTP ${response.status}`);
      }

      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const messages = buffer.split('\n\n');
        buffer = messages.pop() ?? '';

        for (const message of messages) {
          if (!message.trim()) continue;

          const lines = message.split('\n');
          let eventType = 'message';
          let dataLine = '';

          for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            if (line.startsWith('data: ')) dataLine = line.slice(6);
          }

          if (!dataLine) continue;

          try {
            const data = JSON.parse(dataLine);
            handleStreamEvent(eventType, data);
          } catch {
            // skip malformed frame
          }
        }
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') return;
      setIdeState((prev) => ({
        ...prev,
        loading: false,
        streamStatus: '',
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  }

  function handleStreamEvent(event: string, data: any) {
    switch (event) {
      case 'connected':
        setIdeState((prev) => ({ ...prev, streamStatus: 'Planning…' }));
        break;

      case 'planning':
        setIdeState((prev) => ({ ...prev, streamStatus: 'Creating plan…' }));
        break;

      case 'plan_created':
        setIdeState((prev) => ({
          ...prev,
          plan: data,
          streamStatus: 'Executing tasks…',
        }));
        break;

      case 'wave_start':
        setIdeState((prev) => ({
          ...prev,
          streamStatus: `Wave ${data.waveNumber}/${data.totalWaves}`,
        }));
        break;

      case 'task_start':
        setIdeState((prev) => ({
          ...prev,
          streamStatus: data.description ?? data.taskId,
          plan: prev.plan
            ? {
                ...prev.plan,
                tasks: prev.plan.tasks.map((t) =>
                  t.id === data.taskId ? { ...t, status: 'in_progress' as const } : t,
                ),
              }
            : prev.plan,
        }));
        break;

      case 'task_complete':
        setIdeState((prev) => ({
          ...prev,
          streamStatus: `Done · ${data.taskId}`,
          plan: prev.plan
            ? {
                ...prev.plan,
                tasks: prev.plan.tasks.map((t) =>
                  t.id === data.taskId
                    ? { ...t, status: 'completed' as const, result: data.result, metadata: data.metadata }
                    : t,
                ),
              }
            : prev.plan,
          summary: {
            ...prev.summary,
            completed: prev.summary.completed + 1,
            pending: Math.max(0, prev.summary.pending - 1),
          },
        }));
        break;

      case 'task_failed':
        setIdeState((prev) => ({
          ...prev,
          plan: prev.plan
            ? {
                ...prev.plan,
                tasks: prev.plan.tasks.map((t) =>
                  t.id === data.taskId ? { ...t, status: 'failed' as const, result: data.error } : t,
                ),
              }
            : prev.plan,
          summary: {
            ...prev.summary,
            failed: prev.summary.failed + 1,
            pending: Math.max(0, prev.summary.pending - 1),
          },
        }));
        break;

      case 'complete':
        setIdeState((prev) => ({ ...prev, streamStatus: 'Finalizing…' }));
        break;

      case 'result':
        setIdeState((prev) => ({
          ...prev,
          loading: false,
          streamStatus: '',
          plan: data.plan ?? prev.plan,
          state: data.executionState ?? prev.state,
          summary: data.summary ?? prev.summary,
          taskResults: data.taskResults,
          artifacts: data.artifacts,
          metrics: data.metrics,
        }));
        break;

      case 'error':
        setIdeState((prev) => ({
          ...prev,
          loading: false,
          streamStatus: '',
          error: data.error ?? 'An unknown error occurred',
        }));
        break;
    }
  }

  const completionPct = Math.round(
    ((ideState.summary.completed + ideState.summary.failed) / (ideState.summary.totalTasks || 1)) * 100,
  );
  const hasPlan = Boolean(ideState.plan);

  return (
    <div className="min-h-screen bg-orion-surface text-foreground flex flex-col overflow-hidden">
      {hasPlan && (
        <header className="h-14 shrink-0 border-b border-orion-hairline bg-orion-elevated/80 backdrop-blur-sm flex items-center gap-4 px-4 z-50">
          <div className="flex items-center gap-2.5 shrink-0">
            <span className="font-display text-lg font-bold tracking-tight text-orion-paper">ORION</span>
            <span className="hidden sm:inline text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-medium">
              Console
            </span>
            <Link
              href="/evaluate"
              className="ml-2 hidden sm:inline text-xs text-muted-foreground hover:text-orion-ink"
            >
              Model eval
            </Link>
          </div>

          <div className="flex-1 flex items-center gap-2 min-w-0 max-w-3xl">
            <input
              type="text"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !ideState.loading && handleCreatePlan()}
              placeholder={ideState.loading ? ideState.streamStatus || 'Running…' : 'New objective…'}
              className="flex-1 min-w-0 h-9 px-3 rounded-md bg-orion-surface border border-orion-hairline text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:border-orion-ink/50 focus:ring-1 focus:ring-orion-ink/30"
              disabled={ideState.loading}
            />
            {ideState.loading ? (
              <button
                type="button"
                onClick={handleStop}
                className="h-9 px-3 rounded-md border border-orion-hairline text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/60 flex items-center gap-1.5 shrink-0"
              >
                <Square className="w-3.5 h-3.5" />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => handleCreatePlan()}
                disabled={!objective.trim()}
                className="h-9 px-3.5 rounded-md bg-orion-ink text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5 shrink-0"
              >
                <Play className="w-3.5 h-3.5" />
                Run
              </button>
            )}
          </div>

          <div className="hidden md:flex items-center gap-3 text-xs font-mono text-muted-foreground shrink-0">
            {ideState.loading && ideState.streamStatus && (
              <span className="text-orion-ink max-w-[160px] truncate">{ideState.streamStatus}</span>
            )}
            <span>
              {ideState.summary.completed}/{ideState.summary.totalTasks || 0}
            </span>
            <span className="tabular-nums text-orion-paper">{completionPct}%</span>
          </div>
        </header>
      )}

      <AnimatePresence>
        {ideState.error && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-b border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-red-200 flex items-center gap-3"
          >
            <span className="flex-1">{ideState.error}</span>
            <button
              type="button"
              onClick={() => setIdeState((p) => ({ ...p, error: null }))}
              className="p-1 rounded hover:bg-destructive/20 text-red-300"
              aria-label="Dismiss error"
            >
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 min-h-0 flex flex-col">
        {!hasPlan ? (
          <div className="flex-1 orion-atmosphere orion-grain relative overflow-y-auto">
            <div className="relative z-10 min-h-full flex flex-col items-center justify-center px-6 py-16">
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                className="w-full max-w-xl space-y-10"
              >
                <div className="space-y-3 text-center sm:text-left">
                  <p className="font-display text-5xl sm:text-6xl font-bold tracking-tight text-orion-paper">
                    ORION
                  </p>
                  <p className="text-muted-foreground text-base leading-relaxed max-w-md">
                    Multi-agent console. Plan an objective, stream specialized agents, export the
                    workspace.
                  </p>
                  <Link
                    href="/evaluate"
                    className="inline-flex text-sm text-orion-ink underline-offset-4 hover:underline"
                  >
                    Compare AI models →
                  </Link>
                </div>

                <div className="space-y-4">
                  <textarea
                    rows={5}
                    value={objective}
                    onChange={(e) => setObjective(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleCreatePlan();
                    }}
                    placeholder="Describe what you want built or researched…"
                    className="w-full resize-none rounded-lg bg-orion-elevated/90 border border-orion-hairline px-4 py-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-orion-ink/45 focus:ring-1 focus:ring-orion-ink/25"
                    disabled={ideState.loading}
                  />

                  <div className="space-y-2">
                    <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-orion-hairline bg-orion-elevated/70 px-3 text-xs text-muted-foreground hover:text-orion-ink">
                      <Paperclip className="h-3.5 w-3.5" />
                      Add PDF or Word document
                      <input
                        type="file"
                        accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        multiple
                        onChange={handleFileSelection}
                        disabled={ideState.loading || uploadedFiles.length >= MAX_UPLOAD_FILES}
                        className="sr-only"
                        aria-label="Upload PDF or DOCX documents"
                      />
                    </label>
                    {uploadedFiles.length > 0 && (
                      <ul className="space-y-1.5">
                        {uploadedFiles.map((file, index) => (
                          <li
                            key={`${file.name}-${file.lastModified}-${index}`}
                            className="flex items-center gap-2 rounded-md border border-orion-hairline bg-orion-elevated/50 px-2.5 py-2 text-xs"
                          >
                            <FileText className="h-3.5 w-3.5 shrink-0 text-orion-ink" />
                            <span className="min-w-0 flex-1 truncate">{file.name}</span>
                            <span className="shrink-0 text-muted-foreground">
                              {(file.size / (1024 * 1024)).toFixed(2)} MB
                            </span>
                            <button
                              type="button"
                              onClick={() => removeUploadedFile(index)}
                              disabled={ideState.loading}
                              className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
                              aria-label={`Remove ${file.name}`}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="text-[11px] leading-5 text-muted-foreground/80">
                      Up to 5 PDF/DOCX files, 5 MB each (15 MB total). Text is indexed in memory
                      for this run only; extracted text is sent to OpenRouter for embeddings and AI responses.
                    </p>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
                    <div
                      className="inline-flex rounded-md border border-orion-hairline bg-orion-elevated/60 p-0.5"
                      role="group"
                      aria-label="Execution priority"
                    >
                      {PRIORITIES.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setPriority(p.id)}
                          disabled={ideState.loading}
                          className={`px-2.5 py-1.5 text-xs font-medium rounded-[5px] transition-colors ${
                            priority === p.id
                              ? 'bg-orion-ink/20 text-orion-ink'
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center gap-3 justify-between sm:justify-end">
                      <p className="text-[11px] text-muted-foreground/80">
                        <kbd className="font-mono text-[10px] px-1 py-0.5 rounded bg-secondary/80 border border-orion-hairline">
                          Ctrl
                        </kbd>
                        +
                        <kbd className="font-mono text-[10px] px-1 py-0.5 rounded bg-secondary/80 border border-orion-hairline">
                          Enter
                        </kbd>
                      </p>
                      <button
                        type="button"
                        onClick={() => handleCreatePlan()}
                        disabled={ideState.loading || !objective.trim()}
                        className="h-10 px-5 rounded-md bg-orion-ink text-primary-foreground text-sm font-semibold hover:opacity-90 disabled:opacity-40 flex items-center gap-2"
                      >
                        {ideState.loading ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            {ideState.streamStatus || 'Running…'}
                          </>
                        ) : (
                          <>
                            <Play className="w-4 h-4" />
                            Run
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/70">
                    Try
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {PROMPT_CHIPS.map((chip) => (
                      <button
                        key={chip.label}
                        type="button"
                        onClick={() => setObjective(chip.prompt)}
                        className="text-sm text-muted-foreground hover:text-orion-ink transition-colors underline-offset-4 hover:underline"
                      >
                        {chip.label}
                      </button>
                    ))}
                  </div>
                </div>
              </motion.div>
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0">
            <Group orientation="horizontal" className="h-full" defaultLayout={{ agents: 34, artifacts: 66 }}>
              <Panel id="agents" defaultSize={34} minSize={22} className="min-w-0">
                <ErrorBoundary>
                  <AgentDashboard
                    plan={ideState.plan}
                    state={ideState.state}
                    summary={ideState.summary}
                    memory={ideState.memory}
                    taskResults={ideState.taskResults}
                    metrics={ideState.metrics}
                  />
                </ErrorBoundary>
              </Panel>
              <Separator className="w-px bg-orion-hairline data-[resize-handle-active]:bg-orion-ink/60 outline-none" />
              <Panel id="artifacts" defaultSize={66} minSize={40} className="min-w-0">
                <ErrorBoundary>
                  <ArtifactWorkspace
                    plan={ideState.plan}
                    artifacts={ideState.artifacts}
                    taskResults={ideState.taskResults}
                  />
                </ErrorBoundary>
              </Panel>
            </Group>
          </div>
        )}
      </div>
    </div>
  );
}

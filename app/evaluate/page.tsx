'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, FlaskConical, Loader2 } from 'lucide-react';
import type { AgentRole } from '@/lib/orion';
import type { ModelEvaluation } from '@/lib/orion';

interface EvaluationModelOption {
  id: string;
  tier: string;
  promptPrice: number;
  completionPrice: number;
}

const ROLES: { id: AgentRole; label: string }[] = [
  { id: 'planner', label: 'Planner' },
  { id: 'engineering', label: 'Engineering' },
  { id: 'research', label: 'Research' },
  { id: 'marketing', label: 'Marketing' },
];

const DEFAULT_MODEL_ORDER = [
  'google/gemini-2.5-flash',
  'deepseek/deepseek-chat',
  'openai/gpt-4.1-mini',
  'qwen/qwen3-coder',
  'openai/gpt-4.1',
  'anthropic/claude-haiku-4.5',
  'deepseek/deepseek-r1',
];

export default function EvaluatePage() {
  const [role, setRole] = useState<AgentRole>('research');
  const [objective, setObjective] = useState('');
  const [models, setModels] = useState<EvaluationModelOption[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [result, setResult] = useState<ModelEvaluation | null>(null);
  const [loadingModels, setLoadingModels] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingModels(true);
    setError(null);
    setSelectedModels([]);
    setResult(null);

    fetch(`/api/orion/evaluate?role=${role}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not load available models.');
        return body.models as EvaluationModelOption[];
      })
      .then((availableModels) => {
        setModels(availableModels);
        const prioritized = DEFAULT_MODEL_ORDER
          .map((id) => availableModels.find((model) => model.id === id))
          .filter((model): model is EvaluationModelOption => model != null);
        setSelectedModels(prioritized.slice(0, 3).map((model) => model.id));
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof Error && fetchError.name === 'AbortError') return;
        setError(fetchError instanceof Error ? fetchError.message : 'Could not load models.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingModels(false);
      });

    return () => controller.abort();
  }, [role]);

  const orderedCandidates = useMemo(
    () => [...(result?.candidates ?? [])].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)),
    [result],
  );

  function toggleModel(modelId: string) {
    setSelectedModels((current) =>
      current.includes(modelId)
        ? current.filter((model) => model !== modelId)
        : current.length < 3
          ? [...current, modelId]
          : current,
    );
  }

  async function runEvaluation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRunning(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch('/api/orion/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, objective, models: selectedModels }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Model evaluation failed.');
      setResult(body as ModelEvaluation);
    } catch (runError: unknown) {
      setError(runError instanceof Error ? runError.message : 'Model evaluation failed.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="min-h-screen bg-orion-surface text-foreground">
      <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-orion-ink"
        >
          <ArrowLeft className="h-4 w-4" />
          Orion console
        </Link>

        <header className="mt-8 max-w-2xl">
          <div className="flex items-center gap-3">
            <FlaskConical className="h-6 w-6 text-orion-ink" />
            <h1 className="font-display text-3xl font-semibold text-orion-paper">
              Model evaluation
            </h1>
          </div>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Send the same task to 2–3 models, then compare their speed, token use, cost, and
            rubric-based scores from an independent evaluator.
          </p>
        </header>

        <form
          onSubmit={runEvaluation}
          className="mt-8 space-y-6 rounded-xl border border-orion-hairline bg-orion-elevated/50 p-5 sm:p-6"
        >
          <label className="block space-y-2">
            <span className="text-sm font-medium">Agent role</span>
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as AgentRole)}
              disabled={running}
              className="h-10 w-full rounded-md border border-orion-hairline bg-orion-surface px-3 text-sm focus:outline-none focus:ring-1 focus:ring-orion-ink/50"
            >
              {ROLES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-2">
            <span className="text-sm font-medium">Evaluation task</span>
            <textarea
              rows={4}
              minLength={10}
              maxLength={2000}
              required
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              disabled={running}
              placeholder="Enter one realistic task for these models to complete..."
              className="w-full resize-y rounded-md border border-orion-hairline bg-orion-surface px-3 py-2.5 text-sm leading-6 placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-orion-ink/50"
            />
          </label>

          <fieldset className="space-y-3" disabled={loadingModels || running}>
            <legend className="text-sm font-medium">
              Models <span className="text-muted-foreground">({selectedModels.length}/3 selected)</span>
            </legend>
            {loadingModels ? (
              <p className="text-sm text-muted-foreground">Loading model catalog…</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {models.map((model) => {
                  const checked = selectedModels.includes(model.id);
                  const disabled = !checked && selectedModels.length >= 3;
                  return (
                    <label
                      key={model.id}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                        checked
                          ? 'border-orion-ink/50 bg-orion-ink/5'
                          : 'border-orion-hairline bg-orion-surface'
                      } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleModel(model.id)}
                        className="mt-1 accent-[var(--orion-ink)]"
                      />
                      <span className="min-w-0">
                        <span className="block break-all text-sm font-medium">{model.id}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {model.tier} · ${model.promptPrice}/${model.completionPrice} per 1M tokens
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-xl text-xs leading-5 text-muted-foreground">
              Uses OpenRouter credits for each selected model and one evaluator-model request.
              Scores are comparative AI-judge estimates, not verified ground truth.
            </p>
            <button
              type="submit"
              disabled={running || loadingModels || selectedModels.length < 2 || objective.trim().length < 10}
              className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md bg-orion-ink px-4 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
              {running ? 'Evaluating…' : 'Compare models'}
            </button>
          </div>
        </form>

        {error && (
          <div role="alert" className="mt-5 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {result && (
          <section className="mt-8 space-y-4" aria-live="polite">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold text-orion-paper">Comparison results</h2>
              <p className="text-xs text-muted-foreground">
                Judge: {result.judgeModel} · Estimated total cost: $
                {result.totalEstimatedCost.toFixed(6)}
              </p>
            </div>
            {orderedCandidates.map((candidate, index) => (
              <article
                key={`${candidate.model}-${index}`}
                className="rounded-xl border border-orion-hairline bg-orion-elevated/40 p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="break-all font-mono text-sm font-semibold">{candidate.model}</h3>
                    {candidate.modelUsed && candidate.modelUsed !== candidate.model && (
                      <p className="mt-1 text-xs text-amber-200">
                        Provider fallback used: {candidate.modelUsed}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {candidate.latencyMs.toLocaleString()} ms · {candidate.tokens.toLocaleString()}
                      {candidate.tokensEstimated ? ' estimated' : ''} tokens · estimated $
                      {candidate.estimatedCost.toFixed(6)}
                    </p>
                  </div>
                  {candidate.score != null && (
                    <div className="text-right">
                      <span className="font-mono text-2xl font-semibold text-orion-ink">
                        {candidate.score.toFixed(2)}
                      </span>
                      <span className="text-xs text-muted-foreground"> / 10</span>
                      {index === 0 && <p className="text-[10px] uppercase tracking-wider text-orion-ink">Highest score</p>}
                    </div>
                  )}
                </div>
                {candidate.error ? (
                  <p className="mt-4 text-sm text-red-300">Model request failed: {candidate.error}</p>
                ) : (
                  <>
                    {candidate.dimensions && (
                      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                        {Object.entries(candidate.dimensions).map(([label, score]) => (
                          <div key={label} className="rounded-md bg-orion-surface/70 p-2">
                            <p className="text-[11px] capitalize text-muted-foreground">
                              {label.replace(/([A-Z])/g, ' $1')}
                            </p>
                            <p className="font-mono text-sm">{score.toFixed(1)} / 10</p>
                          </div>
                        ))}
                      </div>
                    )}
                    {candidate.strengths && (
                      <p className="mt-4 text-sm leading-6">
                        <span className="font-medium text-emerald-300">Strengths: </span>
                        {candidate.strengths}
                      </p>
                    )}
                    {candidate.improvements && (
                      <p className="mt-2 text-sm leading-6">
                        <span className="font-medium text-amber-200">Could improve: </span>
                        {candidate.improvements}
                      </p>
                    )}
                    <details className="mt-4">
                      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                        View model response
                      </summary>
                      <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-orion-surface p-3 text-xs leading-5">
                        {candidate.output}
                      </pre>
                    </details>
                  </>
                )}
              </article>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}

# Orion

**Turn one sentence into a planned multi-agent run — with live progress, generated files, and a previewable workspace.**

Orion is a multi-agent orchestration console. You describe an objective; a planner breaks it into tasks; specialized agents (planner, research, engineering, marketing) run in waves; results stream into a browser IDE where you can browse files, inspect code, preview the UI, and download a ZIP.

> Not a real operating system. Think of it as a **control room for LLM agents** that produces real project artifacts — not another chat box that dumps a wall of text.

---

## Why this project?

Most “AI builders” stop at chat: you get paragraphs of advice or a messy code dump you still have to copy, fix paths, and wire up yourself.

Real work looks different:

| Pain today | What Orion aims to do |
|------------|------------------------|
| One model tries to do research + code + copy | Route work to **specialized agents** |
| You don’t know what’s happening mid-run | **SSE live stream** of plan → tasks → results |
| Model output is unstructured prose | **Artifact engine** turns code fences into a file tree |
| Files land in the wrong folders / empty IDE | Path-aware parsing + empty-VFS warnings |
| Free model slugs randomly 404 | Catalog + router prefer **reliable paid workhorses**; free only on cost mode |

**What it solves in practice:** give Orion an objective like *“Build a landing page for a fintech waitlist in React”* and get a visible plan, agent activity, a structured `src/` tree, live preview, and a downloadable project — without manually babysitting three different ChatGPT tabs.

---

## Who is this for?

- Builders who want a **demo-ready multi-agent pipeline** (planner → workers → artifacts)
- Students / portfolio projects that need something clearer than “wrapper around one LLM”
- Anyone experimenting with **OpenRouter routing**, priorities (quality vs cost), and artifact IDEs

Not for (yet): multi-user auth, persistent DB of past runs, production SaaS tenancy. Those are out of scope for this console.

---

## How it works (simple)

```
You type an objective
        ↓
 Planner agent → task graph (who does what, in what order)
        ↓
 Orchestrator runs waves (research → engineering → marketing)
        ↓
 Each agent talks to OpenRouter (model picked by role + priority)
        ↓
 Research can fetch live URLs when you include them
        ↓
 Engineering output → Artifact Engine (parse → normalize → VFS)
        ↓
 Browser IDE: file tree · code viewer · iframe preview · ZIP export
```

**Shared memory (in-request):** agents pass context (plan, analysis, model used) so engineering can use research instead of starting from zero. One failed research task does not silently poison the whole run — the orchestrator marks failure and continues in a degraded path when possible.

---

## Features

- **Planner + orchestrator** — dependency-aware waves, retries, explicit `task_failed` events
- **Four roles** — planner, research, engineering, marketing
- **Smart model routing** — `balanced` / `quality` / `speed` / `cost` (not “always the free model”)
- **Research web-fetch** — if the objective contains URLs, snippets are injected; otherwise analysis is labeled model-only
- **Artifact IDE** — path-tagged code fences → virtual filesystem → preview + ZIP
- **Honest confidence** — blends router confidence with success / output length (not fake 99% every time)
- **Tests + CI** — Vitest unit tests and GitHub Actions (`typecheck` + `test`)

---

## Reference 

<img width="563" height="410" alt="image" src="https://github.com/user-attachments/assets/4b9ec427-ee6c-4c68-b0d0-72a8fb04d8a6" />


## Quick start

### Requirements

- **Node.js 20+** (22 recommended)
- An **[OpenRouter](https://openrouter.ai/keys)** API key with credit for the models you use

### 1. Install

```bash
git clone https://github.com/advay77/Orion-V2.git
cd Orion-V2
npm install
```

### 2. Environment

Create a `.env` file in the project root (never commit this):

```env
OPENROUTER_API_KEY=sk-or-your-key-here
```

Optional model overrides (defaults are paid workhorses):

```env
PLANNER_MODEL=deepseek/deepseek-chat
ENGINEERING_MODEL=deepseek/deepseek-chat
RESEARCH_MODEL=google/gemini-2.5-flash
MARKETING_MODEL=google/gemini-2.5-flash
```

Do **not** set retired `:free` slugs (many return OpenRouter `404`). Free models are only for **cost** priority / last resort inside the catalog.

### 3. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

1. Write a clear objective  
2. Pick a priority (`balanced` is the usual default)  
3. Hit run and watch the agent console + workspace fill in  

### Production-ish build

```bash
npm run build
npm start
```

---

## Model routing (what gets picked)

Orion does **not** hardcode one model for everything. The router scores specialty fit, quality, speed, and cost:

| Priority | Intent |
|----------|--------|
| `balanced` | Best task-fit without overpaying |
| `quality` | Prefer flagships (e.g. Claude Sonnet, DeepSeek R1 for research) |
| `speed` | Prefer fast / Flash-class models |
| `cost` | Prefer cheap / budget (may include `:free` as last resort) |

Typical **balanced** defaults:

| Role | Default idea | Why |
|------|----------------|-----|
| Planner | `deepseek/deepseek-chat` | Solid planning, affordable |
| Engineering | `deepseek/deepseek-chat` (+ Claude / GPT in catalog) | Code quality vs $ |
| Research | `google/gemini-2.5-flash` | Reliable; R1 on **quality** |
| Marketing | `google/gemini-2.5-flash` | Fast copy |

Catalog: [`lib/orion/model-config.ts`](lib/orion/model-config.ts) · Router: [`lib/orion/model-router.ts`](lib/orion/model-router.ts)

---

## Project map (where to look)

```
app/                  Next.js App Router (page + API)
  api/orion/execute   Main run endpoint (SSE stream)
components/           Orion IDE UI (panels, editor, preview)
lib/orion/            Brain of the system
  agents/             Planner, research, engineering, marketing
  artifact-engine/    Parse fences → files → validate → preview
  tools/web-fetch.ts  URL fetch for research
  orchestrator.ts     Waves, retries, metadata
  model-router.ts     Priority-aware model selection
```

---

## API (for hackers)

| Route | Purpose |
|-------|---------|
| `POST /api/orion/execute` | Run an objective; streams SSE (`planning`, `plan_created`, `task_*`, `result`, …) |
| `GET/POST /api/orion/plan` | Plan helpers |
| `GET /api/orion/state` | Snapshot of execution state |

Execute is rate-limited per IP (see [`proxy.ts`](proxy.ts)). Errors return a consistent shape: `{ error, code, retryAfter? }`.

---

## Scripts

```bash
npm run dev          # local development
npm run build        # production build
npm start            # serve production build
npm run typecheck    # TypeScript
npm test             # Vitest unit tests
npm run test:watch   # watch mode
npm run lint         # ESLint
```

CI (on `main` push/PR): typecheck + test via [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

---

## FAQ — doubts people usually have

**Is this an AI operating system?**  
No. The name is aspirational. It’s an **agent orchestration console + artifact IDE**.

**Do I need accounts for OpenAI / Anthropic / Google separately?**  
No. Everything goes through **OpenRouter** with one key. You still pay OpenRouter for the models you call.

**Will it always generate a full working app?**  
It tries. Quality depends on the model, objective clarity, and framework. Prefer concrete objectives (“React + Tailwind waitlist page with email form”) over vague ones (“build a startup”).

**Why did research fail / 404 before?**  
Old free R1 slugs (`…:free`) were retired on OpenRouter. Orion now defaults research to Gemini Flash and excludes free models from balanced/quality/speed pools.

**Why is the file tree empty after a “successful” run?**  
Usually the model returned prose without path-tagged fences. Orion surfaces a validation warning instead of silently showing an empty IDE. Better prompts / quality priority help.

**Can agents see each other’s work?**  
Yes, via **shared memory for that request** (plan, project analysis, usage, model used). Nothing is persisted to a database between browser refreshes.

**Is my API key safe?**  
Keep it in `.env` locally. Don’t commit `.env`. Don’t paste the key into the public UI or GitHub issues.

**Does research browse the real web?**  
If your objective (or target) includes `http(s)` URLs, Orion fetches capped text snippets and feeds them into the research prompt. No URL → clearly model-only analysis. This is not a full search engine crawler.

**What about auth / saving projects / multi-user?**  
Not in this version. Great follow-ups; not required for the local demo loop.

**Something broke on `npm install` / `Cannot find module next`?**  
Delete `node_modules`, reinstall (`npm install`), and restart `npm run dev`.

---

## Troubleshooting

| Problem | What to check |
|---------|---------------|
| `OPENROUTER_API_KEY is not set` or OpenRouter returns 401 | Set a valid `OPENROUTER_API_KEY` in the project-root `.env`, then restart the dev server. |
| Model unavailable or request returns 400 | Use a currently supported OpenRouter model ID in the model override, or try `openrouter/auto`. |
| Rate limit 429 | Wait before retrying; the execute API is rate-limited per IP. |
| `Cannot find module next` after installation | Remove `node_modules`, run `npm install`, and restart `npm run dev`. |
| Port 3000 is already in use | Stop the other process using that port or use the alternate port reported by Next.js. |

---

## Honest limits

- No login, no multi-tenant storage  
- Generated code is **not** run through a full sandbox lint/test loop  
- Preview quality depends on what the model emitted into the VFS  
- Cost scales with model priority and task count — watch your OpenRouter usage  

---

## Deeper docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system layout  

---

## License / credit

Built as a portfolio-grade multi-agent console on Next.js + OpenRouter.  
If you fork it, keep the README honest: this is an **orchestration demo**, not a shipped OS.

/**
 * Orion model catalog — task-fit first, not open-source-only.
 * IDs are OpenRouter slugs. Env overrides still win via AGENT_MODELS / *_MODEL.
 */

export type AgentRole = 'planner' | 'engineering' | 'research' | 'marketing';

export interface CatalogModel {
  id: string;
  specialties: AgentRole[];
  capability: number;
  quality: number;
  speed: number;
  promptPrice: number;
  completionPrice: number;
  contextWindow: number;
  maxTokens: number;
  temperature: number;
  tier: 'flagship' | 'workhorse' | 'fast' | 'budget';
}

/**
 * Curated pool: best-in-class for coding / reasoning / writing.
 * Budget `:free` entries exist only for priority=cost / last-resort — never
 * as balanced defaults (OpenRouter has retired many free slugs → 404).
 */
export const MODEL_CATALOG: CatalogModel[] = [
  // ── Engineering / coding ──────────────────────────────────────────
  {
    id: 'deepseek/deepseek-chat',
    specialties: ['engineering', 'planner', 'marketing', 'research'],
    capability: 9,
    quality: 9,
    speed: 7,
    promptPrice: 0.14,
    completionPrice: 0.28,
    contextWindow: 128000,
    maxTokens: 4096,
    temperature: 0.2,
    tier: 'workhorse',
  },
  {
    id: 'qwen/qwen3-coder',
    specialties: ['engineering'],
    capability: 9,
    quality: 9,
    speed: 6,
    promptPrice: 0.2,
    completionPrice: 0.8,
    contextWindow: 128000,
    maxTokens: 4096,
    temperature: 0.2,
    tier: 'workhorse',
  },
  {
    id: 'anthropic/claude-sonnet-4',
    specialties: ['engineering', 'planner', 'research'],
    capability: 10,
    quality: 10,
    speed: 6,
    promptPrice: 3,
    completionPrice: 15,
    contextWindow: 200000,
    maxTokens: 4096,
    temperature: 0.2,
    tier: 'flagship',
  },
  {
    id: 'openai/gpt-4.1',
    specialties: ['engineering', 'planner', 'marketing'],
    capability: 9,
    quality: 9,
    speed: 6,
    promptPrice: 2,
    completionPrice: 8,
    contextWindow: 128000,
    maxTokens: 4096,
    temperature: 0.25,
    tier: 'flagship',
  },

  // ── Reasoning / research ──────────────────────────────────────────
  {
    id: 'google/gemini-2.5-pro',
    specialties: ['engineering', 'research', 'planner'],
    capability: 9,
    quality: 9,
    speed: 6,
    promptPrice: 1.25,
    completionPrice: 10,
    contextWindow: 1000000,
    maxTokens: 4096,
    temperature: 0.3,
    tier: 'workhorse',
  },
  {
    id: 'deepseek/deepseek-r1',
    specialties: ['research', 'planner'],
    capability: 10,
    quality: 10,
    speed: 4,
    promptPrice: 0.55,
    completionPrice: 2.19,
    contextWindow: 128000,
    maxTokens: 4096,
    temperature: 0.3,
    tier: 'flagship',
  },
  {
    id: 'openai/o4-mini',
    specialties: ['research', 'planner'],
    capability: 9,
    quality: 9,
    speed: 7,
    promptPrice: 1.1,
    completionPrice: 4.4,
    contextWindow: 200000,
    maxTokens: 4096,
    temperature: 0.3,
    tier: 'workhorse',
  },

  // ── Writing / marketing + fast paths ──────────────────────────────
  {
    id: 'google/gemini-2.5-flash',
    specialties: ['marketing', 'research', 'planner'],
    capability: 8,
    quality: 8,
    speed: 10,
    promptPrice: 0.15,
    completionPrice: 0.6,
    contextWindow: 1000000,
    maxTokens: 3072,
    temperature: 0.5,
    tier: 'fast',
  },
  {
    id: 'openai/gpt-4.1-mini',
    specialties: ['marketing', 'research'],
    capability: 8,
    quality: 8,
    speed: 9,
    promptPrice: 0.4,
    completionPrice: 1.6,
    contextWindow: 128000,
    maxTokens: 3072,
    temperature: 0.5,
    tier: 'fast',
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    specialties: ['marketing', 'planner'],
    capability: 8,
    quality: 8,
    speed: 9,
    promptPrice: 1,
    completionPrice: 5,
    contextWindow: 200000,
    maxTokens: 3072,
    temperature: 0.5,
    tier: 'fast',
  },

  // ── Budget only (priority=cost / last resort) — no research specialty on dead free R1 ──
  {
    id: 'deepseek/deepseek-chat-v3.1:free',
    specialties: ['engineering', 'planner', 'marketing'],
    capability: 7,
    quality: 7,
    speed: 6,
    promptPrice: 0,
    completionPrice: 0,
    contextWindow: 64000,
    maxTokens: 4096,
    temperature: 0.3,
    tier: 'budget',
  },
  {
    id: 'openrouter/auto',
    specialties: ['engineering', 'research', 'marketing', 'planner'],
    capability: 8,
    quality: 8,
    speed: 7,
    promptPrice: 0.5,
    completionPrice: 1.5,
    contextWindow: 200000,
    maxTokens: 3072,
    temperature: 0.4,
    tier: 'budget',
  },
];

/**
 * Defaults when env is unset — paid workhorses only.
 * Research uses Gemini Flash (reliable + cheap); R1 is quality-priority via router.
 */
export const AGENT_MODELS = {
  planner: 'deepseek/deepseek-chat',
  engineering: 'deepseek/deepseek-chat',
  research: 'google/gemini-2.5-flash',
  marketing: 'google/gemini-2.5-flash',
} as const;

export type AgentModelType = keyof typeof AGENT_MODELS;

export function getAgentModel(agent: AgentModelType): string {
  return AGENT_MODELS[agent];
}

export function getCatalogEntry(modelId: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((m) => m.id === modelId);
}

export const MODEL_DESCRIPTIONS: Record<string, string> = Object.fromEntries(
  MODEL_CATALOG.map((m) => [
    m.id,
    `${m.id} · ${m.tier} · q${m.quality}/c${m.capability}/s${m.speed} · $${m.promptPrice}/$${m.completionPrice} per 1M`,
  ]),
);

/** @deprecated use MODEL_CATALOG */
export const MODEL_CONFIG = {
  DEEPSEEK_CHAT: 'deepseek/deepseek-chat',
  DEEPSEEK_R1: 'deepseek/deepseek-r1',
  CLAUDE_SONNET: 'anthropic/claude-sonnet-4',
  GPT_4_1: 'openai/gpt-4.1',
  GEMINI_FLASH: 'google/gemini-2.5-flash',
  GEMINI_PRO: 'google/gemini-2.5-pro',
  OPENROUTER_AUTO: 'openrouter/auto',
} as const;

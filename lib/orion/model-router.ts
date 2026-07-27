import { OpenRouterClient, normalizeModelSlug } from './openrouter-client';
import { ConfidenceCalculator } from './confidence';
import {
  AGENT_MODELS,
  CatalogModel,
  MODEL_CATALOG,
  AgentRole,
  getCatalogEntry,
} from './model-config';

export interface ModelRanking {
  model: string;
  capability: number;
  quality: number;
  speed: number;
  /** Higher = cheaper (tokens per dollar-ish). Derived from pricing. */
  cost: number;
  contextWindow: number;
  available: boolean;
  promptPrice: number;
  completionPrice: number;
  maxTokens: number;
  temperature: number;
  tier: CatalogModel['tier'];
  specialties: AgentRole[];
}

export interface ModelSelection {
  selectedModel: string;
  fallbackModels: string[];
  reason: string;
  confidence: number;
  estimatedLatency: number;
  estimatedCost: number;
  maxTokens: number;
  temperature: number;
}

export interface RouterConfig {
  agentType: AgentRole;
  taskType?: string;
  priority?: 'speed' | 'quality' | 'cost' | 'balanced';
}

/**
 * Picks the best model for the *job*, not "whatever is free/open-source".
 * Scores specialty fit + quality/capability vs cost, latency, and token budget.
 */
export class ModelRouter {
  private openRouterClient: OpenRouterClient;
  private modelCache: Map<string, ModelRanking> = new Map();

  constructor(openRouterClient: OpenRouterClient) {
    this.openRouterClient = openRouterClient;
    this.initializeModelRankings();
  }

  private initializeModelRankings(): void {
    for (const entry of MODEL_CATALOG) {
      const blended = (entry.promptPrice + entry.completionPrice) / 2;
      // cost score: higher is cheaper (used by legacy rank helpers)
      const costScore = blended <= 0 ? 1_000_000 : Math.round(1_000_000 / Math.max(blended, 0.01));

      this.modelCache.set(entry.id, {
        model: entry.id,
        capability: entry.capability,
        quality: entry.quality,
        speed: entry.speed,
        cost: costScore,
        contextWindow: entry.contextWindow,
        available: true,
        promptPrice: entry.promptPrice,
        completionPrice: entry.completionPrice,
        maxTokens: entry.maxTokens,
        temperature: entry.temperature,
        tier: entry.tier,
        specialties: entry.specialties,
      });
    }
  }

  selectModel(config: RouterConfig): ModelSelection {
    const priority = config.priority || 'balanced';
    const agentType = config.agentType;
    const required = this.getRequiredCapability(agentType, config.taskType);

    const candidates = this.getCandidateModels(agentType, priority).filter(
      (m) => m.available && m.capability >= Math.max(6, required - 2),
    );

    if (candidates.length === 0) {
      const auto = this.modelCache.get('openrouter/auto');
      if (!auto) throw new Error('No available models found');
      return this.toSelection(auto, [], agentType, priority, required);
    }

    const ranked = this.rankModels(candidates, priority, agentType, required);
    const selected = ranked[0];
    const fallbacks = ranked.slice(1, 4).map((m) => m.model);

    return this.toSelection(selected, fallbacks, agentType, priority, required);
  }

  private toSelection(
    selected: ModelRanking,
    fallbacks: string[],
    agentType: AgentRole,
    priority: string,
    required: number,
  ): ModelSelection {
    const confidenceResult = ConfidenceCalculator.calculateRouterConfidence(
      selected.capability,
      required,
      0,
    );

    return {
      selectedModel: normalizeModelSlug(selected.model),
      fallbackModels: fallbacks.map(normalizeModelSlug),
      reason: this.getSelectionReason(agentType, selected, priority),
      confidence: ConfidenceCalculator.normalizeToDecimal(confidenceResult.score),
      estimatedLatency: this.estimateLatency(selected),
      estimatedCost: this.estimateCostPer1k(selected),
      maxTokens: selected.maxTokens,
      temperature: selected.temperature,
    };
  }

  private getRequiredCapability(agentType: string, taskType?: string): number {
    const base: Record<string, number> = {
      engineering: 8,
      research: 9,
      marketing: 7,
      planner: 8,
    };
    let required = base[agentType] || 7;
    if (taskType) {
      const complex = ['architecture', 'system_design', 'research_analysis', 'implementation'];
      if (complex.some((t) => taskType.toLowerCase().includes(t))) {
        required = Math.min(10, required + 1);
      }
    }
    return required;
  }

  private getCandidateModels(agentType: AgentRole, priority: string): ModelRanking[] {
    const all = Array.from(this.modelCache.values());
    const isFreeSlug = (id: string) => id.includes(':free');
    const isBudget = (m: ModelRanking) => m.tier === 'budget' || isFreeSlug(m.model);

    let pool = all.filter((m) => m.specialties.includes(agentType));

    // balanced / quality / speed: NEVER pick free/budget as primary candidates
    if (priority === 'balanced' || priority === 'quality' || priority === 'speed') {
      pool = pool.filter((m) => !isBudget(m) || m.model === 'openrouter/auto');
    }

    if (priority === 'quality') {
      const flagships = all.filter((m) => m.tier === 'flagship' && !isFreeSlug(m.model));
      pool = this.uniqueById([...pool, ...flagships]);
      // Prefer R1 / Sonnet for research quality
      if (agentType === 'research' && this.modelCache.has('deepseek/deepseek-r1')) {
        pool = this.uniqueById([this.modelCache.get('deepseek/deepseek-r1')!, ...pool]);
      }
    }

    if (priority === 'cost') {
      pool = all.filter(
        (m) =>
          m.specialties.includes(agentType) &&
          (m.tier === 'budget' || m.tier === 'workhorse' || m.tier === 'fast'),
      );
    }

    if (priority === 'speed') {
      pool = pool.filter((m) => m.tier === 'fast' || m.tier === 'workhorse');
    }

    const envDefault = AGENT_MODELS[agentType as keyof typeof AGENT_MODELS];
    if (envDefault && this.modelCache.has(envDefault)) {
      pool = this.uniqueById([this.modelCache.get(envDefault)!, ...pool]);
    }

    // openrouter/auto only as soft fallback candidate (last in rank via score)
    if (this.modelCache.has('openrouter/auto')) {
      pool = this.uniqueById([...pool, this.modelCache.get('openrouter/auto')!]);
    }

    // If we filtered everything out, fall back to non-free specialty models
    if (pool.filter((m) => !isFreeSlug(m.model)).length === 0) {
      pool = all.filter((m) => m.specialties.includes(agentType) && !isFreeSlug(m.model));
    }

    return pool.filter(Boolean);
  }

  private uniqueById(models: ModelRanking[]): ModelRanking[] {
    const seen = new Set<string>();
    const out: ModelRanking[] = [];
    for (const m of models) {
      if (!m || seen.has(m.model)) continue;
      seen.add(m.model);
      out.push(m);
    }
    return out;
  }

  /**
   * Higher score wins. Balances specialty, quality, cost, and latency.
   */
  private rankModels(
    models: ModelRanking[],
    priority: string,
    agentType: AgentRole,
    required: number,
  ): ModelRanking[] {
    const scored = models.map((model) => {
      const specialtyBonus = model.specialties.includes(agentType) ? 12 : 0;
      const overkillPenalty =
        model.capability > required + 2 && priority !== 'quality' ? (model.capability - required) * 1.5 : 0;
      const blended = (model.promptPrice + model.completionPrice) / 2;
      const costPenalty = blended * 4; // $ per 1M → score drag
      const tokenBudgetBonus = model.maxTokens <= 4096 ? 2 : model.maxTokens <= 6144 ? 1 : 0;

      let score = 0;
      switch (priority) {
        case 'speed':
          score =
            model.speed * 3 +
            model.quality * 0.8 +
            specialtyBonus -
            costPenalty * 0.3 -
            overkillPenalty +
            tokenBudgetBonus;
          break;
        case 'quality':
          score =
            model.quality * 3 +
            model.capability * 2.5 +
            specialtyBonus -
            costPenalty * 0.15 -
            (model.tier === 'budget' ? 8 : 0);
          break;
        case 'cost':
          score =
            (blended <= 0 ? 40 : 25 / (blended + 0.05)) +
            model.capability * 1.2 +
            model.speed * 0.8 +
            specialtyBonus +
            tokenBudgetBonus -
            (model.tier === 'flagship' ? 10 : 0);
          break;
        case 'balanced':
        default:
          score =
            specialtyBonus +
            model.quality * 1.8 +
            model.capability * 1.5 +
            model.speed * 0.9 -
            costPenalty -
            overkillPenalty +
            tokenBudgetBonus +
            (model.tier === 'workhorse' ? 4 : 0) +
            (model.tier === 'flagship' ? 1 : 0) +
            (model.tier === 'fast' ? 2 : 0) -
            (model.tier === 'budget' || model.model.includes(':free') ? 25 : 0) -
            (model.model === 'openrouter/auto' ? 6 : 0);
          break;
      }

      return { model, score };
    });

    return scored.sort((a, b) => b.score - a.score).map((s) => s.model);
  }

  private getSelectionReason(agentType: string, selected: ModelRanking, priority: string): string {
    const blend = ((selected.promptPrice + selected.completionPrice) / 2).toFixed(2);
    const map: Record<string, string> = {
      speed: `${selected.model} for ${agentType} (speed ${selected.speed}/10, ~$${blend}/1M)`,
      quality: `${selected.model} for ${agentType} (quality ${selected.quality}/10, capability ${selected.capability}/10)`,
      cost: `${selected.model} for ${agentType} (cost-optimized, ~$${blend}/1M blended)`,
      balanced: `${selected.model} for ${agentType} (task-fit ${selected.tier}, q${selected.quality}/c${selected.capability}/s${selected.speed}, ~$${blend}/1M)`,
    };
    return map[priority] || map.balanced;
  }

  private estimateLatency(model: ModelRanking): number {
    return Math.round((120 / Math.max(model.speed, 1)) * 100);
  }

  private estimateCostPer1k(model: ModelRanking): number {
    const blend = (model.promptPrice + model.completionPrice) / 2;
    return (blend / 1000) * 100; // cents per 1k tokens (legacy field)
  }

  async testModelAvailability(model: string): Promise<boolean> {
    try {
      const response = await this.openRouterClient.chat(
        model,
        [{ role: 'user', content: 'ping' }],
        'Respond with only: pong',
        16,
        0,
      );
      return response.content.toLowerCase().includes('pong');
    } catch {
      return false;
    }
  }

  updateModelAvailability(model: string, available: boolean): void {
    const ranking = this.modelCache.get(model);
    if (ranking) ranking.available = available;
  }

  getModelInfo(model: string): ModelRanking | undefined {
    return this.modelCache.get(model);
  }

  getAllModels(): ModelRanking[] {
    return Array.from(this.modelCache.values());
  }

  /** Resolve catalog defaults for a hard-coded override */
  static defaultsFor(modelId: string): Pick<ModelSelection, 'maxTokens' | 'temperature'> {
    const entry = getCatalogEntry(modelId);
    return {
      maxTokens: entry?.maxTokens ?? 3072,
      temperature: entry?.temperature ?? 0.4,
    };
  }
}

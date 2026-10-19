export * from './types';
export * from './shared-memory';
export * from './openrouter-client';
export * from './base-agent';
export * from './planning-engine';
export * from './orchestrator';
export * from './model-config';
export * from './model-router';
export * from './model-evaluator';
export * from './artifact-engine';
export * from './intent-classifier';
export * from './task-templates';
export * from './cost-engine';
export * from './tools/web-fetch';

export { PlannerAgent } from './agents/planner';
export { EngineeringAgent } from './agents/engineering';
export { ResearchAgent } from './agents/research';
export { MarketingAgent } from './agents/marketing';

import { OpenRouterClient, normalizeModelSlug } from './openrouter-client';
import { PlannerAgent } from './agents/planner';
import { EngineeringAgent } from './agents/engineering';
import { ResearchAgent } from './agents/research';
import { MarketingAgent } from './agents/marketing';
import { PlanningEngine } from './planning-engine';
import { Orchestrator } from './orchestrator';
import { SharedMemory } from './shared-memory';
import { AGENT_MODELS } from './model-config';

function resolveModel(envValue: string | undefined, fallback: string): string {
  return normalizeModelSlug(envValue || fallback);
}

/**
 * Creates a fresh Orchestrator per request.
 *
 * NOTE: We deliberately do NOT use a singleton here.
 * A shared singleton would mean concurrent requests from different users
 * share the same PlanningEngine + SharedMemory, causing state corruption.
 */
export function createOrionSystem(): Orchestrator {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY environment variable is not set');
  }

  const openRouterClient = new OpenRouterClient(apiKey);
  const sharedMemory = new SharedMemory();

  const plannerAgent = new PlannerAgent(
    openRouterClient,
    sharedMemory,
    resolveModel(process.env.PLANNER_MODEL, AGENT_MODELS.planner),
  );

  const engineeringAgent = new EngineeringAgent(
    openRouterClient,
    sharedMemory,
    resolveModel(process.env.ENGINEERING_MODEL, AGENT_MODELS.engineering),
  );

  const researchAgent = new ResearchAgent(
    openRouterClient,
    sharedMemory,
    resolveModel(process.env.RESEARCH_MODEL, AGENT_MODELS.research),
  );

  const marketingAgent = new MarketingAgent(
    openRouterClient,
    sharedMemory,
    resolveModel(process.env.MARKETING_MODEL, AGENT_MODELS.marketing),
  );

  const planningEngine = new PlanningEngine(plannerAgent, sharedMemory);

  return new Orchestrator(
    planningEngine,
    engineeringAgent,
    researchAgent,
    marketingAgent,
    sharedMemory,
    openRouterClient,
  );
}

/** @deprecated Use createOrionSystem() instead — avoids cross-request state contamination */
export function getOrionSystem(): Orchestrator {
  return createOrionSystem();
}

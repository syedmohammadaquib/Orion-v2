import { Plan, Task, AgentType, TaskMetadata } from './types';
import { PlanningEngine } from './planning-engine';
import { BaseAgent } from './base-agent';
import { EngineeringAgent } from './agents/engineering';
import { ResearchAgent } from './agents/research';
import { MarketingAgent } from './agents/marketing';
import { SharedMemory } from './shared-memory';
import { ModelRouter } from './model-router';
import { OpenRouterClient, normalizeModelSlug } from './openrouter-client';
import { CostEngine } from './cost-engine';
import { ConfidenceCalculator } from './confidence';
import { InMemoryRagIndex } from './rag';
import type { RagDocument } from './rag';

export class Orchestrator {
  private planningEngine: PlanningEngine;
  private agents: Map<string, BaseAgent>;
  private sharedMemory: SharedMemory;
  private executionCallbacks: Array<(status: string, data: unknown) => void> = [];
  private modelRouter: ModelRouter;
  private openRouterClient: OpenRouterClient;

  constructor(
    planningEngine: PlanningEngine,
    engineeringAgent: EngineeringAgent,
    researchAgent: ResearchAgent,
    marketingAgent: MarketingAgent,
    sharedMemory: SharedMemory,
    openRouterClient?: OpenRouterClient,
  ) {
    this.planningEngine = planningEngine;
    this.sharedMemory = sharedMemory;
    this.openRouterClient =
      openRouterClient || new OpenRouterClient(process.env.OPENROUTER_API_KEY || '');
    this.agents = new Map([
      ['engineering', engineeringAgent],
      ['research', researchAgent],
      ['marketing', marketingAgent],
    ] as [string, BaseAgent][]);
    this.modelRouter = new ModelRouter(this.openRouterClient);
  }

  async indexDocuments(documents: RagDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const index = await InMemoryRagIndex.create(documents, (texts) =>
      this.openRouterClient.embed(texts),
    );
    this.sharedMemory.set('rag_index', index);
    this.sharedMemory.set('rag_chunk_count', index.size);
  }

  onExecutionUpdate(callback: (status: string, data: unknown) => void): void {
    this.executionCallbacks.push(callback);
  }

  private notifyUpdate(status: string, data: unknown): void {
    this.executionCallbacks.forEach((callback) => callback(status, data));
  }

  async executePlan(objective: string, priority: 'speed' | 'quality' | 'cost' | 'balanced' = 'balanced'): Promise<Plan> {
    try {
      // Step 1: Generate plan
      this.notifyUpdate('planning', { message: 'Creating plan from objective' });
      const plan = await this.planningEngine.generatePlan(objective);
      this.notifyUpdate('plan_created', plan);

      // Step 2: Execute tasks
      this.notifyUpdate('executing', { message: 'Starting task execution', totalTasks: plan.tasks.length });

      await this.executeTasks(plan, priority);

      // Step 3: Finalize
      this.notifyUpdate('complete', this.planningEngine.getPlanSummary());

      return plan;
    } catch (error) {
      this.notifyUpdate('error', { message: error instanceof Error ? error.message : 'Unknown error' });
      throw error;
    }
  }

  private async executeTasks(plan: Plan, priority: 'speed' | 'quality' | 'cost' | 'balanced'): Promise<void> {
    const tasks = [...plan.tasks];
    const executionWaves = this.buildExecutionWaves(tasks);
    
    for (let waveIndex = 0; waveIndex < executionWaves.length; waveIndex++) {
      const wave = executionWaves[waveIndex];
      
      this.notifyUpdate('wave_start', {
        waveNumber: waveIndex + 1,
        totalWaves: executionWaves.length,
        tasks: wave.map((t) => t.id),
      });

      // Execute wave with allSettled so one failure does not reject the wave
      await Promise.allSettled(wave.map((task) => this.executeTaskWithRetry(plan, task, priority)));

      this.notifyUpdate('wave_complete', {
        waveNumber: waveIndex + 1,
        completedTasks: this.sharedMemory.getTaskExecutionLog().length,
      });
    }
  }

  private buildExecutionWaves(tasks: Task[]): Task[][] {
    /**
     * Group tasks into waves so that tasks within one wave can run concurrently.
     * 
     * Current strategy: group by agent type, but keep research before engineering
     * so the engineering agent can use the research agent's analysis from shared memory.
     * 
     * Wave 0: research (provides project analysis)
     * Wave 1: engineering (reads from research output in shared memory)  
     * Wave 2: marketing (optional, can run independently)
     * Wave N: anything else (planner tasks etc.)
     *
     * Within each wave, all tasks run in parallel via Promise.all.
     */
    const waves: Task[][] = [];

    const researchTasks = tasks.filter((t) => t.assignedTo === 'research');
    const engineeringTasks = tasks.filter((t) => t.assignedTo === 'engineering');
    const marketingTasks = tasks.filter((t) => t.assignedTo === 'marketing');
    const otherTasks = tasks.filter(
      (t) => !['research', 'engineering', 'marketing'].includes(t.assignedTo ?? ''),
    );

    // Wave 0: Research (produces data that engineering consumes)
    if (researchTasks.length > 0) waves.push(researchTasks);

    // Wave 1: Engineering (all engineering tasks run concurrently after research)
    if (engineeringTasks.length > 0) waves.push(engineeringTasks);

    // Wave 2: Marketing (independent of engineering results)
    if (marketingTasks.length > 0) waves.push(marketingTasks);

    // Any remaining tasks get their own waves
    otherTasks.forEach((t) => waves.push([t]));

    return waves.filter((w) => w.length > 0);
  }

  private async executeTaskWithRetry(
    plan: Plan,
    task: Task,
    priority: 'speed' | 'quality' | 'cost' | 'balanced',
    maxRetries: number = 2
  ): Promise<void> {
    if (!task.assignedTo) return;

    // Check if this agent is skipped for the current intent
    const skippedAgents = this.sharedMemory.get('skipped_agents') as AgentType[] || [];
    if (skippedAgents.includes(task.assignedTo)) {
      this.planningEngine.markTaskComplete(task.id, 'Task skipped - agent not required for this intent');
      return;
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const startTime = Date.now();
        
        this.notifyUpdate('task_start', {
          taskId: task.id,
          description: task.description,
          attempt: attempt + 1,
        });

        const agent = this.agents.get(task.assignedTo);
        if (!agent) {
          throw new Error(`No agent found for ${task.assignedTo}`);
        }

        // Select best model for this agent based on priority
        const modelSelection = this.modelRouter.selectModel({
          agentType: task.assignedTo,
          taskType: task.skill,
          priority: priority,
        });

        const activeModel = normalizeModelSlug(
          attempt === 0
            ? modelSelection.selectedModel
            : modelSelection.fallbackModels[attempt - 1] || modelSelection.selectedModel,
        );

        agent.configureRuntime({
          model: activeModel,
          fallbacks: modelSelection.fallbackModels.map(normalizeModelSlug),
          maxTokens: modelSelection.maxTokens,
          temperature: modelSelection.temperature,
        });

        this.sharedMemory.set(`task_${task.id}`, {
          ...task,
          selectedModel: activeModel,
          fallbackModel: modelSelection.fallbackModels[0],
          selectionReason: modelSelection.reason,
        });

        this.planningEngine.setAgentRunning(task.assignedTo, true);

        const response = await agent.execute({
          planId: plan.id,
          taskId: task.id,
          agentType: task.assignedTo,
          conversationHistory: [],
          sharedMemory: this.sharedMemory.getAll(),
        });

        const latency = Date.now() - startTime;

        if (response.success) {
          const usage = this.sharedMemory.get(`task_${task.id}_usage`) as
            | { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number }
            | undefined;
          const modelUsed =
            (this.sharedMemory.get(`task_${task.id}_model`) as string) || activeModel;

          const resultStr =
            typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
          const actualCost = CostEngine.calculateActualCost(modelUsed, usage as any, resultStr.length);
          const tokens = usage?.total_tokens ?? CostEngine.estimateTokens(resultStr);

          const confidence = ConfidenceCalculator.blendTaskConfidence({
            routerConfidence: modelSelection.confidence,
            success: true,
            outputChars: resultStr.length,
            agentBaseline: agent.getAgentConfidence(),
          });

          // Research failure must not leave empty analysis for engineering
          if (task.assignedTo === 'research') {
            this.sharedMemory.set('research_ok', true);
          }

          const metadata: TaskMetadata = {
            taskId: task.id,
            agent: task.assignedTo,
            selectedModel: modelUsed,
            fallbackModel: modelSelection.fallbackModels[0],
            selectionReason: modelSelection.reason,
            tokens,
            latency,
            confidence,
            estimatedCost: modelSelection.estimatedCost,
            actualCost,
            status: 'completed',
            artifactPaths: [],
            toolsUsed: (this.sharedMemory.get(`task_${task.id}_tools`) as string[] | undefined) ?? [],
            executionStartTime: new Date(startTime).toISOString(),
            executionEndTime: new Date().toISOString(),
          };

          this.sharedMemory.logTaskExecution(metadata);
          this.planningEngine.markTaskComplete(task.id, response.result);

          this.notifyUpdate('task_complete', {
            taskId: task.id,
            result: response.result,
            reasoning: response.reasoning,
            metadata,
          });

          return;
        } else {
          lastError = new Error(`Task failed: ${response.result}`);
          throw lastError;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');

        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        if (task.assignedTo === 'research') {
          this.sharedMemory.set('research_ok', false);
          this.sharedMemory.delete('project_analysis');
          this.sharedMemory.set(
            'research_degraded_note',
            `Research failed: ${lastError.message}. Engineering will proceed without live analysis.`,
          );
        }

        const metadata: TaskMetadata = {
          taskId: task.id,
          agent: task.assignedTo,
          selectedModel: 'unknown',
          selectionReason: lastError.message,
          tokens: 0,
          latency: 0,
          confidence: 0,
          estimatedCost: 0,
          actualCost: 0,
          status: 'failed',
          executionStartTime: new Date().toISOString(),
          executionEndTime: new Date().toISOString(),
        };

        this.sharedMemory.logTaskExecution(metadata);
        this.planningEngine.markTaskFailed(task.id, lastError.message);

        this.notifyUpdate('task_failed', {
          taskId: task.id,
          error: lastError.message,
          metadata,
        });

        return;
      } finally {
        this.planningEngine.setAgentRunning(task.assignedTo, false);
      }
    }
  }

  getCurrentPlan(): Plan | null {
    return this.planningEngine.getCurrentPlan();
  }

  getExecutionState() {
    return this.planningEngine.getExecutionState();
  }

  getPlanSummary() {
    return this.planningEngine.getPlanSummary();
  }

  getSharedMemory() {
    return this.sharedMemory.getAll();
  }

  calculateOverallConfidence(): number {
    const executionLog = this.sharedMemory.getTaskExecutionLog();
    if (executionLog.length === 0) return 0;

    const agentConfidences = executionLog.map((log) => log.confidence);
    return ConfidenceCalculator.calculateOverallConfidence(agentConfidences);
  }
}

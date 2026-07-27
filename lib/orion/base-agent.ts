import { AgentContext, AgentResponse, AgentType } from './types';
import { SharedMemory } from './shared-memory';
import { OpenRouterClient } from './openrouter-client';

export interface AgentRuntimeConfig {
  model: string;
  fallbacks?: string[];
  maxTokens?: number;
  temperature?: number;
}

export abstract class BaseAgent {
  protected agentType: AgentType;
  protected model: string;
  protected openRouterClient: OpenRouterClient;
  protected sharedMemory: SharedMemory;
  protected preferredModel: string;
  protected fallbackModels: string[];
  protected maxTokens: number = 3072;
  protected temperature: number = 0.4;

  constructor(
    agentType: AgentType,
    model: string,
    openRouterClient: OpenRouterClient,
    sharedMemory: SharedMemory,
  ) {
    this.agentType = agentType;
    this.model = model;
    this.preferredModel = model;
    this.openRouterClient = openRouterClient;
    this.sharedMemory = sharedMemory;
    this.fallbackModels = this.getFallbackModels();
  }

  abstract getSystemPrompt(): string;

  /**
   * Apply ModelRouter selection for this task (must be called before execute).
   */
  configureRuntime(config: AgentRuntimeConfig): void {
    this.model = config.model;
    this.preferredModel = config.model;
    if (config.fallbacks?.length) {
      this.fallbackModels = config.fallbacks;
    }
    if (config.maxTokens != null) this.maxTokens = config.maxTokens;
    if (config.temperature != null) this.temperature = config.temperature;
  }

  getActiveModel(): string {
    return this.model;
  }

  getAgentConfidence(): number {
    const confidenceMap: Record<AgentType, number> = {
      engineering: 0.85,
      research: 0.9,
      marketing: 0.8,
      planner: 0.88,
    };
    return confidenceMap[this.agentType] || 0.85;
  }

  private getFallbackModels(): string[] {
    const fallbackMap: Record<AgentType, string[]> = {
      engineering: ['deepseek/deepseek-chat', 'qwen/qwen3-coder', 'google/gemini-2.5-pro', 'openrouter/auto'],
      research: ['google/gemini-2.5-flash', 'deepseek/deepseek-chat', 'google/gemini-2.5-pro', 'openrouter/auto'],
      marketing: ['google/gemini-2.5-flash', 'openai/gpt-4.1-mini', 'deepseek/deepseek-chat', 'openrouter/auto'],
      planner: ['deepseek/deepseek-chat', 'google/gemini-2.5-flash', 'openrouter/auto'],
    };
    return fallbackMap[this.agentType] || ['deepseek/deepseek-chat', 'openrouter/auto'];
  }

  /** Chat using the runtime-selected model + token/temperature budget. */
  protected async chatForTask(
    messages: { role: 'user' | 'assistant'; content: string }[],
    systemPrompt: string,
  ) {
    return this.openRouterClient.chat(
      this.model,
      messages,
      systemPrompt,
      this.maxTokens,
      this.temperature,
    );
  }

  protected async tryPreferredModel(
    messages: { role: 'user' | 'assistant'; content: string }[],
    systemPrompt: string,
  ): Promise<{ result: string; usage?: any; modelUsed: string }> {
    const modelsToTry = [this.preferredModel, ...this.fallbackModels];
    let lastError: Error | null = null;

    for (let i = 0; i < modelsToTry.length; i++) {
      const model = modelsToTry[i];
      try {
        const response = await this.openRouterClient.chat(
          model,
          messages,
          systemPrompt,
          this.maxTokens,
        );
        this.model = model;
        return { result: response.content, usage: response.usage, modelUsed: model };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');
      }
    }

    throw lastError || new Error('All models failed');
  }

  async execute(context: AgentContext): Promise<AgentResponse> {
    try {
      const systemPrompt = this.getSystemPrompt();
      const userMessage = {
        role: 'user' as const,
        content: this.buildPrompt(context),
      };

      const response = await this.chatForTask([userMessage], systemPrompt);

      if (response.usage) {
        this.sharedMemory.set(`task_${context.taskId}_usage`, response.usage);
      }

      const parsedResponse = this.parseResponse(response.content, context.taskId);
      this.sharedMemory.set(`task_${context.taskId}_result`, parsedResponse.result);
      this.sharedMemory.set(`task_${context.taskId}_reasoning`, parsedResponse.reasoning);
      this.sharedMemory.set(`task_${context.taskId}_model`, this.model);

      return parsedResponse;
    } catch (error) {
      return {
        taskId: context.taskId,
        result: `Failed to complete task: ${error instanceof Error ? error.message : 'Unknown error'}`,
        reasoning: 'Task execution failed',
        success: false,
      };
    }
  }

  protected buildPrompt(context: AgentContext): string {
    return `Task: ${context.taskId}

Complete this task concisely. Prefer short, structured output.
Return JSON:
{
  "result": "result here",
  "reasoning": "brief reasoning",
  "success": true
}`;
  }

  protected parseResponse(response: string, taskId: string): AgentResponse {
    if (!response.trim()) {
      return {
        taskId,
        result: 'Task completed successfully',
        reasoning: 'No additional content returned',
        success: true,
      };
    }

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return {
          taskId,
          result: response,
          reasoning: 'Parsed as plain text',
          success: true,
        };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        taskId,
        result: parsed.result || response,
        reasoning: parsed.reasoning || '',
        nextSteps: parsed.nextSteps,
        success: parsed.success !== false,
      };
    } catch {
      return {
        taskId,
        result: response,
        reasoning: 'Response parsed as plain text',
        success: true,
      };
    }
  }
}

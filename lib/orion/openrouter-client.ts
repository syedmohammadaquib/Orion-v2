import OpenAI from 'openai';

/** Soft default — keep completion budgets modest so low OpenRouter balances still work. */
const DEFAULT_MAX_TOKENS = 3072;
const HARD_CAP_MAX_TOKENS = 8192;
const MAX_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 90_000;

type ChatMessage = { role: 'user' | 'assistant'; content: string };
type AllMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type ChatResult = {
  content: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  modelUsed?: string;
  toolsUsed?: string[];
};

export interface ChatToolConfig {
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  execute: (name: string, arguments_: Record<string, unknown>) => Promise<string>;
  maxCalls?: number;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Dead / redirected OpenRouter free slugs → current paid (or working) IDs */
const SLUG_ALIASES: Record<string, string> = {
  'deepseek/deepseek-r1:free': 'deepseek/deepseek-r1',
  'deepseek/deepseek-chat-v3.1:free': 'deepseek/deepseek-chat',
  'deepseek/deepseek-chat:free': 'deepseek/deepseek-chat',
  'qwen/qwen3-coder:free': 'qwen/qwen3-coder',
  'qwen/qwen3.6-plus:free': 'google/gemini-2.5-flash',
  'minimax/minimax-m2.5:free': 'google/gemini-2.5-flash',
  'glm-5-2': 'google/gemini-2.5-pro',
  'kimi/kimi-k2.7': 'google/gemini-2.5-flash',
};

export function normalizeModelSlug(model: string): string {
  const trimmed = model.trim();
  if (SLUG_ALIASES[trimmed]) return SLUG_ALIASES[trimmed];
  // Generic: deepseek/deepseek-r1:free → deepseek/deepseek-r1
  if (trimmed.endsWith(':free')) {
    return trimmed.replace(/:free$/, '');
  }
  return trimmed;
}

function extractSuggestedSlug(errorMessage: string): string | null {
  // "use this slug instead: deepseek/deepseek-r1"
  const match = errorMessage.match(/use this slug instead:\s*([a-z0-9_./:-]+)/i);
  return match ? normalizeModelSlug(match[1]) : null;
}

/** Parse OpenRouter 402: "can only afford 2383" */
export function extractAffordableMaxTokens(errorMessage: string): number | null {
  const afford = errorMessage.match(/can only afford\s+(\d+)/i);
  if (afford) {
    const n = Number(afford[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const requested = errorMessage.match(/requested up to\s+(\d+)\s+tokens/i);
  if (requested && /402|credits|afford/i.test(errorMessage)) {
    const n = Math.floor(Number(requested[1]) / 2);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export function clampMaxTokens(requested: number, affordable?: number | null): number {
  const envCap = Number(process.env.ORION_MAX_TOKENS);
  const hardCap =
    Number.isFinite(envCap) && envCap > 0
      ? Math.min(envCap, HARD_CAP_MAX_TOKENS)
      : HARD_CAP_MAX_TOKENS;
  let tokens = Math.max(256, Math.min(Math.floor(requested), hardCap));
  if (affordable != null && Number.isFinite(affordable)) {
    // Leave a small buffer so residual credit estimate still covers the call
    tokens = Math.min(tokens, Math.max(256, Math.floor(affordable) - 16));
  }
  return tokens;
}

export class OpenRouterClient {
  private client: OpenAI;
  private static readonly EMBEDDING_MODEL = 'openai/text-embedding-3-small';

  constructor(apiKey: string, fetchImpl?: typeof fetch) {
    this.client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: apiKey,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      defaultHeaders: {
        'HTTP-Referer': 'https://orion-ai.vercel.app',
        'X-Title': 'Orion',
      },
    });
  }

  private buildMessages(messages: ChatMessage[], systemPrompt?: string): AllMessage[] {
    const allMessages: AllMessage[] = [];
    if (systemPrompt) {
      allMessages.push({ role: 'system', content: systemPrompt });
    }
    allMessages.push(...(messages as AllMessage[]));
    return allMessages;
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    systemPrompt?: string,
    maxTokens: number = DEFAULT_MAX_TOKENS,
    temperature: number = 0.4,
    toolConfig?: ChatToolConfig,
    responseFormat?: OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'],
  ): Promise<ChatResult> {
    let activeModel = normalizeModelSlug(model);
    let activeMaxTokens = clampMaxTokens(maxTokens);
    const allMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = this.buildMessages(
      messages,
      systemPrompt,
    );
    let lastError: Error | null = null;
    const tried = new Set<string>();
    let creditFallbackUsed = false;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      tried.add(`${activeModel}@${activeMaxTokens}`);
      try {
        const toolMessages = [...allMessages];
        const toolsUsed = new Set<string>();
        const maxCalls = Math.max(0, Math.min(toolConfig?.maxCalls ?? 3, 3));
        let toolCallCount = 0;
        const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        let hasUsage = false;

        for (let round = 0; round <= maxCalls; round++) {
          const response = await this.client.chat.completions.create({
            model: activeModel,
            max_tokens: activeMaxTokens,
            messages: toolMessages,
            temperature,
            ...(responseFormat ? { response_format: responseFormat } : {}),
            ...(toolConfig && round < maxCalls
              ? { tools: toolConfig.tools, tool_choice: 'auto' as const }
              : {}),
          });
          if (response.usage) {
            usage.prompt_tokens += response.usage.prompt_tokens;
            usage.completion_tokens += response.usage.completion_tokens;
            usage.total_tokens += response.usage.total_tokens;
            hasUsage = true;
          }

          const assistantMessage = response.choices[0]?.message;
          const toolCalls = assistantMessage?.tool_calls;
          if (!toolConfig || !toolCalls?.length) {
            return {
              content:
                typeof assistantMessage?.content === 'string'
                  ? assistantMessage.content
                  : '',
              modelUsed: activeModel,
              usage: hasUsage ? usage : undefined,
              toolsUsed: Array.from(toolsUsed),
            };
          }

          if (toolCallCount + toolCalls.length > maxCalls) {
            throw new Error(`Model exceeded the limit of ${maxCalls} tool calls`);
          }

          toolMessages.push(assistantMessage);
          for (const toolCall of toolCalls) {
            if (toolCall.type !== 'function') {
              throw new Error('Model returned an unsupported tool call');
            }
            let parsedArguments: unknown;
            try {
              parsedArguments = JSON.parse(toolCall.function.arguments);
            } catch {
              throw new Error(`Model returned invalid JSON for tool ${toolCall.function.name}`);
            }
            if (
              !parsedArguments ||
              typeof parsedArguments !== 'object' ||
              Array.isArray(parsedArguments)
            ) {
              throw new Error(`Model returned invalid arguments for tool ${toolCall.function.name}`);
            }

            const result = await toolConfig.execute(
              toolCall.function.name,
              parsedArguments as Record<string, unknown>,
            );
            toolsUsed.add(toolCall.function.name);
            toolCallCount++;
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result,
            });
          }
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const msg = lastError.message;

        // OpenRouter often returns: free slug dead → use paid slug
        const suggested = extractSuggestedSlug(msg);
        if (suggested && !tried.has(`${suggested}@${activeMaxTokens}`)) {
          console.warn(`[OpenRouterClient] ${activeModel} unavailable → switching to ${suggested}`);
          activeModel = suggested;
          continue;
        }

        // 402: credit / max_tokens too high → retry with affordable cap
        const affordable = extractAffordableMaxTokens(msg);
        if ((msg.includes('402') || /afford|more credits/i.test(msg)) && affordable != null) {
          const reduced = clampMaxTokens(Math.min(activeMaxTokens, affordable), affordable);
          if (reduced < activeMaxTokens && !tried.has(`${activeModel}@${reduced}`)) {
            console.warn(
              `[OpenRouterClient] 402 credit limit — reducing max_tokens ${activeMaxTokens} → ${reduced}`,
            );
            activeMaxTokens = reduced;
            continue;
          }
          // Still can't afford this model — switch to cheap flash once
          const flashKey = `google/gemini-2.5-flash@${reduced}`;
          if (!creditFallbackUsed && !tried.has(flashKey)) {
            console.warn(
              `[OpenRouterClient] 402 — falling back to google/gemini-2.5-flash @ ${reduced} tokens`,
            );
            activeModel = 'google/gemini-2.5-flash';
            activeMaxTokens = reduced;
            creditFallbackUsed = true;
            continue;
          }
        }

        const isRetryable =
          msg.includes('429') ||
          msg.includes('503') ||
          msg.includes('timeout') ||
          msg.includes('network') ||
          msg.includes('404');

        if (!isRetryable || attempt === MAX_RETRIES - 1) break;

        if (msg.includes('404') && !tried.has(`openrouter/auto@${activeMaxTokens}`)) {
          activeModel = 'openrouter/auto';
          continue;
        }

        const backoff = Math.pow(2, attempt) * 1000;
        console.warn(
          `[OpenRouterClient] Retry ${attempt + 1}/${MAX_RETRIES} after ${backoff}ms — ${msg}`,
        );
        await sleep(backoff);
      }
    }

    throw lastError ?? new Error('OpenRouterClient: unknown error after retries');
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.client.embeddings.create({
      model: OpenRouterClient.EMBEDDING_MODEL,
      input: texts,
    });
    const vectors = [...response.data]
      .sort((left, right) => left.index - right.index)
      .map((item) => item.embedding);
    if (vectors.length !== texts.length) {
      throw new Error('OpenRouter returned an incomplete embedding response.');
    }
    return vectors;
  }

  async stream(
    model: string,
    messages: ChatMessage[],
    systemPrompt?: string,
    maxTokens: number = DEFAULT_MAX_TOKENS,
    temperature: number = 0.4,
  ): Promise<AsyncIterable<string>> {
    const activeModel = normalizeModelSlug(model);
    const activeMaxTokens = clampMaxTokens(maxTokens);
    const allMessages = this.buildMessages(messages, systemPrompt);

    const stream = await this.client.chat.completions.create({
      model: activeModel,
      max_tokens: activeMaxTokens,
      messages: allMessages,
      temperature,
      stream: true,
    });

    return (async function* () {
      for await (const event of stream) {
        const delta = event.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
    })();
  }
}

export function getOpenRouterClient(): OpenRouterClient {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY environment variable is not set');
  }
  return new OpenRouterClient(apiKey);
}

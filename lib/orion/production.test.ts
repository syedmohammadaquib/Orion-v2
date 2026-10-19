import { describe, expect, it } from 'vitest';
import {
  normalizeModelSlug,
  OpenRouterClient,
  extractAffordableMaxTokens,
  clampMaxTokens,
} from './openrouter-client';
import { ArtifactParser } from './artifact-engine/artifact-parser';
import { ArtifactNormalizer } from './artifact-engine/artifact-normalizer';
import { ArtifactEngine } from './artifact-engine/artifact-engine';
import { ArtifactValidator } from './artifact-engine/artifact-validator';
import { hasExtractableCode } from './artifact-engine/artifact-gate';
import { ModelRouter } from './model-router';
import { getAllFrameworks } from './artifact-engine/frameworks';
import { ConfidenceCalculator } from './confidence';
import { extractUrls } from './tools/web-fetch';
import { getEvaluationModels, isEvaluationModelForRole, parseJudgeResponse } from './model-evaluator';

describe('normalizeModelSlug', () => {
  it('maps retired free R1 to paid slug', () => {
    expect(normalizeModelSlug('deepseek/deepseek-r1:free')).toBe('deepseek/deepseek-r1');
  });

  it('strips generic :free suffix', () => {
    expect(normalizeModelSlug('acme/model:free')).toBe('acme/model');
  });

  it('leaves paid slugs unchanged', () => {
    expect(normalizeModelSlug('google/gemini-2.5-flash')).toBe('google/gemini-2.5-flash');
  });
});

describe('OpenRouter credit / max_tokens helpers', () => {
  it('parses affordable tokens from 402 message', () => {
    const msg =
      '402 This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 2383.';
    expect(extractAffordableMaxTokens(msg)).toBe(2383);
    expect(clampMaxTokens(8192, 2383)).toBe(2367);
  });
});

describe('OpenRouterClient tool calling', () => {
  it('runs a tool, returns the final answer, and aggregates token usage', async () => {
    const responses = [
      {
        id: 'completion-1',
        object: 'chat.completion',
        created: 1,
        model: 'test/model',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'fetch_reference',
                    arguments: '{"url":"https://example.com"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
      {
        id: 'completion-2',
        object: 'chat.completion',
        created: 2,
        model: 'test/model',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'Research complete.' },
          },
        ],
        usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
      },
    ];
    const requestBodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
    const fetchMock: typeof fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      const body = responses.shift();
      if (!body) throw new Error('Unexpected OpenRouter request');
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const executedTools: string[] = [];
    const client = new OpenRouterClient('test-key', fetchMock);

    const result = await client.chat(
      'test/model',
      [{ role: 'user', content: 'Read the supplied reference.' }],
      undefined,
      1024,
      0.2,
      {
        tools: [
          {
            type: 'function',
            function: {
              name: 'fetch_reference',
              description: 'Fetch a reference.',
              parameters: { type: 'object', properties: { url: { type: 'string' } } },
            },
          },
        ],
        execute: async (name, args) => {
          executedTools.push(`${name}:${String(args.url)}`);
          return '{"ok":true}';
        },
      },
    );

    expect(result.content).toBe('Research complete.');
    expect(result.toolsUsed).toEqual(['fetch_reference']);
    expect(result.usage).toEqual({
      prompt_tokens: 25,
      completion_tokens: 7,
      total_tokens: 32,
    });
    expect(executedTools).toEqual(['fetch_reference:https://example.com']);
    expect(requestBodies[1]?.messages.some((message) => message.role === 'tool')).toBe(true);
  });

  it('requests JSON mode when a caller needs structured output', async () => {
    let requestBody: { response_format?: { type: string } } | undefined;
    const fetchMock: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id: 'completion-json',
          object: 'chat.completion',
          created: 1,
          model: 'test/model',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: '{"scores":[]}' },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    await new OpenRouterClient('test-key', fetchMock).chat(
      'test/model',
      [{ role: 'user', content: 'Return a JSON object.' }],
      undefined,
      512,
      0,
      undefined,
      { type: 'json_object' },
    );

    expect(requestBody?.response_format).toEqual({ type: 'json_object' });
  });
});

describe('ArtifactParser', () => {
  it('parses path-tagged fences without pathless duplicates', () => {
    const input = `
\`\`\`tsx path="src/App.tsx"
export default function App() { return null }
\`\`\`

\`\`\`css path="src/index.css"
body { margin: 0 }
\`\`\`
`;
    const artifacts = new ArtifactParser().parse(input);
    expect(artifacts.length).toBe(2);
    expect(artifacts.map((a) => a.path).sort()).toEqual(['src/App.tsx', 'src/index.css']);
  });

  it('accepts bare path fence tags', () => {
    const input = `
\`\`\`src/main.ts
console.log('hi')
\`\`\`
`;
    const artifacts = new ArtifactParser().parse(input);
    expect(artifacts[0]?.path).toBe('src/main.ts');
  });

  it('accepts lang + path without equals', () => {
    const input = `
\`\`\`tsx src/App.tsx
export default function App() { return null }
\`\`\`
`;
    const artifacts = new ArtifactParser().parse(input);
    expect(artifacts[0]?.path).toBe('src/App.tsx');
  });

  it('assigns stable paths to pathless fences', () => {
    const input = `
\`\`\`tsx
export default function App() { return <main>Hi</main> }
\`\`\`

\`\`\`css
body { margin: 0 }
\`\`\`

\`\`\`json
{ "name": "demo", "private": true }
\`\`\`
`;
    const artifacts = new ArtifactParser().parse(input);
    expect(artifacts.length).toBe(3);
    expect(artifacts.map((a) => a.path).sort()).toEqual([
      'package.json',
      'src/App.tsx',
      'src/styles/index.css',
    ]);
  });
});

describe('hasExtractableCode', () => {
  it('detects pathless fences', () => {
    expect(
      hasExtractableCode('```tsx\n console.log(1)\n```'),
    ).toBe(true);
  });

  it('detects lang + path form', () => {
    expect(hasExtractableCode('```tsx src/App.tsx\nexport {}\n```')).toBe(true);
  });

  it('rejects prose-only', () => {
    expect(hasExtractableCode('Just a research summary with no code.')).toBe(false);
  });
});

describe('ArtifactEngine with pathless engineering output', () => {
  it('builds a non-empty VFS from pathless fences', () => {
    const engine = new ArtifactEngine();
    const result = engine.process(`
Here is the app:

\`\`\`tsx
export default function App() { return <h1>Hello</h1> }
\`\`\`

\`\`\`css
body { font-family: system-ui; }
\`\`\`

\`\`\`json
{ "name": "hello", "private": true }
\`\`\`

{ "success": true, "result": "done" }
`);
    expect(result.vfs.size).toBeGreaterThanOrEqual(2);
    expect(result.vfs.has('src/App.tsx') || [...result.vfs.keys()].some((k) => k.endsWith('App.tsx'))).toBe(
      true,
    );
  });
});

describe('ArtifactValidator Tailwind configuration', () => {
  const genericFramework = getAllFrameworks().find((framework) => framework.id === 'generic')!;

  it('warns when Tailwind v3 has no config and @apply uses undefined semantic colors', () => {
    const validation = new ArtifactValidator().validate(
      new Map([
        [
          'package.json',
          {
            path: 'package.json',
            content: JSON.stringify({ devDependencies: { tailwindcss: '^3.4.0' } }),
            language: 'json',
          },
        ],
        [
          'src/index.css',
          {
            path: 'src/index.css',
            content: 'body { @apply bg-light text-dark; }',
            language: 'css',
          },
        ],
      ]),
      genericFramework,
    );

    expect(validation.warnings).toContain(
      'Tailwind CSS v3 requires a tailwind.config file with content globs.',
    );
    expect(validation.warnings.some((warning) => warning.includes('@apply bg-light'))).toBe(true);
    expect(validation.warnings.some((warning) => warning.includes('@apply text-dark'))).toBe(true);
  });

  it('accepts semantic @apply colors declared in the Tailwind theme', () => {
    const validation = new ArtifactValidator().validate(
      new Map([
        [
          'package.json',
          {
            path: 'package.json',
            content: JSON.stringify({ devDependencies: { tailwindcss: '^3.4.0' } }),
            language: 'json',
          },
        ],
        [
          'tailwind.config.js',
          {
            path: 'tailwind.config.js',
            content: `module.exports = {
              content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
              theme: { extend: { colors: { light: '#fff', dark: '#111' } } }
            };`,
            language: 'javascript',
          },
        ],
        [
          'src/index.css',
          {
            path: 'src/index.css',
            content: 'body { @apply bg-light text-dark; }',
            language: 'css',
          },
        ],
      ]),
      genericFramework,
    );

    expect(validation.warnings).toEqual([]);
  });
});

describe('ArtifactNormalizer', () => {
  it('strips disposable outer project folder', () => {
    const fw = getAllFrameworks().find((f) => f.id === 'react')!;
    const vfs = new ArtifactNormalizer().normalize(
      [
        { path: 'my-app/src/App.tsx', content: 'a', language: 'tsx' },
        { path: 'my-app/package.json', content: '{"name":"x"}', language: 'json' },
      ],
      fw,
    );
    expect(vfs.has('src/App.tsx')).toBe(true);
    expect(vfs.has('package.json')).toBe(true);
    expect(vfs.has('my-app/src/App.tsx')).toBe(false);
  });
});

describe('ModelRouter', () => {
  it('balanced research never selects a :free slug when paid options exist', () => {
    const client = new OpenRouterClient('test-key');
    const router = new ModelRouter(client);
    const selection = router.selectModel({ agentType: 'research', priority: 'balanced' });
    expect(selection.selectedModel.includes(':free')).toBe(false);
    expect(selection.selectedModel).not.toBe('deepseek/deepseek-r1:free');
  });

  it('quality research prefers a flagship reasoning model', () => {
    const client = new OpenRouterClient('test-key');
    const router = new ModelRouter(client);
    const selection = router.selectModel({ agentType: 'research', priority: 'quality' });
    expect(['deepseek/deepseek-r1', 'anthropic/claude-sonnet-4']).toContain(selection.selectedModel);
  });
});

describe('Model evaluation', () => {
  it('lists only supported role models and rejects mismatched roles', () => {
    const researchModels = getEvaluationModels('research');
    expect(researchModels.length).toBeGreaterThan(1);
    expect(researchModels.some((model) => model.id.includes(':free'))).toBe(false);
    expect(researchModels.some((model) => model.id === 'openrouter/auto')).toBe(false);
    expect(isEvaluationModelForRole('google/gemini-2.5-flash', 'research')).toBe(true);
    expect(isEvaluationModelForRole('qwen/qwen3-coder', 'research')).toBe(false);
  });

  it('parses rubric scores and rejects incomplete judge responses', () => {
    const content = JSON.stringify({
      scores: [
        {
          model: 'google/gemini-2.5-flash',
          taskFulfillment: 8,
          correctness: 7,
          completeness: 6,
          clarity: 9,
          strengths: 'Clear and direct; handles {edge cases}.',
          improvements: 'Add more detail.',
        },
      ],
    });
    expect(parseJudgeResponse(content).scores[0]?.clarity).toBe(9);
    expect(parseJudgeResponse(content).scores[0]?.strengths).toContain('{edge cases}');
    expect(parseJudgeResponse(`\`\`\`json\n${content}\n\`\`\``).scores).toHaveLength(1);
    expect(() => parseJudgeResponse('not json')).toThrow('did not return a JSON score report');
    expect(() =>
      parseJudgeResponse(JSON.stringify({ scores: [{ model: 'bad', taskFulfillment: 11 }] })),
    ).toThrow('invalid score report');
  });
});

describe('ConfidenceCalculator.blendTaskConfidence', () => {
  it('returns 0 on failure', () => {
    expect(
      ConfidenceCalculator.blendTaskConfidence({
        routerConfidence: 0.9,
        success: false,
        outputChars: 1000,
        agentBaseline: 0.9,
      }),
    ).toBe(0);
  });

  it('penalizes tiny outputs', () => {
    const short = ConfidenceCalculator.blendTaskConfidence({
      routerConfidence: 0.9,
      success: true,
      outputChars: 10,
      agentBaseline: 0.9,
    });
    const long = ConfidenceCalculator.blendTaskConfidence({
      routerConfidence: 0.9,
      success: true,
      outputChars: 2000,
      agentBaseline: 0.9,
    });
    expect(short).toBeLessThan(long);
  });
});

describe('extractUrls', () => {
  it('extracts http(s) urls', () => {
    expect(extractUrls('See https://example.com/docs and http://foo.dev/a.')).toEqual([
      'https://example.com/docs',
      'http://foo.dev/a',
    ]);
  });
});

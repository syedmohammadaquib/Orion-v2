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
import { hasExtractableCode } from './artifact-engine/artifact-gate';
import { ModelRouter } from './model-router';
import { getAllFrameworks } from './artifact-engine/frameworks';
import { ConfidenceCalculator } from './confidence';
import { extractUrls } from './tools/web-fetch';

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

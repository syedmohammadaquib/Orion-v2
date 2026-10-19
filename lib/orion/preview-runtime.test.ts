import { describe, expect, it } from 'vitest';
import { selectPreview, type PreviewFile } from '../../components/ide/preview-runtime';

const files = (entries: Record<string, string>): Record<string, PreviewFile> =>
  Object.fromEntries(
    Object.entries(entries).map(([path, content]) => [path, { content }]),
  );

describe('artifact preview selection', () => {
  it('keeps static HTML/CSS projects on the direct iframe path', () => {
    expect(
      selectPreview(files({ 'index.html': '<main>Hello</main>', 'style.css': 'main {}' })),
    ).toEqual({
      kind: 'html',
      path: 'index.html',
    });
  });

  it('shows React projects in source-preview mode rather than attempting browser compilation', () => {
    expect(
      selectPreview(
        files({
          'package.json': '{"devDependencies":{"vite":"^6","react":"^19"}}',
          'index.html': '<div id="root"></div>',
          'src/main.tsx': "import { createRoot } from 'react-dom/client';",
        }),
      ),
    ).toEqual({
      kind: 'unsupported',
      framework: 'react',
    });
  });

  it('shows Next.js projects in source-preview mode, including projects without a page entry', () => {
    expect(
      selectPreview(
        files({
          'package.json': '{"dependencies":{"next":"^16","react":"^19"}}',
          'app/page.tsx': 'export default function Page() { return <main /> }',
        }),
      ),
    ).toEqual({
      kind: 'unsupported',
      framework: 'nextjs',
    });
    expect(
      selectPreview(files({ 'next.config.ts': 'export default {}' })),
    ).toEqual({
      kind: 'unsupported',
      framework: 'nextjs',
    });
  });

  it('reports unsupported projects without a framework or HTML entry', () => {
    expect(selectPreview(files({ 'main.py': 'print("hello")' }))).toEqual({
      kind: 'unavailable',
    });
  });
});

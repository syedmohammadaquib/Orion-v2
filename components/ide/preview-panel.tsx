'use client';

import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Code2,
  Layers3,
  MonitorPlay,
  RefreshCw,
  Terminal,
} from 'lucide-react';
import { selectPreview } from './preview-runtime';

interface PreviewPanelProps {
  vfs: Record<string, { content: string; language: string }>;
  manifest: any;
  onOpenCode: () => void;
}

function normalizeVfsPath(path: string): string {
  return path.replace(/^\.?\//, '').replace(/\\/g, '/');
}

function findVfsContent(
  vfs: Record<string, { content: string; language: string }>,
  href: string,
): string | null {
  const cleaned = normalizeVfsPath(href.split('?')[0].split('#')[0]);
  if (vfs[cleaned]?.content != null) return vfs[cleaned].content;
  const hit = Object.entries(vfs).find(
    ([path]) => path === cleaned || path.endsWith(`/${cleaned}`) || path.endsWith(cleaned),
  );
  return hit ? hit[1].content : null;
}

function inlineLocalAssets(
  html: string,
  vfs: Record<string, { content: string; language: string }>,
): string {
  let out = html;

  out = out.replace(
    /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi,
    (full, href: string) => {
      if (/^https?:\/\//i.test(href) || href.startsWith('data:')) return full;
      const css = findVfsContent(vfs, href);
      if (css == null) return `<!-- missing stylesheet: ${href} -->`;
      return `<style data-orion-inlined="${href}">\n${css}\n</style>`;
    },
  );

  out = out.replace(
    /<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
    (full, pre: string, src: string, post: string) => {
      if (/^https?:\/\//i.test(src) || src.startsWith('data:')) return full;
      const js = findVfsContent(vfs, src);
      if (js == null) return `<!-- missing script: ${src} -->`;
      return `<script${pre}${post} data-orion-inlined="${src}">\n${js}\n</script>`;
    },
  );

  return out;
}

export function PreviewPanel({ vfs, manifest, onOpenCode }: PreviewPanelProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);
  const selection = useMemo(() => selectPreview(vfs, manifest), [vfs, manifest]);

  const importantFiles = useMemo(() => {
    const paths = Object.keys(vfs);
    const preferred = [
      'package.json',
      'src/App.tsx',
      'src/App.jsx',
      'src/main.tsx',
      'src/index.tsx',
      'app/page.tsx',
      'src/app/page.tsx',
      'pages/index.tsx',
      'src/app/globals.css',
      'app/globals.css',
    ];
    const selected = preferred.filter((path) => paths.includes(path));
    return [...selected, ...paths.filter((path) => !selected.includes(path))].slice(0, 4);
  }, [vfs]);

  const previewHtml =
    selection.kind === 'html'
      ? inlineLocalAssets(vfs[selection.path]?.content || '', vfs)
      : null;
  const frameworkName =
    selection.kind === 'unsupported'
      ? selection.framework === 'nextjs'
        ? 'Next.js'
        : 'React'
      : null;

  const handleRefresh = () => {
    setIsRefreshing(true);
    setNonce((value) => value + 1);
    setTimeout(() => setIsRefreshing(false), 400);
  };

  return (
    <div className="h-full flex flex-col bg-orion-surface">
      <div className="h-9 shrink-0 bg-orion-elevated/60 border-b border-orion-hairline flex items-center justify-between px-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-orion-paper">Preview</span>
          <span className="text-[10px] font-mono text-muted-foreground">
            {selection.kind === 'html'
              ? 'HTML · live'
              : frameworkName
                ? `${frameworkName} · source view`
                : 'not available'}
          </span>
        </div>
        {selection.kind === 'html' && (
          <button
            type="button"
            onClick={handleRefresh}
            className="p-1.5 hover:bg-secondary/60 rounded text-muted-foreground hover:text-foreground transition-colors"
            title="Refresh Preview"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>
      {selection.kind === 'html' && previewHtml !== null ? (
        <div className="flex-1 bg-white">
          <iframe
            key={nonce}
            srcDoc={previewHtml}
            className="w-full h-full border-0"
            title="Artifact Preview"
            sandbox="allow-scripts"
          />
        </div>
      ) : (
        <div className="relative flex-1 min-h-0 overflow-auto bg-[#f5f7fb] px-5 py-8 sm:px-8 sm:py-12">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-indigo-100/60 via-violet-50/40 to-transparent" />
          <section className="relative mx-auto w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_20px_70px_-35px_rgba(37,47,90,0.28)]">
            <div className="h-1 bg-gradient-to-r from-indigo-500 via-violet-500 to-sky-400" />
            <div className="p-6 sm:p-9">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100">
                    {frameworkName ? (
                      <Layers3 className="h-6 w-6" />
                    ) : (
                      <MonitorPlay className="h-6 w-6" />
                    )}
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-indigo-600">
                      Project workspace
                    </p>
                    <p className="mt-0.5 text-sm text-slate-500">
                      {frameworkName ? `${frameworkName} project` : 'Generated files'}
                    </p>
                  </div>
                </div>
                <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  {frameworkName ? 'Code preview' : 'No web entry'}
                </span>
              </div>

              <div className="mt-8 max-w-2xl">
                <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
                  {frameworkName
                    ? `${frameworkName} preview isn’t available yet`
                    : 'There’s no browser preview for this project'}
                </h2>
                <p className="mt-3 text-sm leading-6 text-slate-600 sm:text-base">
                  {frameworkName === 'Next.js'
                    ? 'Next.js needs its own server to render pages and framework features. Orion keeps your generated project intact and shows you the files instead of an unreliable or incomplete preview.'
                    : frameworkName === 'React'
                      ? 'This React project needs its normal install and build environment to run. You can still inspect every generated file here and run the project locally.'
                      : 'Orion can preview static HTML projects directly. This project is available in the workspace, but it does not include a supported HTML entry file.'}
                </p>
              </div>

              <div className="mt-7 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                    <Code2 className="h-4 w-4 text-indigo-600" />
                    Your files are ready
                  </div>
                  <p className="mt-1.5 text-xs leading-5 text-slate-500">
                    Browse the generated source and project structure in the Code and Files tabs.
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                    <Terminal className="h-4 w-4 text-indigo-600" />
                    Run it locally
                  </div>
                  <p className="mt-1.5 text-xs leading-5 text-slate-500">
                    Export the project, install its dependencies, and use its package scripts to launch it.
                  </p>
                </div>
              </div>

              {importantFiles.length > 0 && (
                <div className="mt-6 rounded-xl border border-slate-200">
                  <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                    <span className="text-xs font-semibold text-slate-700">Project files</span>
                    <span className="text-[11px] text-slate-400">
                      {Object.keys(vfs).length} total
                    </span>
                  </div>
                  <ul className="divide-y divide-slate-100">
                    {importantFiles.map((path) => (
                      <li key={path} className="flex items-center gap-2.5 px-4 py-2.5">
                        <Code2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        <span className="truncate font-mono text-xs text-slate-600">{path}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <button
                type="button"
                onClick={onOpenCode}
                className="mt-7 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
              >
                Inspect generated code
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

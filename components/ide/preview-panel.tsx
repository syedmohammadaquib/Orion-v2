'use client';

import { useMemo, useState } from 'react';
import { RefreshCw, ExternalLink } from 'lucide-react';

interface FileNode {
  name: string;
  type: 'file' | 'folder';
  language?: string;
  content?: string;
  children?: FileNode[];
}

interface PreviewPanelProps {
  files: FileNode[];
  vfs: Record<string, { content: string; language: string }>;
  manifest: any;
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

/** Rewrite local CSS/JS references into inline content so the iframe never hits Next routes. */
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

function findFileByName(nodes: FileNode[], name: string): FileNode | null {
  for (const node of nodes) {
    if (node.type === 'file' && node.name === name) return node;
    if (node.children) {
      const found = findFileByName(node.children, name);
      if (found) return found;
    }
  }
  return null;
}

export function PreviewPanel({ files, vfs, manifest }: PreviewPanelProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);

  const handleRefresh = () => {
    setIsRefreshing(true);
    setNonce((n) => n + 1);
    setTimeout(() => setIsRefreshing(false), 400);
  };

  const previewContent = useMemo(() => {
    let html: string | null = null;

    if (manifest?.previewFile && vfs[manifest.previewFile]?.content) {
      html = vfs[manifest.previewFile].content;
    } else {
      const htmlFile = findFileByName(files, 'index.html');
      if (htmlFile?.content) html = htmlFile.content;
      else {
        const htmlEntry = Object.entries(vfs).find(([path]) => path.endsWith('index.html'));
        if (htmlEntry) html = htmlEntry[1].content;
      }
    }

    if (html) {
      return inlineLocalAssets(html, vfs);
    }

    const reactFiles = files.filter((f) => f.name.endsWith('.tsx') || f.name.endsWith('.jsx'));
    if (reactFiles.length > 0) {
      const names = reactFiles.map((f) => f.name);
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Preview</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #f4f2ec; color: #1a1d26; }
    .panel { max-width: 560px; margin: 40px auto; background: #fff; border: 1px solid #e5e1d8; border-radius: 8px; padding: 28px; }
    h1 { margin: 0 0 8px; font-size: 1.2rem; }
    p, li { color: #5c584f; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="panel">
    <h1>React project detected</h1>
    <p>Live React runtime preview needs a bundler. Open the Code tab to inspect these files:</p>
    <ul>${names.map((n) => `<li>${n}</li>`).join('')}</ul>
  </div>
</body>
</html>`;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Preview</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 40px; background: #f4f2ec; color: #1a1d26;
      min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .panel { background: #fff; padding: 32px; border: 1px solid #e5e1d8; border-radius: 8px; max-width: 480px; }
    h1 { margin: 0 0 12px; font-size: 1.25rem; }
    p { margin: 0; color: #5c584f; line-height: 1.55; }
  </style>
</head>
<body>
  <div class="panel">
    <h1>Preview unavailable</h1>
    <p>Orion could not find a previewable entry file. Open the Code tab to inspect generated files.</p>
  </div>
</body>
</html>`;
  }, [files, vfs, manifest, nonce]);

  return (
    <div className="h-full flex flex-col bg-orion-surface">
      <div className="h-9 bg-orion-elevated/60 border-b border-orion-hairline flex items-center justify-between px-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-orion-paper">Preview</span>
          <span className="text-[10px] font-mono text-muted-foreground">iframe</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleRefresh}
            className="p-1.5 hover:bg-secondary/60 rounded text-muted-foreground hover:text-foreground transition-colors"
            title="Refresh Preview"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            className="p-1.5 hover:bg-secondary/60 rounded text-muted-foreground hover:text-foreground transition-colors"
            title="Open in New Tab"
            onClick={() => {
              const blob = new Blob([previewContent], { type: 'text/html' });
              const url = URL.createObjectURL(blob);
              window.open(url, '_blank');
            }}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="flex-1 bg-white">
        <iframe
          key={nonce}
          srcDoc={previewContent}
          className="w-full h-full border-0"
          title="Artifact Preview"
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
    </div>
  );
}

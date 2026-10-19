export interface PreviewFile {
  content: string;
  language?: string;
}

export interface PreviewManifest {
  framework?: string;
  previewFile?: string;
}

export type PreviewSelection =
  | { kind: 'html'; path: string }
  | { kind: 'unsupported'; framework: 'react' | 'nextjs' }
  | { kind: 'unavailable' };

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+/g, '/');
}

function packageDependencies(files: Record<string, PreviewFile>): Record<string, string> {
  const packageFile = files['package.json']?.content;
  if (!packageFile) return {};
  try {
    const packageJson = JSON.parse(packageFile) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...packageJson.devDependencies, ...packageJson.dependencies };
  } catch {
    return {};
  }
}

export function selectPreview(
  sourceFiles: Record<string, PreviewFile>,
  manifest?: PreviewManifest | null,
): PreviewSelection {
  const files = Object.fromEntries(
    Object.entries(sourceFiles).map(([path, file]) => [normalizePath(path), file]),
  );
  const dependencies = packageDependencies(files);
  const isNext =
    manifest?.framework === 'nextjs' ||
    Boolean(dependencies.next) ||
    Object.keys(files).some((path) => /(^|\/)next\.config\.[^/]+$/.test(path));
  if (isNext) return { kind: 'unsupported', framework: 'nextjs' };

  const isReact =
    manifest?.framework === 'react' ||
    manifest?.framework === 'vite' ||
    Boolean(dependencies.react) ||
    Object.keys(files).some((path) =>
      /(^|\/)(?:main|index|App)\.(?:tsx|ts|jsx|js)$/.test(path),
    );
  if (isReact) return { kind: 'unsupported', framework: 'react' };

  const preferredHtml = manifest?.previewFile
    ? normalizePath(manifest.previewFile)
    : undefined;
  const htmlPath = [
    ...(preferredHtml ? [preferredHtml] : []),
    'index.html',
    'public/index.html',
    ...Object.keys(files).filter((path) => path.endsWith('/index.html')),
  ].find((path) => Boolean(files[path]));

  return htmlPath ? { kind: 'html', path: htmlPath } : { kind: 'unavailable' };
}

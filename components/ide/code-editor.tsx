'use client';

import { useMemo } from 'react';

interface FileNode {
  name: string;
  type: 'file' | 'folder';
  language?: string;
  content?: string;
}

interface CodeEditorProps {
  file: FileNode | null | undefined;
}

/**
 * Lightweight code viewer — Monaco is avoided on purpose.
 * Next.js 16 + Turbopack breaks monaco workers (unhandled ErrorEvent).
 */
export function CodeEditor({ file }: CodeEditorProps) {
  const lines = useMemo(() => {
    const content = file?.content ?? '';
    return content.length > 0 ? content.split(/\r?\n/) : [''];
  }, [file?.content]);

  if (!file || file.type === 'folder') {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-sm mb-1">No file selected</p>
          <p className="text-xs text-muted-foreground/80">Pick a file from the explorer</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-9 shrink-0 bg-orion-elevated/60 border-b border-orion-hairline flex items-center justify-between px-3">
        <span className="text-xs font-mono text-muted-foreground truncate">{file.name}</span>
        <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wide">
          {file.language || file.name.split('.').pop() || 'text'}
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto bg-[#0f1218]">
        <table className="w-full border-collapse font-mono text-[13px] leading-5">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="hover:bg-white/[0.03]">
                <td className="select-none align-top text-right pr-3 pl-3 py-0 text-muted-foreground/40 w-12 border-r border-white/5 sticky left-0 bg-[#0f1218]">
                  {i + 1}
                </td>
                <td className="align-top pl-3 pr-4 py-0 text-[#d7dde8] whitespace-pre">
                  {line.length > 0 ? line : ' '}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

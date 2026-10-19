'use client';

import { useState, useMemo } from 'react';
import { Plan } from '@/lib/orion';
import { motion } from 'framer-motion';
import { Eye, Code, Files, ListTodo, Download, Loader2, FolderOpen } from 'lucide-react';
import { FileExplorer } from '@/components/ide/file-explorer';
import { CodeEditor } from '@/components/ide/code-editor';
import { PreviewPanel } from '@/components/ide/preview-panel';
import { selectPreview } from '@/components/ide/preview-runtime';
import { VirtualFileSystem as VFS, VFSNode, VFSFile, VFSMap } from '@/lib/orion/artifact-engine';

interface ArtifactWorkspaceProps {
  plan: Plan | null;
  artifacts?: {
    manifest: any;
    vfs: Record<string, VFSFile>;
    validation: any;
    framework: string;
    previewable: boolean;
  } | null | Record<string, any>;
  taskResults?: Record<string, any>;
}

type TabType = 'preview' | 'code' | 'files' | 'execution' | 'download';

interface FileNode {
  name: string;
  type: 'file' | 'folder';
  children?: FileNode[];
  language?: string;
  content?: string;
}

export function ArtifactWorkspace({ plan, artifacts: backendArtifacts }: ArtifactWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<TabType>('execution');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const parsedArtifacts = useMemo(() => {
    if (backendArtifacts && 'vfs' in backendArtifacts && backendArtifacts.vfs) {
      const vfsMap = new Map(Object.entries(backendArtifacts.vfs)) as VFSMap;
      const tree = VFS.buildTree(vfsMap);
      return convertVFSNodeToFileNode(tree);
    }
    return [];
  }, [backendArtifacts]);

  const hasArtifacts = parsedArtifacts.length > 0;

  function convertVFSNodeToFileNode(nodes: VFSNode[]): FileNode[] {
    return nodes.map((node) => {
      if (node.type === 'file') {
        return {
          name: node.name,
          type: 'file',
          language: node.file?.language,
          content: node.file?.content,
        };
      }
      return {
        name: node.name,
        type: 'folder',
        children: node.children ? convertVFSNodeToFileNode(node.children) : [],
      };
    });
  }

  const getFileByPath = (
    files: FileNode[],
    targetPath: string,
    currentPath: string = '',
  ): FileNode | null => {
    for (const file of files) {
      const fullPath = currentPath ? `${currentPath}/${file.name}` : file.name;
      if (file.type === 'file' && fullPath === targetPath) return file;
      if (file.children) {
        const found = getFileByPath(file.children, targetPath, fullPath);
        if (found) return found;
      }
    }
    return null;
  };

  const getFirstFile = (files: FileNode[]): FileNode | null => {
    for (const file of files) {
      if (file.type === 'file') return file;
      if (file.children) {
        const found = getFirstFile(file.children);
        if (found) return found;
      }
    }
    return null;
  };

  const statusTone = (status: string) => {
    switch (status) {
      case 'completed':
        return 'border-emerald-500/25 bg-emerald-500/5';
      case 'failed':
        return 'border-red-500/25 bg-red-500/5';
      case 'in_progress':
        return 'border-orion-ink/30 bg-orion-ink/5';
      default:
        return 'border-orion-hairline bg-orion-elevated/40';
    }
  };

  const renderTabContent = () => {
    if (!plan) {
      return (
        <div className="h-full flex items-center justify-center">
          <div className="text-center text-muted-foreground">
            <FolderOpen className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">No execution in progress</p>
          </div>
        </div>
      );
    }

    switch (activeTab) {
      case 'preview': {
        const artifactVfs =
          backendArtifacts && 'vfs' in backendArtifacts
            ? backendArtifacts.vfs
            : {};
        const manifest =
          backendArtifacts && 'manifest' in backendArtifacts
            ? backendArtifacts.manifest
            : undefined;
        const hasBrowserEntry =
          selectPreview(artifactVfs, manifest).kind !== 'unavailable';
        const frameworkPreviewable =
          backendArtifacts !== null &&
          backendArtifacts !== undefined &&
          'previewable' in backendArtifacts &&
          backendArtifacts.previewable === true;

        if (
          !hasArtifacts ||
          !backendArtifacts ||
          (!frameworkPreviewable && !hasBrowserEntry)
        ) {
          return (
            <EmptyTab message="No browser preview entry was generated for this project" />
          );
        }
        return (
          <PreviewPanel
            vfs={artifactVfs}
            manifest={manifest}
            onOpenCode={() => setActiveTab('code')}
          />
        );
      }

      case 'code':
        if (!hasArtifacts) return <EmptyTab message="No files generated yet" />;
        return (
          <div className="h-full flex min-h-0">
            <div className="w-56 shrink-0 border-r border-orion-hairline">
              <FileExplorer
                files={parsedArtifacts}
                selectedFile={selectedFile}
                onFileSelect={setSelectedFile}
              />
            </div>
            <div className="flex-1 min-w-0">
              <CodeEditor
                file={
                  selectedFile
                    ? getFileByPath(parsedArtifacts, selectedFile)
                    : getFirstFile(parsedArtifacts)
                }
              />
            </div>
          </div>
        );

      case 'files':
        if (!hasArtifacts) return <EmptyTab message="No files generated yet" />;
        return (
          <div className="h-full p-3">
            <FileExplorer
              files={parsedArtifacts}
              selectedFile={selectedFile}
              onFileSelect={setSelectedFile}
            />
          </div>
        );

      case 'execution':
        return (
          <div className="h-full p-4 overflow-auto space-y-3">
            <h3 className="text-sm font-medium text-orion-paper">Execution log</h3>
            {backendArtifacts &&
              'validation' in backendArtifacts &&
              ((backendArtifacts.validation?.warnings?.length ?? 0) > 0 ||
                (backendArtifacts.validation?.errors?.length ?? 0) > 0) && (
                <div className="p-3 border border-orion-hairline rounded-md bg-orion-elevated/50 space-y-2">
                  {backendArtifacts.validation?.warnings?.length > 0 && (
                    <div>
                      <p className="text-xs text-amber-400/90 mb-1">Warnings</p>
                      <ul className="list-disc list-inside text-[11px] text-muted-foreground space-y-0.5">
                        {backendArtifacts.validation.warnings.map((w: string, i: number) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {backendArtifacts.validation?.errors?.length > 0 && (
                    <div>
                      <p className="text-xs text-red-400/90 mb-1">Errors</p>
                      <ul className="list-disc list-inside text-[11px] text-muted-foreground space-y-0.5">
                        {backendArtifacts.validation.errors.map((e: string, i: number) => (
                          <li key={i}>{e}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            <div className="space-y-2">
              {plan.tasks.map((task, i) => (
                <motion.div
                  key={task.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.04, 0.2) }}
                  className={`p-3 rounded-md border ${statusTone(task.status)}`}
                >
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <span className="text-sm text-foreground">{task.description}</span>
                    <span className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground flex items-center gap-1 shrink-0">
                      {task.status === 'in_progress' && (
                        <Loader2 className="w-3 h-3 animate-spin text-orion-ink" />
                      )}
                      {task.status}
                    </span>
                  </div>
                  {task.result != null && (
                    <pre className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap max-h-40 overflow-auto">
                      {typeof task.result === 'string'
                        ? task.result
                        : JSON.stringify(task.result, null, 2)}
                    </pre>
                  )}
                </motion.div>
              ))}
            </div>
          </div>
        );

      case 'download':
        if (!hasArtifacts) return <EmptyTab message="No files to download yet" />;
        return (
          <div className="h-full flex flex-col items-center justify-center gap-4 p-8">
            <div className="text-center space-y-1">
              <h3 className="text-sm font-medium text-orion-paper">Export project</h3>
              <p className="text-xs text-muted-foreground font-mono">
                {Object.keys(backendArtifacts?.vfs ?? {}).length} files
              </p>
            </div>
            <button
              type="button"
              className="h-10 px-5 rounded-md bg-orion-ink text-primary-foreground text-sm font-medium hover:opacity-90 flex items-center gap-2"
              onClick={async () => {
                const vfs = backendArtifacts?.vfs;
                if (!vfs || Object.keys(vfs).length === 0) return;

                try {
                  const JSZip = (await import('jszip')).default;
                  const zip = new JSZip();

                  for (const [filePath, fileData] of Object.entries(vfs) as [string, any][]) {
                    const content = fileData?.content ?? '';
                    zip.file(filePath.replace(/^\//, ''), content);
                  }

                  const blob = await zip.generateAsync({ type: 'blob' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'orion-project.zip';
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  setTimeout(() => URL.revokeObjectURL(url), 10_000);
                } catch (err) {
                  console.error('ZIP download failed:', err);
                }
              }}
            >
              <Download className="w-4 h-4" />
              Download ZIP
            </button>
          </div>
        );

      default:
        return null;
    }
  };

  const tabs: { id: TabType; label: string; icon: typeof Eye }[] = [
    { id: 'execution', label: 'Log', icon: ListTodo },
    { id: 'preview', label: 'Preview', icon: Eye },
    { id: 'code', label: 'Code', icon: Code },
    { id: 'files', label: 'Files', icon: Files },
    { id: 'download', label: 'Export', icon: Download },
  ];

  return (
    <div className="h-full bg-orion-surface flex flex-col min-h-0">
      <div className="flex items-center gap-0.5 px-2 border-b border-orion-hairline bg-orion-elevated/50 shrink-0">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const disabled = tab.id !== 'execution' && !hasArtifacts;
          const active = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => !disabled && setActiveTab(tab.id)}
              disabled={disabled}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors border-b-2 -mb-px ${
                active
                  ? 'text-orion-paper border-orion-ink'
                  : disabled
                    ? 'text-muted-foreground/40 border-transparent cursor-not-allowed'
                    : 'text-muted-foreground border-transparent hover:text-foreground'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-hidden min-h-0">{renderTabContent()}</div>
    </div>
  );
}

function EmptyTab({ message }: { message: string }) {
  return (
    <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

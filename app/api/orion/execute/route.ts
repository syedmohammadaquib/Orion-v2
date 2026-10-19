import { z } from 'zod';
import {
  createOrionSystem,
  ArtifactEngine,
  VirtualFileSystem,
  hasExtractableCode,
  isSkippedTaskResult,
} from '@/lib/orion';
import { NextRequest } from 'next/server';
import { extractUploadedDocuments } from '@/lib/orion/tools/document-extractor';
import type { RagDocument } from '@/lib/orion/rag';

export const runtime = 'nodejs';
export const maxDuration = 300;

const ExecuteBodySchema = z.object({
  objective: z
    .string()
    .trim()
    .min(10, 'objective must be at least 10 characters')
    .max(3000, 'objective must be under 3000 characters'),
  priority: z.enum(['speed', 'quality', 'cost', 'balanced']).default('balanced'),
});

function jsonError(status: number, error: string, code: string, retryAfter?: number) {
  const body: Record<string, unknown> = { error, code };
  if (retryAfter != null) body.retryAfter = retryAfter;
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(retryAfter != null ? { 'Retry-After': String(retryAfter) } : {}),
    },
  });
}

function encodeSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function toResultString(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result);
}

export async function POST(request: NextRequest) {
  let requestFields: z.infer<typeof ExecuteBodySchema> | null = null;
  let validationError: string | null = null;
  let uploadedDocuments: RagDocument[] = [];
  try {
    if (request.headers.get('content-type')?.includes('multipart/form-data')) {
      const form = await request.formData();
      const fields = ExecuteBodySchema.safeParse({
        objective: form.get('objective'),
        priority: form.get('priority') || 'balanced',
      });
      if (!fields.success) {
        validationError = fields.error.issues[0]?.message || 'Invalid request body';
      } else {
        const fileParts = form.getAll('files');
        const files = fileParts.filter((part): part is File => part instanceof File);
        if (files.length !== fileParts.length) {
          return jsonError(422, 'Uploaded files must use the files field.', 'INVALID_UPLOAD');
        }
        uploadedDocuments = await extractUploadedDocuments(files);
        requestFields = fields.data;
      }
    } else {
      const raw: unknown = await request.json();
      const fields = ExecuteBodySchema.safeParse(raw);
      if (fields.success) requestFields = fields.data;
      else validationError = fields.error.issues[0]?.message || 'Invalid request body';
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not process request.';
    return jsonError(422, message, 'INVALID_UPLOAD');
  }

  if (!requestFields) {
    return jsonError(422, validationError || 'Invalid request body', 'VALIDATION_ERROR');
  }

  const { objective: safeObjective, priority: safePriority } = requestFields;

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  const write = async (event: string, data: unknown) => {
    try {
      await writer.write(encoder.encode(encodeSSE(event, data)));
    } catch {
      // client disconnected
    }
  };

  (async () => {
    try {
      const orion = createOrionSystem();
      const artifactEngine = new ArtifactEngine();

      orion.onExecutionUpdate(async (status: string, data: unknown) => {
        await write(status, data);
      });

      await write('connected', {
        message: 'Orion AI stream connected',
        objective: safeObjective,
        uploadedDocuments: uploadedDocuments.map((document) => document.name),
      });

      if (uploadedDocuments.length > 0) {
        await write('indexing_documents', {
          message: 'Extracting and embedding uploaded documents for this run',
          documents: uploadedDocuments.map((document) => document.name),
        });
        await orion.indexDocuments(uploadedDocuments);
      }

      const plan = await orion.executePlan(safeObjective, safePriority);
      const executionState = orion.getExecutionState();
      const summary = orion.getPlanSummary();
      const memory = orion.getSharedMemory();
      const taskLogs = (memory as any).taskExecutionLog || [];

      const engineResults: ReturnType<ArtifactEngine['process']>[] = [];
      const taskResults: Record<string, unknown> = {};
      const warnings: string[] = [];

      if (memory.research_degraded_note) {
        warnings.push(String(memory.research_degraded_note));
      }

      for (const task of plan.tasks) {
        if (!task.result) continue;
        const resultStr = toResultString(task.result);
        if (isSkippedTaskResult(resultStr)) {
          taskResults[task.id] = {
            description: task.description,
            status: task.status,
            agent: task.assignedTo,
            result: resultStr.substring(0, 500),
            fullResult: task.result,
            artifacts: [],
            skipped: true,
          };
          continue;
        }

        // Engineering always goes through the parser (pathless fences get stable paths).
        // Other agents only when output looks like extractable code.
        const shouldProcess =
          task.assignedTo === 'engineering' ||
          (task.assignedTo !== 'research' &&
            task.assignedTo !== 'marketing' &&
            hasExtractableCode(resultStr));

        let engineResult: ReturnType<ArtifactEngine['process']> | null = null;
        if (shouldProcess) {
          if (task.assignedTo === 'engineering' || hasExtractableCode(resultStr)) {
            engineResult = artifactEngine.process(resultStr);
            if (engineResult.vfs.size > 0) {
              if (task.assignedTo === 'engineering') engineResults.unshift(engineResult);
              else engineResults.push(engineResult);
            }
          }
        }

        taskResults[task.id] = {
          description: task.description,
          status: task.status,
          agent: task.assignedTo,
          result: resultStr.substring(0, 500),
          fullResult: task.result,
          artifacts: engineResult ? Array.from(engineResult.vfs.keys()) : [],
        };
      }

      // Fallback: engineering wrote to shared memory but task.result was empty/stripped
      if (engineResults.length === 0 && typeof memory.engineering_task_result === 'string') {
        const fallback = String(memory.engineering_task_result);
        if (hasExtractableCode(fallback) || fallback.includes('```')) {
          const engineResult = artifactEngine.process(fallback);
          if (engineResult.vfs.size > 0) {
            engineResults.push(engineResult);
            warnings.push('Recovered project files from engineering shared memory fallback.');
          }
        }
      }

      let finalResult: ReturnType<ArtifactEngine['merge']> | null = null;
      if (engineResults.length > 0) {
        finalResult = artifactEngine.merge(engineResults);
      } else {
        const engineeringRan = plan.tasks.some(
          (t) =>
            t.assignedTo === 'engineering' &&
            t.status === 'completed' &&
            t.result &&
            !isSkippedTaskResult(toResultString(t.result)),
        );
        if (engineeringRan) {
          warnings.push(
            'Engineering completed but no structured files were parsed. Models must return code fences (ideally path-tagged like ```tsx path="src/App.tsx").',
          );
        }
      }

      const totalCost = taskLogs.reduce(
        (sum: number, log: any) => sum + (log.actualCost || 0),
        0,
      );
      const estimatedCost = taskLogs.reduce(
        (sum: number, log: any) => sum + (log.estimatedCost || 0),
        0,
      );
      const avgConfidence =
        taskLogs.length > 0
          ? taskLogs.reduce((sum: number, log: any) => sum + (log.confidence || 0), 0) /
            taskLogs.length
          : 0;
      const totalLatency = taskLogs.reduce(
        (sum: number, log: any) => sum + (log.latency || 0),
        0,
      );

      await write('result', {
        success: true,
        plan,
        executionState,
        summary,
        taskResults,
        warnings,
        artifacts: finalResult
          ? {
              manifest: finalResult.manifest,
              vfs: VirtualFileSystem.toFlatRecord(finalResult.vfs),
              validation: {
                ...finalResult.validation,
                warnings: [...(finalResult.validation.warnings || []), ...warnings],
              },
              framework: finalResult.framework.id,
              previewable: finalResult.previewable,
            }
          : null,
        metrics: {
          totalTasks: plan.tasks.length,
          completedTasks: summary.completed,
          failedTasks: summary.failed,
          totalCost: Number(totalCost.toFixed(4)),
          estimatedCost: Number(estimatedCost.toFixed(4)),
          averageConfidence: Number(avgConfidence.toFixed(2)),
          totalLatency,
          tasksPerSecond:
            totalLatency > 0
              ? Number(((plan.tasks.length / totalLatency) * 1000).toFixed(2))
              : 0,
        },
        executionLog: taskLogs,
      });
    } catch (error) {
      await write('error', {
        error: error instanceof Error ? error.message : 'Failed to execute plan',
        code: 'EXECUTION_ERROR',
      });
    } finally {
      try {
        await writer.close();
      } catch {
        // already closed
      }
    }
  })();

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

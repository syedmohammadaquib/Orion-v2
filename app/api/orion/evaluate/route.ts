import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  evaluateModels,
  getEvaluationModels,
  getOpenRouterClient,
  isEvaluationModelForRole,
} from '@/lib/orion';

export const runtime = 'nodejs';
export const maxDuration = 300;

const EvaluationBodySchema = z.object({
  role: z.enum(['planner', 'engineering', 'research', 'marketing']),
  objective: z.string().trim().min(10).max(2000),
  models: z.array(z.string().min(1).max(100)).min(2).max(3).refine(
    (models) => new Set(models).size === models.length,
    'Select each model only once.',
  ),
});

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export async function GET(request: NextRequest) {
  const requestedRole = request.nextUrl.searchParams.get('role') ?? 'research';
  const role = z.enum(['planner', 'engineering', 'research', 'marketing']).safeParse(requestedRole);
  if (!role.success) {
    return json({ error: 'Unsupported agent role.' }, 422);
  }
  return json({ models: getEvaluationModels(role.data) });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Request body must be valid JSON.' }, 400);
  }

  const parsed = EvaluationBodySchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: parsed.error.issues[0]?.message ?? 'Invalid evaluation request.' }, 422);
  }

  const { role, objective, models } = parsed.data;
  const invalidModel = models.find((model) => !isEvaluationModelForRole(model, role));
  if (invalidModel) {
    return json({ error: `${invalidModel} is not available for the ${role} role.` }, 422);
  }

  try {
    const result = await evaluateModels(getOpenRouterClient(), role, objective, models);
    return json(result);
  } catch (error) {
    console.error('[ModelEvaluation] Evaluation failed:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Model evaluation failed.' },
      502,
    );
  }
}

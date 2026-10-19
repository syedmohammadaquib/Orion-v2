import { BaseAgent } from '../base-agent';
import { AgentContext, AgentResponse } from '../types';
import { OpenRouterClient } from '../openrouter-client';
import { SharedMemory } from '../shared-memory';
import { formatRetrievedContext, InMemoryRagIndex } from '../rag';

const ENGINEERING_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_knowledge_base',
      description: 'Search the run-scoped uploaded documents and web sources for relevant passages.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 500 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_reference_source',
      description: 'Read a successfully fetched source page from the research phase.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
];

export class EngineeringAgent extends BaseAgent {
  constructor(
    openRouterClient: OpenRouterClient,
    sharedMemory: SharedMemory,
    model: string = 'openrouter/auto',
  ) {
    super('engineering', model, openRouterClient, sharedMemory);
  }

  getSystemPrompt(skill?: string): string {
    const constraints = (this.sharedMemory.get('task_constraints') as string[]) || [];
    const intentClassification = this.sharedMemory.get('intent_classification') as any;
    const isUIClone = intentClassification?.intent === 'UI_CLONE';
    const framework = intentClassification?.framework;
    const target = intentClassification?.target;
    const goal = intentClassification?.goal;

    let constraintText = '';
    if (constraints.length > 0) {
      constraintText =
        '\n\nINTENT-SPECIFIC CONSTRAINTS:\n' +
        constraints.map((c, i) => `${i + 1}. ${c}`).join('\n');
    }

    let expertiseText = `Your expertise includes:
- Frontend development (HTML, CSS, React, Vue, etc.)
- Backend services (APIs, databases, servers)
- System design and architecture
- Code quality and best practices
- Technical implementation strategies`;

    if (isUIClone) {
      expertiseText = `Your expertise includes:
- HTML5 semantic structure
- CSS3 styling and layouts
- Responsive web design
- JavaScript for interactivity (only when needed)`;
    }

    let frameworkInfo = '';
    if (framework) {
      frameworkInfo = `\n\nFRAMEWORK TO USE: ${framework}\nGenerate files for this framework ONLY. Use one consistent tree.`;
    }
    let targetInfo = '';
    if (target) {
      targetInfo = `\n\nREFERENCE TARGET: ${target}`;
    }
    let goalInfo = '';
    if (goal) {
      goalInfo = `\n\nOBJECTIVE: ${goal}`;
    }
    let projectAnalysisInfo = '';
    const projectAnalysis = this.sharedMemory.get('project_analysis');
    const researchOk = this.sharedMemory.get('research_ok');
    const degraded = this.sharedMemory.get('research_degraded_note');
    if (projectAnalysis && researchOk !== false) {
      projectAnalysisInfo = `\n\nPROJECT ANALYSIS FROM RESEARCH AGENT:\n${projectAnalysis}`;
    } else if (degraded) {
      projectAnalysisInfo = `\n\nNOTE: ${degraded}\nProceed using the user objective alone.`;
    }

    return `You are Orion's Engineering Agent — a careful software engineer who ships coherent repositories, not scattered snippets.

${skill ? `ASSIGNED SKILL: ${skill}\nOnly generate files for this skill area.` : ''}

${expertiseText}
${frameworkInfo}
${targetInfo}
${goalInfo}
${projectAnalysisInfo}

## PROJECT STRUCTURE CONTRACT (mandatory)
1. Pick ONE stack and ONE root layout. Never mix flat root files with nested src/ randomly.
2. Use real relative paths — no invented folders like "generated", no "Component-3.tsx".
3. Every code fence MUST include a file path. Prefer path="...". Also accepted: \`\`\`tsx src/App.tsx or \`\`\`src/App.tsx
   \`\`\`tsx path="src/App.tsx"
   Never emit only a JSON summary — code fences are required or the IDE will be empty.
4. Prefer these scaffolds (choose the one that matches the objective):

**Static HTML**
- index.html
- styles.css (or css/styles.css)
- script.js (optional)

**Vite + React**
- package.json
- vite.config.ts
- index.html
- src/main.tsx
- src/App.tsx
- src/index.css
- src/components/... (only if needed)

**Next.js App Router**
- package.json
- next.config.mjs
- app/layout.tsx
- app/page.tsx
- app/globals.css

**Python CLI / script**
- main.py or src/...
- requirements.txt
- README.md

5. Include package.json / requirements when the project needs dependencies.
6. File names must be stable and descriptive (Navbar.tsx, not Component1.tsx).
7. Do not wrap the whole project in a disposable outer folder (e.g. my-app/...). Paths start at the project root.
8. Do not emit generic counters/todos unless asked.
9. If skill is assigned, only emit that slice — but still place files in the correct folders of the SAME scaffold.
10. For Tailwind CSS, include a complete configuration for the chosen Tailwind major version. For Tailwind v3, configure non-empty content globs covering every source file that uses classes (for example, index.html and src/**/*.{js,ts,jsx,tsx}) and include the PostCSS setup.
11. Never use custom Tailwind utilities such as bg-light or text-dark in @apply unless their colors are defined in the Tailwind theme. Prefer standard built-in utilities, or define every custom theme token you use. Keep @apply classes valid for the selected Tailwind version.
12. Use the semantic knowledge-base search tool when you need supporting passages; cite the returned source labels.
${constraintText}

## OUTPUT FORMAT
Emit the files first as path-tagged fences, then a short JSON summary (not instead of the files):

\`\`\`tsx path="src/App.tsx"
export default function App() { return <main>Hello</main> }
\`\`\`

\`\`\`css path="src/index.css"
:root { color-scheme: dark; }
\`\`\`

\`\`\`json path="package.json"
{ "name": "project", "private": true }
\`\`\`

{
  "result": "Brief summary of the project structure",
  "reasoning": "Why this scaffold fits the objective",
  "files": ["package.json", "src/App.tsx", "src/index.css"],
  "success": true
}`;
  }

  async execute(context: AgentContext): Promise<AgentResponse> {
    this.sharedMemory.set('engineering_agent_active', true);

    try {
      const taskData = this.sharedMemory.get(`task_${context.taskId}`);
      const assignedSkill = (taskData as any)?.skill;
      const taskDescription = (taskData as any)?.description || '';
      const lastPlan = this.sharedMemory.get('last_plan') as any;
      const objective = lastPlan?.objective || '';
      const systemPrompt = this.getSystemPrompt(assignedSkill);

      const userMessage = `User objective: ${objective}

Task: ${context.taskId}
${taskDescription ? `Task description: ${taskDescription}` : ''}
${assignedSkill ? `Assigned skill: ${assignedSkill}` : ''}

Generate a coherent, structured project for this objective.
CRITICAL: Output the actual files as markdown code fences FIRST (with paths), then a brief JSON summary.
Example fence header: \`\`\`tsx path="src/App.tsx"
If you only return JSON / prose with no fences, the workspace will have zero files.
Keep output focused — only necessary files.`;
      const ragIndex = this.sharedMemory.get('rag_index');
      const hasResearch = ragIndex instanceof InMemoryRagIndex;
      const response = hasResearch
        ? await this.chatWithToolsForTask(
            [{ role: 'user', content: userMessage }],
            systemPrompt,
            {
              tools: ENGINEERING_TOOLS,
              maxCalls: 3,
              execute: async (name, args) => {
                if (name === 'search_knowledge_base') {
                  const query = args.query;
                  if (typeof query !== 'string' || !query.trim() || query.length > 500) {
                    throw new Error('Search queries must contain 1 to 500 characters.');
                  }
                  if (!(ragIndex instanceof InMemoryRagIndex)) {
                    throw new Error('No run-scoped knowledge base is available.');
                  }
                  const chunks = await ragIndex.search(
                    query,
                    (texts) => this.openRouterClient.embed(texts),
                    5,
                  );
                  return formatRetrievedContext(chunks);
                }
                if (name === 'get_reference_source') {
                  const url = args.url;
                  if (typeof url !== 'string') {
                    throw new Error('A source URL is required.');
                  }
                  const sources = this.sharedMemory.get('research_web_fetch');
                  if (!Array.isArray(sources)) return 'No fetched reference sources are available.';
                  const source = sources.find(
                    (item) =>
                      item &&
                      typeof item === 'object' &&
                      'url' in item &&
                      item.url === url &&
                      'ok' in item &&
                      item.ok === true,
                  );
                  if (!source || typeof source !== 'object' || !('text' in source)) {
                    return 'That URL is not an available successfully fetched source.';
                  }
                  return String(source.text).slice(0, 8000);
                }
                throw new Error(`Unsupported engineering tool: ${name}`);
              },
            },
          )
        : await this.chatForTask([{ role: 'user', content: userMessage }], systemPrompt);

      // CRITICAL: keep the full model output (fences + summary).
      // Never replace fences with the JSON "result" string — that drops all files.
      let reasoning = 'Completed engineering task with structured artifacts';
      try {
        const jsonMatch = response.content.match(/\{[\s\S]*"success"\s*:[\s\S]*\}\s*$/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.reasoning) reasoning = String(parsed.reasoning);
        }
      } catch {
        // summary optional
      }

      if (response.usage) {
        this.sharedMemory.set(`task_${context.taskId}_usage`, response.usage);
      }
      if (response.toolsUsed?.length) {
        this.sharedMemory.set(`task_${context.taskId}_tools`, response.toolsUsed);
      }
      this.sharedMemory.set(`task_${context.taskId}_model`, this.model);
      this.sharedMemory.set('engineering_task_result', response.content);

      return {
        taskId: context.taskId,
        result: response.content,
        reasoning,
        success: true,
      };
    } finally {
      this.sharedMemory.set('engineering_agent_active', false);
    }
  }

  async analyzeArchitecture(objective: string): Promise<string> {
    const systemPrompt = this.getSystemPrompt();
    const response = await this.chatForTask(
      [{ role: 'user', content: `Analyze the architecture needed for: ${objective}` }],
      systemPrompt,
    );
    return response.content;
  }

  async generateImplementationPlan(requirements: string): Promise<string> {
    const systemPrompt = this.getSystemPrompt();
    const response = await this.chatForTask(
      [{ role: 'user', content: `Create a detailed implementation plan for: ${requirements}` }],
      systemPrompt,
    );
    return response.content;
  }
}

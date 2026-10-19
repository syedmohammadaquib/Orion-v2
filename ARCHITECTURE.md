# Orion Architecture

Orion is a multi-agent orchestration console: it plans user objectives, runs specialized LLM agents, streams execution over SSE, and materializes code/docs into a virtual filesystem for preview and export.

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend Dashboard                        │
│              (Real-time Execution Monitoring)                │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                    API Routes                                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  POST /api/orion/plan   - Create & execute plans     │   │
│  │  GET  /api/orion/plan   - Retrieve current plan      │   │
│  │  GET  /api/orion/state  - Get execution state        │   │
│  └──────────────────────────────────────────────────────┘   │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                  Orchestrator                                │
│  • Coordinates all agents and systems                        │
│  • Executes plans sequentially with feedback                 │
│  • Manages execution lifecycle                               │
│  • Provides real-time execution updates                      │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
        ▼            ▼            ▼
   ┌────────┐  ┌────────┐  ┌──────────┐
   │Planning│  │Execution         │
   │Engine  │  │Tracking          │
   └────────┘  └──────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│                  Planning Engine                             │
│  • Receives objectives from users                            │
│  • Dispatches to Planner Agent                              │
│  • Manages plan generation                                   │
│  • Tracks execution state and progress                       │
│  • Computes summaries and metrics                            │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│                   Planner Agent                              │
│          Model: DeepSeek Chat                               │
│  • Analyzes objective                                        │
│  • Breaks down into executable tasks                         │
│  • Prioritizes by dependency and importance                  │
│  • Assigns tasks to appropriate agents                       │
│  • Returns structured plan with reasoning                    │
└─────────────────────────────────────────────────────────────┘
        │
        └─────────────────┬────────────────────┬────────────┐
                          │                    │            │
                          ▼                    ▼            ▼
        ┌─────────────────────────┐  ┌──────────────────┐  ┌──────────────────┐
        │  Engineering Agent      │  │  Research Agent  │  │ Marketing Agent  │
        │  Model: DeepSeek Chat   │  │  Model: Gemini  │  │ Model: Gemini    │
        │                         │  │                  │  │ 2.5 Flash        │
        │ • Architecture design   │  │ • Market research│  │ • Brand strategy │
        │ • Code strategy         │  │ • Trend analysis │  │ • Campaign plan  │
        │ • Implementation plans  │  │ • Competitive    │  │ • Messaging      │
        │ • Performance optim.    │  │   analysis       │  │ • Growth tactics │
        │ • Technical guidance    │  │ • Data insights  │  │ • ROI planning   │
        └─────────────────────────┘  └──────────────────┘  └──────────────────┘
        │                                 │                      │
        └─────────────────┬───────────────┴──────────────────────┘
                          │
                          ▼
        ┌─────────────────────────────────────────────────┐
        │         Shared Memory System                    │
        │  • Global context accessible to all agents     │
        │  • Tracks task results and reasoning            │
        │  • Maintains execution history                  │
        │  • Enables cross-agent knowledge sharing        │
        └─────────────────────────────────────────────────┘
                          │
                          ▼
        ┌─────────────────────────────────────────────────┐
        │         OpenRouter Client                       │
        │  • Unified API to multiple models              │
        │  • Handles streaming and non-streaming         │
        │  • Manages authentication and headers           │
        │  • Rate limiting and error handling             │
        └─────────────────────────────────────────────────┘
                          │
                          ▼
        ┌─────────────────────────────────────────────────┐
        │         OpenRouter API Service                  │
        │  • DeepSeek Chat                                 │
        │  • Claude Sonnet 4 / Gemini 2.5 Pro / R1        │
        │  • Gemini 2.5 Flash                             │
        │  • Additional models via OpenRouter             │
        └─────────────────────────────────────────────────┘
```

## Component Details

### 1. Orchestrator (`lib/orion/orchestrator.ts`)
The central coordinator of the Orion system.

**Responsibilities:**
- Receives objectives from users
- Delegates to planning engine
- Executes generated plans
- Manages agent lifecycle
- Provides real-time execution updates

**Key Methods:**
```typescript
async executePlan(objective: string): Promise<Plan>
getCurrentPlan(): Plan | null
getExecutionState(): ExecutionState
getPlanSummary(): PlanSummary
onExecutionUpdate(callback: Function): void
```

### 2. Planning Engine (`lib/orion/planning-engine.ts`)
Manages plan generation and execution tracking.

**Responsibilities:**
- Communicates with Planner Agent
- Parses and structures plan responses
- Tracks execution state
- Manages agent running status
- Computes metrics and summaries

**State Management:**
- `currentPlan`: Active plan being executed
- `executionState`: Running tasks, agents, metrics
- `sharedMemory`: Cross-agent context

### 3. Base Agent (`lib/orion/base-agent.ts`)
Abstract foundation for all specialized agents.

**Key Features:**
- System prompt engineering
- Task context building
- Response parsing and validation
- Memory integration
- Error handling and recovery

**Lifecycle:**
```
Context Setup → Generate Prompt → Call Model → Parse Response 
    → Store Results → Update Memory → Return Response
```

### 4. Specialized Agents

#### Planner Agent (`lib/orion/agents/planner.ts`)
**Model**: DeepSeek Chat (default; env override supported)
- Analyzes objectives for required tasks
- Prioritizes by dependency and importance
- Assigns to appropriate specialized agents
- Generates reasoning for plan structure

#### Engineering Agent (`lib/orion/agents/engineering.ts`)
**Model**: DeepSeek Chat by default, with router-selected coding models from the catalog
- System architecture and design expertise
- Code generation and implementation strategy
- Technical problem solving
- Performance optimization

#### Research Agent (`lib/orion/agents/research.ts`)
**Model**: Gemini 2.5 Flash by default; quality priority can route to Gemini 2.5 Pro or DeepSeek R1
- Market and competitive analysis
- Technology research and trends
- Data-driven insights
- Evidence-based recommendations

#### Marketing Agent (`lib/orion/agents/marketing.ts`)
**Model**: Gemini 2.5 Flash by default for writing tasks
- Brand strategy and positioning
- Campaign planning and tactics
- Customer segmentation
- Growth optimization

### 5. Shared Memory System (`lib/orion/shared-memory.ts`)
Global context accessible to all agents during execution.

**Features:**
- Key-value storage with timestamps
- Task result persistence
- Reasoning and analysis tracking
- Cross-agent information sharing
- Execution history

**Example Memory Contents:**
```json
{
  "task_1_result": "Task output",
  "task_1_reasoning": "How task was solved",
  "engineering_agent_active": true,
  "plan_objective": "Original objective",
  "market_research_findings": "R&D results"
}
```

### 6. OpenRouter Client (`lib/orion/openrouter-client.ts`)
Unified interface to OpenRouter API for all models.

**Methods:**
```typescript
async chat(model, messages, systemPrompt): Promise<string>
async stream(model, messages, systemPrompt): Promise<AsyncIterable>
```

**Supported Models (defaults — see `model-config.ts` / `model-router.ts`):**
- DeepSeek Chat (`deepseek/deepseek-chat`)
- Qwen3 Coder (`qwen/qwen3-coder`)
- Claude Sonnet 4 (`anthropic/claude-sonnet-4`)
- GPT-4.1 (`openai/gpt-4.1`)
- Gemini 2.5 Pro (`google/gemini-2.5-pro`)
- DeepSeek R1 (`deepseek/deepseek-r1`)
- OpenAI o4-mini (`openai/o4-mini`)
- Gemini 2.5 Flash (`google/gemini-2.5-flash`)
- GPT-4.1 Mini (`openai/gpt-4.1-mini`)
- Claude Haiku 4.5 (`anthropic/claude-haiku-4.5`)
- DeepSeek Chat V3.1 free (`deepseek/deepseek-chat-v3.1:free`) and OpenRouter Auto (`openrouter/auto`) as budget fallbacks

### 7. Model Configuration (`lib/orion/model-config.ts`)
Centralized default model assignment for each agent.

**Default Configuration:**
```typescript
AGENT_MODELS = {
  planner: 'deepseek/deepseek-chat',
  engineering: 'deepseek/deepseek-chat',
  research: 'google/gemini-2.5-flash',
  marketing: 'google/gemini-2.5-flash',
}
```

**Override via Environment:**
```env
PLANNER_MODEL=deepseek/deepseek-chat
ENGINEERING_MODEL=deepseek/deepseek-chat
RESEARCH_MODEL=google/gemini-2.5-flash
MARKETING_MODEL=google/gemini-2.5-flash
```

## Execution Flow

### Step 1: Objective Input
```
User Input: "Build a mobile app for tracking fitness goals"
    ↓
Dashboard → API Endpoint → Orchestrator.executePlan()
```

### Step 2: Plan Generation
```
Orchestrator → Planning Engine
    ↓
Planning Engine → Planner Agent (DeepSeek Chat by default, router-selected by priority)
    ↓
Planner analyzes objective and generates tasks:
  - Task 1: Define app architecture (→ Engineering)
  - Task 2: Research market trends (→ Research)
  - Task 3: Create marketing strategy (→ Marketing)
```

### Step 3: Task Execution
```
Orchestrator iterates through tasks:

For each task:
  1. Mark agent as running
  2. Build task context with shared memory
  3. Call appropriate agent with task context
  4. Receive and parse response
  5. Store results in shared memory
  6. Mark task complete/failed
  7. Send execution update to dashboard
  8. Brief delay before next task
```

### Step 4: Result Aggregation
```
Planning Engine computes summary:
  - Total tasks: 3
  - Completed: 3
  - Failed: 0
  - Total duration: X seconds
  
Results available via:
  - Dashboard (real-time)
  - GET /api/orion/plan (stored plan)
  - GET /api/orion/state (execution state)
```

## Data Flow

### Request Flow
```
Browser → POST /api/orion/plan
   ↓
Orchestrator.executePlan(objective)
   ↓
Planning Engine → Planner Agent
   ↓
Parse plan → Store in memory
   ↓
For each task → Agent execution
   ↓
Collect results → Return response
   ↓
Browser receives → Dashboard updates
```

### Real-time Updates
```
Orchestrator.executePlan() calls:
  notifyUpdate(status, data)
    ↓
Dashboard polls GET /api/orion/state
    ↓
Returns current execution state
    ↓
Dashboard renders real-time updates
```

## Memory Management

### Task-Level Memory
Each task stores in shared memory:
```json
{
  "task_<id>_result": "Task output",
  "task_<id>_reasoning": "Solution approach",
  "task_<id>_status": "completed|failed"
}
```

### Plan-Level Memory
```json
{
  "plan_<id>": { /* Full plan object */ },
  "last_plan": { /* Most recent plan */ }
}
```

### Agent-Specific Memory
```json
{
  "<agent>_agent_active": true|false,
  "<agent>_task_result": { /* Result */ }
}
```

## Error Handling

### Task Execution Errors
```
Try: Execute task with agent
  ↓
Catch: Error occurs
  ↓
Action: Mark task as failed
  ↓
Store: Error message in memory
  ↓
Continue: Next task
```

### Model Errors
```
OpenRouter API Error
  ↓
Retry: Built into OpenAI client
  ↓
Fallback: Return error response
  ↓
Agent: Gracefully handle failure
```

## Performance Considerations

### Sequential Execution
- Tasks execute one at a time
- Allows shared memory to accumulate context
- Prevents agent conflicts
- Enables knowledge sharing between agents

### Model Selection Impact
```
Fast Execution:     MiniMax M3, Kimi K2.7
Balanced:          DeepSeek Chat, Gemini 2.5 Flash, Claude Sonnet 4, GPT-4.1
High Quality:      DeepSeek R1 (slower)
```

### Optimization Strategies
1. Use faster models for simple tasks
2. Use specialized models for critical tasks
3. Batch related tasks together
4. Reuse shared memory from previous tasks

## Extension Points

### Adding New Agents
1. Extend `BaseAgent`
2. Implement `getSystemPrompt()`
3. Register in Orchestrator
4. Add model configuration

### Adding New Models
1. Update `lib/orion/model-config.ts`
2. Add to `MODEL_CONFIG` object
3. Assign to agent in `AGENT_MODELS`
4. Document in MODELS_GUIDE.md

### Custom Task Types
1. Extend `Task` interface in types
2. Update Planner to assign new type
3. Create agent method for type
4. Update dashboard UI if needed

## Security Architecture

### API Key Management
- `OPENROUTER_API_KEY` stored in environment
- Never exposed to client
- Only accessible server-side

### Data Isolation
- Shared memory isolated per execution
- No cross-plan memory leakage
- Client state separate from server state

### Rate Limiting
- OpenRouter handles API rate limits
- Automatic backoff and retry
- Error messages returned to user

## Monitoring and Debugging

### Console Logs
```typescript
console.log(`[v0] ${agentType} agent executing task: ${taskId}`);
console.log('[v0] Plan created with', plan.tasks.length, 'tasks');
```

### API State Inspection
```bash
curl http://localhost:3000/api/orion/state
```

### Dashboard Monitoring
- Real-time task progress
- Agent status indicators
- Shared memory inspector
- Execution history

## Conclusion

Orion's architecture provides a clean separation of concerns with specialized agents working through a coordinated orchestration system. The use of OpenRouter-backed models keeps the system flexible and configurable while still allowing for cost-aware routing. The system is designed to be extensible, allowing for custom agents and models as needed.

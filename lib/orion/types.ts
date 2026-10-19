// Orion Core Types

export type AgentType = 'engineering' | 'research' | 'marketing' | 'planner';

export interface TaskMetadata {
  taskId: string;
  agent: AgentType;
  selectedModel: string;
  fallbackModel?: string;
  selectionReason?: string;
  tokens: number;
  latency: number;
  confidence: number;
  estimatedCost: number;
  actualCost: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  artifactPaths?: string[];
  toolsUsed?: string[];
  executionStartTime?: string;
  executionEndTime?: string;
}

export interface Task {
  id: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  assignedTo?: AgentType;
  skill?: string;
  result?: string | unknown;
  metadata?: TaskMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface Plan {
  id: string;
  objective: string;
  tasks: Task[];
  status: 'planning' | 'executing' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentContext {
  planId: string;
  taskId: string;
  agentType: AgentType;
  conversationHistory: AgentMessage[];
  sharedMemory: Record<string, unknown>;
}

export interface AgentResponse {
  taskId: string;
  result: string | unknown;
  reasoning: string;
  nextSteps?: string[];
  success: boolean;
}

export interface ExecutionState {
  currentPlanId: string;
  currentTaskId: string;
  runningAgents: AgentType[];
  completedTasks: string[];
  failedTasks: string[];
  lastUpdate: string;
}

export interface OrionConfig {
  apiKey: string;
  baseUrl?: string;
  engineeringModel?: string;
  researchModel?: string;
  marketingModel?: string;
  plannerModel?: string;
}

export interface ApiErrorBody {
  error: string;
  code: string;
  retryAfter?: number;
}

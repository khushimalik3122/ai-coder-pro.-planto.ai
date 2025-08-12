// src/AgenticWorkflow.ts
import { RAGService } from './RAGService';
import { ContextManager } from './ContextManager';

/** === NEW: tool-using agent loop imports === */
import { ToolRegistry, ToolName, ToolResult } from './agent/Tooling';
import { ToolUseOrchestrator } from './modelManager'; // implements provider-agnostic tool-calling

export interface Agent {
  name: string;
  description: string;
  execute(query: string, context: string): Promise<string>;
}

/**
 * AgenticWorkflow
 * - Keeps your original intent router & specialized prompt builders
 * - Adds a Cursor-like autonomous loop (plan → act → observe → fix) via tools
 */
export class AgenticWorkflow {
  private agents: Map<string, Agent> = new Map();
  private ragService: RAGService;
  private contextManager: ContextManager;

  /** NEW: tool loop pieces (optional, but enabled when provided) */
  private tools?: ToolRegistry;
  private orchestrator?: ToolUseOrchestrator;

  constructor(
    ragService: RAGService,
    contextManager: ContextManager,
    opts?: {
      tools?: ToolRegistry;
      orchestrator?: ToolUseOrchestrator;
    }
  ) {
    this.ragService = ragService;
    this.contextManager = contextManager;
    this.tools = opts?.tools;
    this.orchestrator = opts?.orchestrator;
    this.initializeAgents();
  }

  /**
   * Initialize specialized agents (prompt-only)
   */
  private initializeAgents(): void {
    this.agents.set('codeReview', new CodeReviewAgent());
    this.agents.set('bugFinder', new BugFinderAgent());
    this.agents.set('testGen', new TestGenAgent());
    this.agents.set('refactor', new RefactorAgent());
    this.agents.set('documentation', new DocumentationAgent());
    this.agents.set('optimization', new OptimizationAgent());
  }

  /**
   * Analyze user intent and route to appropriate agent
   */
  async analyzeIntent(query: string): Promise<string> {
    const queryLower = query.toLowerCase();

    // Intent keywords mapping
    const intentKeywords: Record<string, string[]> = {
      codeReview: ['review', 'check', 'audit', 'examine', 'inspect'],
      bugFinder: ['bug', 'error', 'issue', 'problem', 'fix', 'debug'],
      testGen: ['test', 'unit', 'spec', 'coverage', 'testing'],
      refactor: ['refactor', 'improve', 'optimize', 'clean', 'restructure'],
      documentation: ['document', 'comment', 'explain', 'describe', 'doc'],
      optimization: ['optimize', 'performance', 'speed', 'efficient', 'fast'],
    };

    for (const [intent, keywords] of Object.entries(intentKeywords)) {
      if (keywords.some((k) => queryLower.includes(k))) {
        return intent;
      }
    }
    return 'general';
  }

  /**
   * Execute workflow with context-aware processing (prompt-only path)
   * Keeps your existing behavior: returns a prompt to be sent to the model.
   */
  async executeWorkflow(userQuery: string): Promise<string> {
    try {
      // 1. Analyze intent
      const intent = await this.analyzeIntent(userQuery);
      console.log(`🎯 Detected intent: ${intent}`);

      // 2. Get optimized context
      const context = await this.contextManager.getOptimizedContext(userQuery);

      // 3. Add user message
      this.contextManager.addMessage('user', userQuery);

      // 4. Execute with appropriate agent
      let result: string;
      if (intent === 'general') {
        result = await this.executeGeneralQuery(userQuery, context);
      } else {
        const agent = this.agents.get(intent);
        result = agent ? await agent.execute(userQuery, context) : await this.executeGeneralQuery(userQuery, context);
      }

      // 5. Add assistant response
      this.contextManager.addMessage('assistant', result);

      // 6. Summarize if needed
      if (this.contextManager.shouldSummarize()) {
        await this.contextManager.summarizeConversation();
      }

      return result;
    } catch (error: any) {
      console.error('Workflow execution error:', error);
      return `Sorry, I encountered an error: ${error?.message || 'Unknown error'}`;
    }
  }

  /**
   * NEW: Fully autonomous goal execution (Cursor-like)
   * Runs a tool-using loop: plan → act (tools) → observe → fix, up to a budget.
   * Requires that the extension constructed this workflow with { tools, orchestrator }.
   */
  async runGoal(
    goal: string,
    successCriteria = 'All tests pass or the dev server runs without errors.',
    onProgress?: (line: string) => void
  ): Promise<{ done: boolean; messages: { role: 'user'|'assistant'|'tool'; content: any }[] }> {
    if (!this.tools || !this.orchestrator) {
      throw new Error('Tooling not configured. Provide ToolRegistry and ToolUseOrchestrator in AgenticWorkflow constructor.');
    }

    const progress = (s: string) => {
      if (onProgress) onProgress(s);
      console.log(`[Agent] ${s}`);
    };

    // Prepare system + first messages
    const system = [
      'You are an autonomous software engineer working inside VS Code.',
      'Use the available tools to create/edit/delete files, run commands, and read diagnostics.',
      'Prefer minimal, targeted changes. Respect denied folders. Ask for no confirmations.',
      'If a command fails, read diagnostics, then propose precise fixes and try again.',
      'Stop when the success criteria are met and output FINAL_ANSWER with a brief status.'
    ].join('\n');

    // Feed prior context + current goal to help planning
    const ctx = await this.contextManager.getOptimizedContext(goal);

    const startMessages: { role: 'user'|'assistant'|'tool'; content: any }[] = [
      { role: 'user', content: `Context:\n${ctx}\n\nGoal: ${goal}\nSuccess criteria: ${successCriteria}` }
    ];

    // Tool catalog shared with the model
    const toolSpecs = this.buildToolSpecs();

    progress('Agent started…');
    const res = await this.orchestrator.runLoop({
      systemPrompt: system,
      messages: startMessages,
      tools: toolSpecs,
      maxIters: this.getMaxIters()
    });
    progress('Agent finished.');

    // Record into conversation history for continuity
    for (const m of res.messages) {
      if (m.role === 'tool') {
        this.contextManager.addMessage('tool', typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      } else if (m.role === 'assistant') {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        this.contextManager.addMessage('assistant', text);
      } else if (m.role === 'user') {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        this.contextManager.addMessage('user', text);
      }
    }
    return res;
  }

  /** NEW: tool catalog the model can use during the loop */
  private buildToolSpecs(): { name: ToolName; description: string; parameters?: any }[] {
    return [
      { name: 'read_file',           description: 'Read a file',                         parameters: { path: 'string' } },
      { name: 'write_file',          description: 'Create or overwrite a file',          parameters: { path: 'string', content: 'string', createDirs: 'boolean?' } },
      { name: 'apply_patch',         description: 'Replace file content entirely',       parameters: { path: 'string', newContent: 'string' } },
      { name: 'delete_path',         description: 'Delete a file or folder recursively', parameters: { path: 'string' } },
      { name: 'list_files',          description: 'List files under a folder',           parameters: { under: 'string?', max: 'number?' } },
      { name: 'search_in_workspace', description: 'Regex/i text search',                 parameters: { query: 'string', maxResults: 'number?' } },
      { name: 'run_command',         description: 'Run a shell command',                 parameters: { cmd: 'string', cwd: 'string?', timeoutSec: 'number?' } },
      { name: 'get_diagnostics',     description: 'Collect editor diagnostics',          parameters: { } },
      { name: 'git_status',          description: 'Git status (porcelain)',              parameters: { } },
      { name: 'git_commit',          description: 'Commit staged changes',               parameters: { message: 'string' } },
      { name: 'git_revert',          description: 'Revert to previous commit',          parameters: { commit: 'string?' } },
    ];
  }

  private getMaxIters(): number {
    // You can read from VS Code config if desired; default to 6.
    try {
      // Lazy import to avoid hard dependency if not running within VS Code yet
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const vscode = require('vscode') as typeof import('vscode');
      return vscode.workspace.getConfiguration().get<number>('aiCoderPro.maxIters') ?? 6;
    } catch {
      return 6;
    }
  }

  /**
   * Execute general query (fallback -> prompt for LLM)
   */
  private async executeGeneralQuery(query: string, context: string): Promise<string> {
    const enhancedPrompt = `
You are a helpful coding assistant.

${divider('Context')}
${context}

${divider('User Query')}
${query}

Please provide a helpful, accurate response based strictly on the context and query above.
If you propose code changes, include minimal, targeted patches and short explanations.
`;
    return enhancedPrompt.trim();
  }

  /** Get available agents */
  getAvailableAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  /** Get a specific agent */
  getAgent(name: string): Agent | undefined {
    return this.agents.get(name);
  }
}

/* ---------------- Specialized Agents (prompt builders) ---------------- */

class CodeReviewAgent implements Agent {
  name = 'Code Review Agent';
  description = 'Analyzes code for best practices, potential issues, and improvements';

  async execute(query: string, context: string): Promise<string> {
    const reviewPrompt = `
You are a senior code reviewer. Analyze the following code and provide a comprehensive review.

${divider('Code & Context')}
${context}

${divider('Review Request')}
${query}

Provide:
1) Code quality assessment
2) Potential issues or bugs
3) Best-practices recommendations
4) Security considerations
5) Performance improvements
6) Specific, actionable suggestions

Format with clear sections. Be concise and concrete.
`;
    return reviewPrompt.trim();
  }
}

class BugFinderAgent implements Agent {
  name = 'Bug Finder Agent';
  description = 'Identifies potential bugs, errors, and issues in code';

  async execute(query: string, context: string): Promise<string> {
    const bugPrompt = `
You are a bug detection specialist. Analyze the following code for potential issues.

${divider('Code & Context')}
${context}

${divider('Bug Detection Request')}
${query}

Identify:
- Syntax errors / typos
- Logic errors & edge cases
- Potential runtime errors
- Memory/performance pitfalls
- Security vulnerabilities
- Concurrency/race conditions

For each issue, provide:
• Description
• Severity (Low/Medium/High/Critical)
• Suggested fix
• Minimal code patch if applicable
`;
    return bugPrompt.trim();
  }
}

class TestGenAgent implements Agent {
  name = 'Test Generation Agent';
  description = 'Generates unit tests, integration tests, and test cases';

  async execute(query: string, context: string): Promise<string> {
    const testPrompt = `
You are a test generation specialist. Create comprehensive tests for the following code.

${divider('Code & Context')}
${context}

${divider('Test Generation Request')}
${query}

Generate:
- Unit tests for key functions/methods
- Integration tests for component interactions
- Edge-case scenarios & fixtures
- Coverage recommendations

Include examples for popular frameworks (Jest/Mocha/PyTest) and use clear naming & setup/teardown.
`;
    return testPrompt.trim();
  }
}

class RefactorAgent implements Agent {
  name = 'Refactor Agent';
  description = 'Suggests code refactoring and improvements';

  async execute(query: string, context: string): Promise<string> {
    const refactorPrompt = `
You are a refactoring specialist. Suggest maintainable improvements.

${divider('Code & Context')}
${context}

${divider('Refactor Request')}
${query}

Provide:
- Structure/design improvements
- Function extraction opportunities
- Naming readability
- Duplication removal
- Pattern applications
- Performance & clarity benefits

Show before/after snippets for each suggestion.
`;
    return refactorPrompt.trim();
  }
}

class DocumentationAgent implements Agent {
  name = 'Documentation Agent';
  description = 'Generates documentation, comments, and explanations';

  async execute(query: string, context: string): Promise<string> {
    const docPrompt = `
You are a documentation specialist. Produce clear, accurate docs.

${divider('Code & Context')}
${context}

${divider('Documentation Request')}
${query}

Deliver:
- Function/class documentation
- Code comments & rationale
- API docs & usage examples
- README sections & Quickstart
- Setup & installation steps
- Architecture overview

Use headings, examples, and step-by-step instructions.
`;
    return docPrompt.trim();
  }
}

class OptimizationAgent implements Agent {
  name = 'Optimization Agent';
  description = 'Suggests performance optimizations and improvements';

  async execute(query: string, context: string): Promise<string> {
    const optimizePrompt = `
You are a performance specialist. Identify and address bottlenecks.

${divider('Code & Context')}
${context}

${divider('Optimization Request')}
${query}

Provide:
- Bottleneck analysis
- Algorithmic improvements
- Memory usage optimizations
- Time/space complexity discussion
- Caching & batching strategies
- DB & network optimizations

Explain trade-offs; include small, targeted patches when possible.
`;
    return optimizePrompt.trim();
  }
}

/* ---------------- helpers ---------------- */

function divider(title: string): string {
  return `--- ${title} ---`;
}

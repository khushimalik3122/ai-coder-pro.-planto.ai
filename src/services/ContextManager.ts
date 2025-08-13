// src/services/ContextManager.ts
import * as vscode from 'vscode';
import { RAGService } from './RAGService';

/**
 * Message carried in conversation memory.
 * Includes an optional meta payload so tools/agents can stash structured data.
 */
export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: Date;
  meta?: Record<string, any>;
}

/** Key used if you want to persist messages in globalState. */
export const CONVERSATION_STORAGE_KEY = 'conversationMemory';

/**
 * Normalize any previously stored value into a valid Message[].
 * Accepts [] or legacy { messages: [...] }. Returns [] for anything else.
 */
export function normalizeMessages(raw: unknown): Message[] {
  if (Array.isArray(raw)) {
    // Best-effort revive Date instances
    return (raw as any[]).map((m) => ({
      ...m,
      timestamp: m?.timestamp ? new Date(m.timestamp) : new Date(),
    })) as Message[];
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).messages)) {
    return (raw as any).messages.map((m: any) => ({
      ...m,
      timestamp: m?.timestamp ? new Date(m.timestamp) : new Date(),
    })) as Message[];
  }
  return [];
}

/**
 * ContextManager
 *  - Stores rolling chat history
 *  - Builds a compact, budget-aware context string for model calls
 *  - Integrates RAG snippets for the current user query
 *  - Creates/maintains an evolving conversation summary
 *  - Can record tool-call results (role: 'tool') for agentic loops
 */
export class ContextManager {
  private messages: Message[] = [];
  private conversationSummary = '';
  private ragService: RAGService;

  // Tunables
  private hardMaxTokens: number;          // absolute ceiling (stop growing past this)
  private targetContextTokens: number;    // target budget for one request context
  private recentHistoryCount: number;     // how many recent msgs to keep verbatim
  private summarizeMinMessages: number;   // start summarizing after this many messages

  constructor(
    ragService: RAGService,
    opts?: {
      hardMaxTokens?: number;
      targetContextTokens?: number;
      recentHistoryCount?: number;
      summarizeMinMessages?: number;
      /** Optional initial messages (any shape); will be normalized. */
      initialMessages?: unknown;
      /** Optional initial summary string. */
      initialSummary?: string;
    }
  ) {
    this.ragService = ragService;

    // Defaults + allow user settings to override
    const cfg = vscode.workspace.getConfiguration();
    const vsMax = Math.max(1024, (cfg.get<number>('aiCoderPro.maxTokens') ?? 4096));

    this.hardMaxTokens        = opts?.hardMaxTokens        ?? vsMax; // e.g., 4k
    this.targetContextTokens  = opts?.targetContextTokens  ?? Math.min(3072, Math.floor(vsMax * 0.75));
    this.recentHistoryCount   = opts?.recentHistoryCount   ?? 8;
    this.summarizeMinMessages = opts?.summarizeMinMessages ?? 10;

    // Safe hydration
    this.messages = normalizeMessages(opts?.initialMessages);
    this.conversationSummary = (opts?.initialSummary ?? '').toString();
  }

  /** One-shot helper if you persist to globalState. */
  static loadFromState(context: vscode.ExtensionContext): Message[] {
    const raw = context.globalState.get(CONVERSATION_STORAGE_KEY);
    return normalizeMessages(raw);
  }

  /** One-shot helper if you persist to globalState. */
  static async saveToState(context: vscode.ExtensionContext, messages: Message[]): Promise<void> {
    // Save plain JSON (dates will be revived by normalizeMessages on load)
    await context.globalState.update(CONVERSATION_STORAGE_KEY, messages ?? []);
  }

  /** Add a generic message (immutable update). */
  addMessage(role: Message['role'], content: string, meta?: Record<string, any>): void {
    const next: Message = { role, content, meta, timestamp: new Date() };
    this.messages = [...this.messages, next];
    // Keep the full store from growing unbounded
    this.trimHardMax();
  }

  /** Convenience: record a tool result as a chat turn (useful for agent loops). */
  addToolResult(toolName: string, result: { ok: boolean; output?: string; error?: string; meta?: any }) {
    const display = [
      `Tool: ${toolName}`,
      `OK: ${result.ok}`,
      result.output ? `Output:\n${safeClip(result.output, 4000)}` : undefined,
      result.error  ? `Error:\n${safeClip(result.error,  2000)}`  : undefined
    ].filter(Boolean).join('\n');
    this.addMessage('tool', display, { tool: toolName, ...result });
  }

  /** Returns a compact, budget-aware context string for an AI request. */
  async getOptimizedContext(userQuery: string): Promise<string> {
    const parts: string[] = [];

    // 1) RAG snippets most relevant to this turn
    const rag = await this.ragService.getContextForQuery(userQuery);
    if (rag) {parts.push(section('RAG Context', rag));}

    // 2) Running summary of older conversation
    if (this.conversationSummary) {
      parts.push(section('Conversation Summary', this.conversationSummary));
    }

    // 3) Recent history (post-trim) — prefer the last N msgs, include role tags
    const recent = this.getRecentHistory(this.recentHistoryCount)
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');
    if (recent) {parts.push(section('Recent Conversation', recent));}

    // 4) Current user goal/query (helps the model anchor intent)
    parts.push(section('Current Query', userQuery));

    // If we exceed our target budget, auto-summarize & shrink the recent slice
    let ctx = parts.join('\n\n');
    if (this.estimateTokens(ctx) > this.targetContextTokens) {
      await this.summarizeConversation(); // update this.conversationSummary
      const tighterRecent = this.getRecentHistory(Math.max(3, Math.floor(this.recentHistoryCount / 2)))
        .map(m => `${m.role}: ${m.content}`)
        .join('\n');
      const compact = [
        rag ? section('RAG Context', rag) : '',
        this.conversationSummary ? section('Conversation Summary', this.conversationSummary) : '',
        tighterRecent ? section('Recent Conversation', tighterRecent) : '',
        section('Current Query', userQuery)
      ].filter(Boolean).join('\n\n');
      ctx = compact;
    }

    return ctx;
  }

  /**
   * Summarize older conversation to keep context lean.
   * Uses a simple heuristic summarizer over the last few user+assistant messages.
   * (You can swap this for an LLM-based summarizer later if desired.)
   */
  async summarizeConversation(): Promise<void> {
    if (this.messages.length < this.summarizeMinMessages) {return;}

    // Take a window of the last ~12 turns (excluding tool/system noise)
    const window = this.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-12);

    if (window.length < 4) {return;}

    const joined = window.map(m => `${m.role}: ${m.content}`).join('\n');
    const newlySynthesized = synthesizeSummary(joined, 1200);

    // Merge with prior summary (keep it tight)
    const merged = mergeSummaries(this.conversationSummary, newlySynthesized);
    this.conversationSummary = safeClip(merged, 1200);

    // Keep only the most recent few messages verbatim
    const keep = Math.max(5, Math.floor(this.recentHistoryCount / 2));
    this.messages = this.messages.slice(-keep);

    console.log('📝 Conversation summarized');
  }

  /** Get last N messages (across all roles) without mutating state. */
  getRecentHistory(count: number): Message[] {
    return this.messages.slice(-count);
  }

  /** Replace entire history (already normalized externally). */
  setHistory(messages: Message[]): void {
    this.messages = Array.isArray(messages) ? messages.slice() : [];
    this.trimHardMax();
  }

  /** Clear all state. */
  clearHistory(): void {
    this.messages = [];
    this.conversationSummary = '';
  }

  /** High-level stats (useful for UI / debug). */
  getStats(): { totalMessages: number; userMessages: number; assistantMessages: number; toolMessages: number } {
    const userMessages = this.messages.filter(m => m.role === 'user').length;
    const assistantMessages = this.messages.filter(m => m.role === 'assistant').length;
    const toolMessages = this.messages.filter(m => m.role === 'tool').length;
    return { totalMessages: this.messages.length, userMessages, assistantMessages, toolMessages };
  }

  /** Heuristic: signal the caller it might be time to summarize. */
  shouldSummarize(): boolean {
    const totalChars = this.messages.reduce((sum, m) => sum + m.content.length, 0);
    const approxTokens = Math.ceil(totalChars / 4);
    return approxTokens > Math.max(1500, Math.floor(this.hardMaxTokens * 0.6)) || this.messages.length > 20;
  }

  /** Expose messages for persistence. */
  getAll(): Message[] {
    return this.messages.slice();
  }

  /** Expose summary for persistence. */
  getSummary(): string {
    return this.conversationSummary;
  }

  // ---------- internals ----------

  /** Prevent the in-memory backlog from growing beyond a hard ceiling. */
  private trimHardMax() {
    let chars = this.messages.reduce((s, m) => s + m.content.length, 0);
    const limitChars = this.hardMaxTokens * 5; // rough 4-5 chars per token
    while (this.messages.length > 8 && chars > limitChars) {
      const removed = this.messages.shift();
      if (!removed) {break;}
      chars -= removed.content.length;
    }
  }

  /** Quick token estimator (safe lower bound). */
  private estimateTokens(text: string): number {
    // ~4 chars ≈ 1 token (varies by model; we keep it conservative)
    return Math.ceil((text?.length ?? 0) / 4);
  }
}

/* ---------------- helpers ---------------- */

function section(title: string, body: string): string {
  return `### ${title}\n${body.trim()}`;
}

function safeClip(text: string, max: number): string {
  if (!text) {return '';}
  if (text.length <= max) {return text;}
  return text.slice(0, Math.max(0, max - 40)) + '\n…[truncated]';
}

/** Build a terse summary from a transcript using simple signals. */
function synthesizeSummary(transcript: string, maxChars: number): string {
  const lines = (transcript || '').split(/\r?\n/).filter(Boolean);
  const bullets: string[] = [];
  let lastUser: string | null = null;
  for (const line of lines) {
    if (line.startsWith('user:')) {
      lastUser = line.slice(5).trim();
      if (lastUser) {bullets.push(`• User: ${clipSentence(lastUser)}`);}
    } else if (line.startsWith('assistant:')) {
      const asst = line.slice(10).trim();
      if (asst) {bullets.push(`• Assistant: ${clipSentence(asst)}`);}
    }
    if (bullets.join('\n').length > maxChars) {break;}
  }

  // lightweight topic extraction
  const topics = extractKeyTopics(transcript, 6);
  const summary = [
    bullets.join('\n'),
    topics.length ? `• Topics: ${topics.join(', ')}` : ''
  ].filter(Boolean).join('\n');

  return safeClip(summary, maxChars);
}

function mergeSummaries(prev: string, next: string): string {
  const a = (prev ?? '').trim();
  const b = (next ?? '').trim();
  if (!a) {return b;}
  if (!b) {return a;}
  const merged = [a.replace(/\s+$/,''), '', b].join('\n');
  return merged.length > 1600 ? safeClip(merged, 1600) : merged;
}

function clipSentence(s: string, limit = 180): string {
  const clean = (s ?? '').replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : clean.slice(0, limit - 1) + '…';
}

function extractKeyTopics(text: string, max = 5): string[] {
  const stop = new Set(['this','that','with','from','have','will','there','their','about','which','while','where','your','would','could','should','into','between','because','after','before','under','above','below','other','these','those','than','then','when','what','ever','also','just','like','make','takes','using','used','been','being','were','them','some','only','each','such','more','most','many']);
  const freq = new Map<string, number>();
  for (const w of (text || '').toLowerCase().split(/[^a-z0-9_]+/g)) {
    if (!w || w.length < 4 || stop.has(w)) {continue;}
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return Array.from(freq.entries())
    .sort((a,b)=>b[1]-a[1])
    .slice(0, max)
    .map(([w]) => w);
}

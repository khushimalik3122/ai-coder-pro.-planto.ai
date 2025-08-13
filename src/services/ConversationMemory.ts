// src/services/ConversationMemory.ts
import * as vscode from 'vscode';

export type ChatRole = 'user' | 'assistant' | 'system';
export interface ChatMessage {
  role: ChatRole;
  content: string;
  ts?: number;
  // You can extend with toolCalls, images, etc. as needed.
}

const STORAGE_KEY = 'conversationMemory';

/** Accepts [] or legacy { messages: [...] } and returns [] on anything else */
export function normalize(raw: unknown): ChatMessage[] {
  if (Array.isArray(raw)) {return raw as ChatMessage[];}
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).messages)) {
    return (raw as any).messages as ChatMessage[];
  }
  return [];
}

export function load(context: vscode.ExtensionContext): ChatMessage[] {
  const raw = context.globalState.get(STORAGE_KEY);
  return normalize(raw);
}

export async function save(
  context: vscode.ExtensionContext,
  mem: ChatMessage[]
): Promise<void> {
  await context.globalState.update(STORAGE_KEY, mem ?? []);
}

/** Always returns the new array (immutable update). */
export async function append(
  context: vscode.ExtensionContext,
  prev: ChatMessage[] | unknown,
  msg: ChatMessage
): Promise<ChatMessage[]> {
  const base = normalize(prev);
  const next = [...base, { ...msg, ts: msg.ts ?? Date.now() }];
  await save(context, next);
  return next;
}

export async function clear(context: vscode.ExtensionContext): Promise<void> {
  await save(context, []);
}

/** One-time migration you can call in activate() */
export async function migrateIfNeeded(context: vscode.ExtensionContext): Promise<void> {
  const raw = context.globalState.get(STORAGE_KEY);
  const normalized = normalize(raw);
  // Only write back if shape changed
  if (raw !== undefined && raw !== null && raw !== normalized) {
    await save(context, normalized);
  }
}

import * as vscode from 'vscode';

export type ToolName =
  | 'read_file' | 'write_file' | 'apply_patch' | 'list_files' | 'delete_path'
  | 'run_command' | 'kill_command'
  | 'search_in_workspace'
  | 'get_diagnostics'
  | 'git_status' | 'git_commit' | 'git_revert';

export interface ToolResult {
  ok: boolean;
  output?: string;
  error?: string;
  meta?: any;
}

export type ToolFn = (args: Record<string, any>) => Promise<ToolResult>;

export class ToolRegistry {
  private tools = new Map<ToolName, ToolFn>();
  register(name: ToolName, fn: ToolFn) { this.tools.set(name, fn); }
  async call(name: ToolName, args: any): Promise<ToolResult> {
    const t = this.tools.get(name);
    if (!t) {return { ok: false, error: `Unknown tool: ${name}` };}
    try { return await t(args); } catch (e:any) { return { ok:false, error:String(e?.stack||e) }; }
  }
}

export function normalizeRelPath(rel: string) {
  return rel.replace(/\\/g, '/').replace(/^\.?\//, '');
}

export function isPathAllowed(rel: string, cfg: vscode.WorkspaceConfiguration) {
  const p = normalizeRelPath(rel);
  const allowed = new Set<string>(cfg.get<string[]>('aiCoderPro.allowedPaths') ?? []);
  const denied  = new Set<string>(cfg.get<string[]>('aiCoderPro.deniedPaths') ?? []);
  if ([...denied].some(d => p.startsWith(d+'/') || p===d)) {return false;}
  if (allowed.size === 0) {return true;}
  return [...allowed].some(a => p.startsWith(a+'/') || p===a);
}

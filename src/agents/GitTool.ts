import * as cp from 'child_process';
import * as vscode from 'vscode';
import * as path from 'path';
import { ToolResult } from './Tooling';

function sh(cwd: string, cmd: string): Promise<ToolResult> {
  return new Promise(resolve => {
    cp.exec(cmd, { cwd }, (err, stdout, stderr) => {
      if (err) {resolve({ ok:false, error: stderr || String(err) });}
      else {resolve({ ok:true, output: stdout });}
    });
  });
}

export async function git_status(): Promise<ToolResult> {
  const ws = vscode.workspace.workspaceFolders?.[0]; if (!ws) {return { ok:false, error:'No workspace' };}
  return sh(ws.uri.fsPath, 'git status --porcelain=v1');
}
export async function git_commit(args: Record<string, any>): Promise<ToolResult> {
  const message = args.message as string;
  if (!message) {return { ok: false, error: 'message is required' };}
  const ws = vscode.workspace.workspaceFolders?.[0]; if (!ws) {return { ok:false, error:'No workspace' };}
  await sh(ws.uri.fsPath, 'git add -A');
  return sh(ws.uri.fsPath, `git commit -m ${JSON.stringify(message || 'AI iteration')}`);
}
export async function git_revert(args: Record<string, any>): Promise<ToolResult> {
  const commit = args.commit as string;
  const ws = vscode.workspace.workspaceFolders?.[0]; if (!ws) {return { ok:false, error:'No workspace' };}
  const ref = commit ? commit : 'HEAD~1';
  return sh(ws.uri.fsPath, `git revert --no-edit ${ref}`);
}

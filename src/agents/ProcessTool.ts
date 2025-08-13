import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { ToolResult } from './Tooling';

export async function run_command(args: Record<string, any>): Promise<ToolResult> {
  const cmd = args.cmd as string;
  const cwd = args.cwd as string;
  const timeoutSec = args.timeoutSec as number;
  if (!cmd) {return { ok: false, error: 'cmd is required' };}
  const ws = vscode.workspace.workspaceFolders?.[0]; if (!ws) {return { ok:false, error:'No workspace' };}
  const cwdPath = cwd ? path.join(ws.uri.fsPath, cwd) : ws.uri.fsPath;
  const timeout = (timeoutSec ?? vscode.workspace.getConfiguration().get<number>('aiCoderPro.commandTimeoutSec') ?? 300) * 1000;
  return new Promise((resolve) => {
    const child = cp.spawn(cmd, { shell: true, cwd: cwdPath });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok:false, error:`timeout after ${timeout/1000}s`, output: out }); }, timeout);
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code===0, output: out, error: code===0 ? undefined : (err || `exit code ${code}`) }); });
  });
}

export async function kill_command(_args: {}): Promise<ToolResult> {
  // Minimal placeholder for future managed processes
  return { ok: true, output: 'Not implemented: managed process table' };
}

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { ToolResult } from './Tooling';

export async function run_command(args: { cmd: string, cwd?: string, timeoutSec?: number }): Promise<ToolResult> {
  const ws = vscode.workspace.workspaceFolders?.[0]; if (!ws) return { ok:false, error:'No workspace' };
  const cwd = args.cwd ? path.join(ws.uri.fsPath, args.cwd) : ws.uri.fsPath;
  const timeout = (args.timeoutSec ?? vscode.workspace.getConfiguration().get<number>('aiCoderPro.commandTimeoutSec') ?? 300) * 1000;
  return new Promise((resolve) => {
    const child = cp.spawn(args.cmd, { shell: true, cwd });
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

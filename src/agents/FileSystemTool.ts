import * as vscode from 'vscode';
import * as path from 'path';
import { ToolResult, normalizeRelPath, isPathAllowed } from './Tooling';

export async function read_file(args: { path: string }): Promise<ToolResult> {
  const ws = vscode.workspace.workspaceFolders?.[0]; if (!ws) return { ok:false, error:'No workspace' };
  const abs = vscode.Uri.file(path.join(ws.uri.fsPath, normalizeRelPath(args.path)));
  try { const buf = await vscode.workspace.fs.readFile(abs); return { ok:true, output: buf.toString() }; }
  catch (e:any){ return { ok:false, error:String(e) }; }
}

export async function write_file(args: { path: string, content: string, createDirs?: boolean }): Promise<ToolResult> {
  const cfg = vscode.workspace.getConfiguration();
  if (!isPathAllowed(args.path, cfg)) return { ok:false, error:'Path not allowed by policy' };
  const ws = vscode.workspace.workspaceFolders?.[0]; if (!ws) return { ok:false, error:'No workspace' };
  const rel = normalizeRelPath(args.path);
  const abs = vscode.Uri.file(path.join(ws.uri.fsPath, rel));
  try {
    if (args.createDirs) {
      const parts = rel.split('/'); parts.pop();
      if (parts.length) await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.join(ws.uri.fsPath, parts.join('/'))));
    }
    const enc = new TextEncoder().encode(args.content ?? '');
    await vscode.workspace.fs.writeFile(abs, enc);
    return { ok:true, output:`wrote ${rel}` };
  } catch (e:any){ return { ok:false, error:String(e) }; }
}

export async function delete_path(args: { path: string }): Promise<ToolResult> {
  const cfg = vscode.workspace.getConfiguration();
  if (!isPathAllowed(args.path, cfg)) return { ok:false, error:'Path not allowed by policy' };
  const ws = vscode.workspace.workspaceFolders?.[0]; if (!ws) return { ok:false, error:'No workspace' };
  const abs = vscode.Uri.file(path.join(ws.uri.fsPath, normalizeRelPath(args.path)));
  try { await vscode.workspace.fs.delete(abs, { recursive: true }); return { ok:true, output:'deleted' }; }
  catch (e:any){ return { ok:false, error:String(e) }; }
}

export async function list_files(args: { under?: string, max?: number }): Promise<ToolResult> {
  const ws = vscode.workspace.workspaceFolders?.[0]; if (!ws) return { ok:false, error:'No workspace' };
  const root = args.under ? path.join(ws.uri.fsPath, normalizeRelPath(args.under)) : ws.uri.fsPath;
  const out: string[] = [];
  async function walk(dir: string) {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    for (const [name, ftype] of entries) {
      const p = path.join(dir, name);
      const rel = normalizeRelPath(path.relative(ws.uri.fsPath, p));
      if (out.length >= (args.max ?? 500)) return;
      if (ftype === vscode.FileType.File) out.push(rel);
      else if (ftype === vscode.FileType.Directory) await walk(p);
    }
  }
  try { await walk(root); return { ok:true, meta:{ files: out } }; }
  catch (e:any){ return { ok:false, error:String(e) }; }
}

// Simple unified-diff patch apply (expects full-file content for safety)
export async function apply_patch(args: { path: string, newContent: string }): Promise<ToolResult> {
  // For deterministic behavior we replace the whole file (Cursor-like diffs can be added later)
  return write_file({ path: args.path, content: args.newContent, createDirs: true });
}

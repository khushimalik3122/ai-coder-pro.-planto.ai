import * as vscode from 'vscode';
import * as path from 'path';
import { ToolResult, normalizeRelPath, isPathAllowed } from './Tooling';

export async function read_file(args: Record<string, any>): Promise<ToolResult> {
  const filePath = args.path as string;
  if (!filePath) {return { ok: false, error: 'path is required' };}
  const ws = vscode.workspace.workspaceFolders?.[0]; if (!ws) {return { ok:false, error:'No workspace' };}
  const abs = vscode.Uri.file(path.join(ws.uri.fsPath, normalizeRelPath(filePath)));
  try { const buf = await vscode.workspace.fs.readFile(abs); return { ok:true, output: new TextDecoder().decode(buf) }; }
  catch (e:any){ return { ok:false, error:String(e) }; }
}

export async function write_file(args: Record<string, any>): Promise<ToolResult> {
  const filePath = args.path as string;
  const content = args.content as string;
  const createDirs = args.createDirs as boolean;
  if (!filePath) {return { ok: false, error: 'path is required' };}
  if (!content) {return { ok: false, error: 'content is required' };}
  const cfg = vscode.workspace.getConfiguration();
  if (!isPathAllowed(filePath, cfg)) {return { ok:false, error:'Path not allowed by policy' };}
  const ws = vscode.workspace.workspaceFolders?.[0]; if (!ws) {return { ok:false, error:'No workspace' };}
  const rel = normalizeRelPath(filePath);
  const abs = vscode.Uri.file(path.join(ws.uri.fsPath, rel));
  try {
    if (createDirs) {
      const parts = rel.split('/'); parts.pop();
      if (parts.length) {await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.join(ws.uri.fsPath, parts.join('/'))));}
    }
    const enc = new TextEncoder().encode(content ?? '');
    await vscode.workspace.fs.writeFile(abs, enc);
    return { ok:true, output:`wrote ${rel}` };
  } catch (e:any){ return { ok:false, error:String(e) }; }
}

export async function delete_path(args: Record<string, any>): Promise<ToolResult> {
  const filePath = args.path as string;
  if (!filePath) {return { ok: false, error: 'path is required' };}
  const cfg = vscode.workspace.getConfiguration();
  if (!isPathAllowed(filePath, cfg)) {return { ok:false, error:'Path not allowed by policy' };}
  const ws = vscode.workspace.workspaceFolders?.[0]; if (!ws) {return { ok:false, error:'No workspace' };}
  const abs = vscode.Uri.file(path.join(ws.uri.fsPath, normalizeRelPath(filePath)));
  try { await vscode.workspace.fs.delete(abs, { recursive: true }); return { ok:true, output:'deleted' }; }
  catch (e:any){ return { ok:false, error:String(e) }; }
}

export async function list_files(args: Record<string, any>): Promise<ToolResult> {
  const under = args.under as string;
  const max = args.max as number;
  const ws = vscode.workspace.workspaceFolders?.[0]; if (!ws) {return { ok:false, error:'No workspace' };}
  const root = under ? path.join(ws.uri.fsPath, normalizeRelPath(under)) : ws.uri.fsPath;
  const out: string[] = [];
  async function walk(dir: string) {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    for (const [name, ftype] of entries) {
      const p = path.join(dir, name);
      const rel = normalizeRelPath(path.relative(ws!.uri.fsPath, p));
      if (out.length >= (max ?? 500)) {return;}
      if (ftype === vscode.FileType.File) {out.push(rel);}
      else if (ftype === vscode.FileType.Directory) {await walk(p);}
    }
  }
  try { await walk(root); return { ok:true, meta:{ files: out } }; }
  catch (e:any){ return { ok:false, error:String(e) }; }
}

// Simple unified-diff patch apply (expects full-file content for safety)
export async function apply_patch(args: Record<string, any>): Promise<ToolResult> {
  const filePath = args.path as string;
  const newContent = args.newContent as string;
  if (!filePath) {return { ok: false, error: 'path is required' };}
  if (!newContent) {return { ok: false, error: 'newContent is required' };}
  // For deterministic behavior we replace the whole file (Cursor-like diffs can be added later)
  return write_file({ path: filePath, content: newContent, createDirs: true });
}

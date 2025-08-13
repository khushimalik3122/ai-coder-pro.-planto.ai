// src/agents/WorkspaceWriter.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface AICoderJsonFile {
  path: string;
  content: string;
  executable?: boolean;
}

export interface AICoderJsonPayload {
  files: AICoderJsonFile[];
  postInstall?: string;
  start?: string;
}

// NEW: interactive root resolver
async function getWorkspaceRootInteractive(): Promise<vscode.Uri> {
  const existing = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (existing) {return existing;}

  // Prompt user to pick a folder and attach it to the Dev Host workspace
  const pick = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: 'Select a folder for AI Coder Pro to write files into',
    openLabel: 'Use this folder'
  });

  if (!pick || !pick[0]) {
    throw new Error('No workspace is open. Please open a folder and try again.');
  }

  const uri = pick[0];
  // Attach to workspace so subsequent operations work normally
  vscode.workspace.updateWorkspaceFolders(
    vscode.workspace.workspaceFolders?.length ?? 0,
    null,
    { uri, name: path.basename(uri.fsPath) }
  );

  return uri;
}

async function ensureDir(dirUri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.stat(dirUri);
  } catch {
    await vscode.workspace.fs.createDirectory(dirUri);
  }
}

export async function writeFilesPayload(
  payload: AICoderJsonPayload
): Promise<{ created: number; updated: number }> {
  // 🔁 changed to interactive resolver
  const root = await getWorkspaceRootInteractive();

  let created = 0;
  let updated = 0;

  for (const f of payload.files) {
    const rel = f.path.replace(/^[\\/]+/, '');
    const target = vscode.Uri.joinPath(root, ...rel.split(/[\\/]/));
    const dir = vscode.Uri.file(path.dirname(target.fsPath));

    await ensureDir(dir);

    let exists = true;
    try {
      await vscode.workspace.fs.stat(target);
    } catch {
      exists = false;
    }

    await vscode.workspace.fs.writeFile(target, Buffer.from(f.content, 'utf8'));
    if (exists) {updated++;} else {created++;}

    if (f.executable && process.platform !== 'win32') {
      try {
        fs.chmodSync(target.fsPath, 0o755);
      } catch {
        // ignore chmod errors on unsupported FS
      }
    }
  }

  // Open the last written file to give immediate feedback
  if (payload.files.length > 0) {
    const last = vscode.Uri.joinPath(
      root,
      ...payload.files[payload.files.length - 1].path.split(/[\\/]/)
    );
    try {
      await vscode.window.showTextDocument(last, { preview: false });
    } catch {}
  }

  return { created, updated };
}

export async function runPostInstallAndStart(project: { postInstall?: string; start?: string }) {
  if (!project.postInstall && !project.start) {return;}

  const term = vscode.window.createTerminal({ name: 'AI Coder Pro' });
  term.show();

  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (ws) {
    term.sendText(process.platform === 'win32' ? `cd "${ws}"` : `cd "${ws}"`);
  }

  if (project.postInstall?.trim()) {term.sendText(project.postInstall.trim());}
  if (project.start?.trim()) {term.sendText(project.start.trim());}
}

import * as vscode from 'vscode';
import { ToolResult } from './Tooling';

export async function get_diagnostics(): Promise<ToolResult> {
  const out: any[] = [];
  const uris = await vscode.workspace.findFiles('**/*');
  for (const uri of uris) {
    const diags = vscode.languages.getDiagnostics(uri);
    if (diags?.length) {
      out.push({
        file: vscode.workspace.asRelativePath(uri),
        issues: diags.map(d => ({
          message: d.message, code: String(d.code ?? ''), severity: d.severity,
          range: { start: d.range.start, end: d.range.end }
        }))
      });
    }
  }
  return { ok:true, meta:{ diagnostics: out } };
}


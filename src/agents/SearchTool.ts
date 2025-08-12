import * as vscode from 'vscode';
import { ToolResult } from './Tooling';

export async function search_in_workspace(args: { query: string, maxResults?: number }): Promise<ToolResult> {
  const rx = new RegExp(args.query, 'i');
  const uris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}', 2000);
  const matches: { file: string, line: number, text: string }[] = [];
  for (const uri of uris) {
    const txt = (await vscode.workspace.fs.readFile(uri)).toString('utf8');
    const lines = txt.split(/\r?\n/);
    for (let i=0;i<lines.length;i++){
      if (rx.test(lines[i])) { matches.push({ file: vscode.workspace.asRelativePath(uri), line: i+1, text: lines[i] });
        if ((args.maxResults ?? 200) <= matches.length) break; }
    }
    if ((args.maxResults ?? 200) <= matches.length) break;
  }
  return { ok:true, meta:{ matches } };
}

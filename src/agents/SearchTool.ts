import * as vscode from 'vscode';
import { ToolResult } from './Tooling';

export async function search_in_workspace(args: Record<string, any>): Promise<ToolResult> {
  const query = args.query as string;
  const maxResults = args.maxResults as number;
  if (!query) {return { ok: false, error: 'query is required' };}
  const rx = new RegExp(query, 'i');
  const uris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}', 2000);
  const matches: { file: string, line: number, text: string }[] = [];
  for (const uri of uris) {
    const txt = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    const lines = txt.split(/\r?\n/);
    for (let i=0;i<lines.length;i++){
      if (rx.test(lines[i])) { matches.push({ file: vscode.workspace.asRelativePath(uri), line: i+1, text: lines[i] });
        if ((maxResults ?? 200) <= matches.length) {break;} }
    }
    if ((maxResults ?? 200) <= matches.length) {break;}
  }
  return { ok:true, meta:{ matches } };
}

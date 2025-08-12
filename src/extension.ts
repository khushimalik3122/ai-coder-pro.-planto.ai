// src/extension.ts
/* eslint-disable @typescript-eslint/no-var-requires */
import * as vscode from 'vscode';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// === Existing agents & services you already had ===
import { BasicAgent } from './agents/BasicAgent';
import { GrokAgent } from './agents/GrokAgent';
import { RAGService } from './services/RAGService';
import { ContextManager } from './services/ContextManager';
import { AgenticWorkflow } from './services/AgenticWorkflow';

// === NEW: tool layer for Cursor-like autonomy ===
import { ToolRegistry } from './agent/Tooling';
import { read_file, write_file, delete_path, list_files, apply_patch } from './agent/FileSystemTool';
import { run_command, kill_command } from './agent/ProcessTool';
import { search_in_workspace } from './agent/SearchTool';
import { get_diagnostics } from './agent/DiagnosticsTool';
import { git_status, git_commit, git_revert } from './agent/GitTool';

// Try to import the provider-agnostic orchestrator (as proposed in modelManager.ts).
// If not present yet, we’ll disable the runGoal entry with a friendly message.
let ToolUseOrchestrator: any = undefined;
let buildToolUseModel: any = undefined;
try {
  // These are expected from your updated ./modelManager.ts
  ({ ToolUseOrchestrator, buildToolUseModel } = require('./modelManager'));
} catch {
  // no-op; runGoal will gracefully explain how to enable autonomy
}

// Load environment variables (optional .env in project root)
dotenv.config({ path: path.join(__dirname, '..', '.env') });

export function activate(context: vscode.ExtensionContext) {
  console.log('AI Coder Pro extension is now active!');

  // Initialize services
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  const ragService = new RAGService(workspacePath);
  const contextManager = new ContextManager(ragService);

  // === NEW: Tool registry for agent loop ===
  const tools = new ToolRegistry();
  tools.register('read_file', read_file);
  tools.register('write_file', write_file);
  tools.register('apply_patch', apply_patch);
  tools.register('delete_path', delete_path);
  tools.register('list_files', list_files);
  tools.register('run_command', run_command);
  tools.register('kill_command', kill_command);
  tools.register('search_in_workspace', search_in_workspace);
  tools.register('get_diagnostics', get_diagnostics);
  tools.register('git_status', git_status);
  tools.register('git_commit', git_commit);
  tools.register('git_revert', git_revert);

  // Build an orchestrator if modelManager is already upgraded
  let orchestrator: any = undefined;
  if (ToolUseOrchestrator && buildToolUseModel) {
    const toolModel = buildToolUseModel(); // provider-aware ToolUseModel (Groq/Together/OpenAI/Claude)
    orchestrator = new ToolUseOrchestrator(toolModel, tools);
  }

  // Agentic workflow (prompt builders + OPTIONAL tool loop)
  const agenticWorkflow = new AgenticWorkflow(ragService, contextManager, {
    tools,
    orchestrator
  });

  // === Persistent memory for your existing chat flow (kept intact) ===
  let conversationMemory: { role: 'user' | 'assistant'; content: string; timestamp: number }[] = [];
  let projectAnalysis: { files: string[]; summary: string; lastAnalysis: number } | null = null;

  // Load prior state
  conversationMemory = context.globalState.get<typeof conversationMemory>('conversationMemory', []);
  projectAnalysis = context.globalState.get<typeof projectAnalysis>('projectAnalysis', null);

  const saveMemory = () => {
    context.globalState.update('conversationMemory', conversationMemory);
    context.globalState.update('projectAnalysis', projectAnalysis);
  };

  // Hello command (unchanged)
  const helloDisposable = vscode.commands.registerCommand('ai-coder-pro.helloWorld', () => {
    vscode.window.showInformationMessage('Hello World from ai-coder-pro!');
  });

  // Index workspace on activation (unchanged)
  ragService.indexWorkspace().then(() => {
    const stats = ragService.getStats();
    console.log(`📚 Workspace indexed: ${stats.totalDocuments} documents, ${stats.indexedTypes.length} file types`);
  });

  // === NEW: Command palette entry for the autonomous agent run ===
  const runGoalDisposable = vscode.commands.registerCommand('aiCoderPro.runGoal', async () => {
    const goal = await vscode.window.showInputBox({
      prompt: 'What should the agent build or fix?',
      value: 'Install deps, run the tests, and fix all failures.'
    });
    if (!goal) return;

    if (!orchestrator) {
      vscode.window.showWarningMessage(
        'AI Coder Pro agent tools are ready, but the tool orchestrator is not configured. ' +
        'Please update ./modelManager.ts to export { ToolUseOrchestrator, buildToolUseModel } as per the upgrade instructions.'
      );
      return;
    }

    const channel = vscode.window.createOutputChannel('AI Coder Pro');
    channel.show(true);
    channel.appendLine('▶️ Starting autonomous agent…');
    const onProgress = (line: string) => channel.appendLine(line);

    try {
      await agenticWorkflow.runGoal(goal, 'All tests pass or the dev server runs without errors.', onProgress);
      channel.appendLine('✅ Agent finished.');
    } catch (e: any) {
      channel.appendLine('❌ Agent error: ' + (e?.message || String(e)));
    }
  });

  // === Chat webview command (kept, with NEW runGoal message support) ===
  const chatPanelDisposable = vscode.commands.registerCommand('aiCoderPro.openChatPanel', () => {
    const panel = vscode.window.createWebviewPanel(
      'aiCoderProChat',
      'AI Coder Pro Chat',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = getChatWebviewContent();

    let togetherKeyOverride: string | undefined = undefined;

    // Smoke-test message to UI
    setTimeout(() => {
      panel.webview.postMessage({
        type: 'ai',
        text: '🔧 Webview communication test successful! If you see this, the extension frontend is OK.'
      });
    }, 800);

    panel.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message.type) {
          case 'test': {
            panel.webview.postMessage({ type: 'ai', text: '✅ Test successful! Backend communication working.' });
            break;
          }

          case 'setApiKeys': {
            if (typeof message.togetherKey === 'string') togetherKeyOverride = message.togetherKey;
            break;
          }

          case 'indexWorkspace': {
            try {
              await ragService.indexWorkspace();
              const stats = ragService.getStats();
              panel.webview.postMessage({
                type: 'ai',
                text:
                  `📚 Workspace indexed successfully!\n\n` +
                  `📊 Statistics:\n- Total documents: ${stats.totalDocuments}\n- File types: ${stats.indexedTypes.join(', ')}\n\n` +
                  `Your project is now ready for context-aware AI assistance!`
              });
            } catch (err) {
              panel.webview.postMessage({ type: 'ai', text: `❌ Failed to index workspace: ${err}` });
            }
            break;
          }

          case 'prompt': {
            const config = vscode.workspace.getConfiguration('aiCoderPro');
            const temperature = config.get<number>('temperature', 0.7);
            const maxTokens = config.get<number>('maxTokens', 4096);

            // Provider keys
            let togetherKey = togetherKeyOverride || config.get<string>('togetherApiKey') || process.env.TOGETHER_API_KEY;
            let grokApiKey = config.get<string>('grokApiKey') || process.env.GROQ_API_KEY;

            let response = '';
            try {
              // AgenticWorkflow builds a context-aware prompt
              const enhancedPrompt = await agenticWorkflow.executeWorkflow(message.prompt);

              // Persist convo memory
              if (message.image) {
                conversationMemory.push({ role: 'user', content: `[Image attached]\n${message.prompt}`, timestamp: Date.now() });
              } else {
                conversationMemory.push({ role: 'user', content: message.prompt, timestamp: Date.now() });
              }

              // Thin recent context for provider call
              const analysisKeywords = /analysis|breakdown|summary|semantics|structure|refactor|in short/i;
              const recentMessages = conversationMemory
                .slice(-12)
                .filter((m) => m.content.length < 500 && !/^\s*<|^\s*\{|^\s*\/\//.test(m.content))
                .filter((m) => !(m.role === 'user' && analysisKeywords.test(m.content)))
                .slice(-6);

              const systemPrompt =
                'You are AI Coder Pro, a helpful coding assistant with advanced context awareness. ' +
                'Use the provided context to give more accurate responses. Only return code if explicitly asked.';

              let contextPrompt: string;
              if (recentMessages.length > 0) {
                contextPrompt =
                  `${systemPrompt}\n\n${enhancedPrompt}\n\n` +
                  `Previous conversation context:\n${recentMessages.map((m) => `${m.role}: ${m.content}`).join('\n')}\n\n` +
                  `Current request: ${message.prompt}`;
              } else {
                contextPrompt = `${systemPrompt}\n\n${enhancedPrompt}\n\nUser: ${message.prompt}`;
              }

              // Pick provider
              const model = message.model || 'together';
              const groqModelMap: Record<string, string> = {
                'grok-llama3-70b-8192': 'llama-3.3-70b-versatile',
                'grok-llama3-8b-8192': 'llama-3.3-8b-instant',
                'grok-mixtral-8x7b-32768': 'mixtral-8x7b-32768',
                'grok-gemma-7b-it': 'gemma-7b-it'
              };

              if (model.startsWith('grok-')) {
                if (!grokApiKey) {
                  panel.webview.postMessage({ type: 'ai', text: '❌ Groq API Key is required. Set it in Settings.' });
                  return;
                }
                const groqModelName = groqModelMap[model] || 'llama-3.3-70b-versatile';
                const agent = new GrokAgent(grokApiKey, groqModelName);
                const grokMessages = recentMessages.map((m) => ({
                  role: m.role as 'user' | 'assistant' | 'system',
                  content: m.content
                }));
                grokMessages.push({ role: 'user', content: message.prompt });
                response = await agent.generateCompletionWithContext(grokMessages, { temperature, maxTokens });
              } else {
                if (!togetherKey) {
                  panel.webview.postMessage({
                    type: 'ai',
                    text: '❌ Together AI API Key is required. Please set your API key in settings (gear icon).'
                  });
                  return;
                }
                const agent = new BasicAgent(togetherKey);
                response = await agent.generateCompletion(contextPrompt, { temperature, maxTokens });
              }

              conversationMemory.push({ role: 'assistant', content: response, timestamp: Date.now() });
              saveMemory();
              panel.webview.postMessage({ type: 'ai', text: response });
            } catch (err: any) {
              console.error('Chat error:', err);
              panel.webview.postMessage({
                type: 'ai',
                text: '❌ Error: ' + (err?.message || err) + '\n\nPlease check your API key and internet connection.'
              });
            }
            break;
          }

          case 'editorAction': {
            const config = vscode.workspace.getConfiguration('aiCoderPro');
            let apiKey = config.get<string>('togetherApiKey') || process.env.TOGETHER_API_KEY;
            if (!apiKey) {
              panel.webview.postMessage({ type: 'ai', text: 'API Key is required.' });
              return;
            }
            const temperature = config.get<number>('temperature', 0.7);
            const maxTokens = config.get<number>('maxTokens', 4096);

            let prompt = '';
            if (message.action === 'summarize') {
              prompt = `Summarize the following text or code:\n\n${message.text}`;
            } else if (message.action === 'explain') {
              prompt = `Explain the following text or code in detail:\n\n${message.text}`;
            } else if (message.action === 'refactor') {
              prompt = `Refactor the following code for readability and maintainability. Only return the refactored code.\n\n${message.text}`;
            } else {
              panel.webview.postMessage({ type: 'ai', text: 'Unknown action.' });
              return;
            }

            try {
              const agent = new BasicAgent(apiKey);
              const resp = await agent.generateCompletion(prompt, { temperature, maxTokens });
              panel.webview.postMessage({ type: 'ai', text: resp });
            } catch (err: any) {
              panel.webview.postMessage({ type: 'ai', text: 'Error: ' + (err?.message || err) });
            }
            break;
          }

          case 'fileUpload': {
            conversationMemory.push({
              role: 'user',
              content: `Uploaded files: ${message.files.join(', ')}\n\nContent:\n${message.content}`,
              timestamp: Date.now()
            });
            saveMemory();
            panel.webview.postMessage({
              type: 'ai',
              text: `Files uploaded successfully. You can now use the autonomous agent to analyze these files along with your project.`
            });
            break;
          }

          // === OLD "agentStart" one-shot flow retained for compatibility ===
          case 'agentStart': {
            panel.webview.postMessage({
              type: 'ai',
              text: '🤖 Agent (legacy one-shot) starting project scan…'
            });
            await runLegacyOneShotAgent(panel, conversationMemory);
            break;
          }

          // === NEW: fully autonomous runGoal from WebView ===
          case 'runGoal': {
            if (!orchestrator) {
              panel.webview.postMessage({
                type: 'ai',
                text:
                  '⚠️ Autonomous tools are ready, but the tool orchestrator is not configured.\n' +
                  'Please update ./modelManager.ts to export { ToolUseOrchestrator, buildToolUseModel } (per upgrade instructions).'
              });
              break;
            }
            const goal: string = message.goal || 'Install deps, run tests, and fix all failures.';
            const successCriteria: string =
              message.successCriteria || 'All tests pass or the dev server runs without errors.';

            const onProgress = (line: string) => {
              panel.webview.postMessage({ type: 'agentLog', text: line });
            };

            panel.webview.postMessage({ type: 'agentLog', text: '▶️ Starting autonomous agent…' });
            try {
              await agenticWorkflow.runGoal(goal, successCriteria, onProgress);
              panel.webview.postMessage({ type: 'agentLog', text: '✅ Agent finished.' });
              panel.webview.postMessage({ type: 'agentDone' });
            } catch (e: any) {
              panel.webview.postMessage({ type: 'agentLog', text: '❌ Agent error: ' + (e?.message || String(e)) });
            }
            break;
          }

          case 'clearMemory': {
            conversationMemory = [];
            projectAnalysis = null;
            saveMemory();
            panel.webview.postMessage({ type: 'ai', text: 'Conversation memory cleared.' });
            break;
          }
        }
      } catch (err: any) {
        console.error('onDidReceiveMessage handler error:', err);
        panel.webview.postMessage({ type: 'ai', text: `❌ Internal error: ${err?.message || err}` });
      }
    });
  });

  // Generate code command (unchanged)
  const generateCodeDisposable = vscode.commands.registerCommand('aiCoderPro.generateCode', async () => {
    const config = vscode.workspace.getConfiguration('aiCoderPro');
    let apiKey = config.get<string>('togetherApiKey') || process.env.TOGETHER_API_KEY;

    if (!apiKey) {
      apiKey = await vscode.window.showInputBox({ prompt: 'Enter Together AI API Key', password: true });
      if (!apiKey) {
        vscode.window.showErrorMessage('API Key is required.');
        return;
      }
    }

    const prompt = await vscode.window.showInputBox({ prompt: 'Enter your code prompt' });
    if (!prompt) {
      vscode.window.showErrorMessage('Prompt is required.');
      return;
    }

    const agent = new BasicAgent(apiKey);
    const temperature = config.get<number>('temperature', 0.7);
    const maxTokens = config.get<number>('maxTokens', 512);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Generating code...', cancellable: false },
      async () => {
        try {
          const result = await agent.generateCompletion(prompt, { temperature, maxTokens });
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            await editor.edit((eb) => eb.insert(editor.selection.active, result));
            vscode.window.showInformationMessage('Code generated and inserted!');
          } else {
            vscode.window.showErrorMessage('No active editor.');
          }
        } catch (err: any) {
          vscode.window.showErrorMessage('Error generating code: ' + (err?.message || err));
        }
      }
    );
  });

  // Register all disposables
  context.subscriptions.push(
    helloDisposable,
    chatPanelDisposable,
    generateCodeDisposable,
    runGoalDisposable
  );
}

function getChatWebviewContent(): string {
  const htmlPath = path.join(__dirname, '..', 'src', 'chatWebview.html');
  return fs.readFileSync(htmlPath, 'utf8');
}

/**
 * Legacy "one-shot" agent flow kept for backward compatibility with your earlier bundle.
 * This does a single-pass analyze+apply without running commands / diagnostics.
 */
async function runLegacyOneShotAgent(
  panel: vscode.WebviewPanel,
  conversationMemory: { role: 'user' | 'assistant'; content: string; timestamp: number }[]
) {
  try {
    panel.webview.postMessage({ type: 'ai', text: '📁 Scanning for code files…' });
    const uris = await vscode.workspace.findFiles(
      '**/*.{js,ts,py,java,cpp,c,cs,go,rb,php,rs,swift,kt,m,scala,sh,pl,lua,json,yaml,yml,md,txt}',
      '**/node_modules/**',
      120
    );

    panel.webview.postMessage({ type: 'ai', text: '🧠 Analyzing project structure…' });
    const selected: vscode.Uri[] = uris.slice(0, 20);
    let projectStructure = '';
    const chunks: { path: string; content: string; type: string }[] = [];
    for (const uri of selected) {
      const doc = await vscode.workspace.openTextDocument(uri);
      const content = doc.getText();
      const rel = vscode.workspace.asRelativePath(uri);
      const ext = rel.split('.').pop() || '';
      const type = ['json', 'yaml', 'yml'].includes(ext) ? 'config' : ['md', 'txt'].includes(ext) ? 'docs' : 'code';
      let compressed = content
        .replace(/\/\*.*?\*\//gs, '')
        .replace(/\/\/.*$/gm, '')
        .replace(/#.*$/gm, '')
        .replace(/\n{2,}/g, '\n')
        .trim();
      if (compressed.length > 3000) compressed = compressed.slice(0, 3000) + '\n… (truncated)';
      chunks.push({ path: rel, content: compressed, type });
      projectStructure += `${rel} (${type})\n`;
    }

    let prompt =
      `You are an autonomous AI coding agent. Perform a project-wide analysis and propose fixes.\n\n` +
      `PROJECT STRUCTURE:\n${projectStructure}\n\nFILES:\n`;
    for (const c of chunks) {
      prompt += `\n--- FILE: ${c.path} (${c.type}) ---\n${c.content}\n`;
    }
    prompt +=
      `\n\nINSTRUCTIONS:\n` +
      `- Identify issues (bugs, performance, security, quality).\n` +
      `- Return improved code per file in the format:\n` +
      `  File: <path>\n  Issues: <bulleted list>\n  Code:\n  <full revised content>\n---\n` +
      `- Do not include explanations outside that format.\n`;

    // Use Together (BasicAgent) by default in this legacy path
    const cfg = vscode.workspace.getConfiguration('aiCoderPro');
    const apiKey = cfg.get<string>('togetherApiKey') || process.env.TOGETHER_API_KEY;
    if (!apiKey) {
      panel.webview.postMessage({ type: 'ai', text: '❌ Together AI API Key required to run the legacy agent.' });
      return;
    }
    const agent = new BasicAgent(apiKey);
    const response = await agent.generateCompletion(prompt, { temperature: 0.3, maxTokens: 16384 });

    // Parse & apply
    panel.webview.postMessage({ type: 'ai', text: '🔧 Applying fixes automatically…' });
    const fileBlocks = response.split(/File: (.+?)\nIssues: (.+?)\nCode:\n([\s\S]*?)(?=\n---|\nFile:|$)/g);
    let appliedCount = 0;
    let totalIssues = 0;

    const allUris = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
    for (let i = 0; i < fileBlocks.length; i += 4) {
      if (fileBlocks[i] && fileBlocks[i + 1] && fileBlocks[i + 2] && fileBlocks[i + 3]) {
        const fileName = fileBlocks[i + 1].trim();
        const issues = fileBlocks[i + 2].trim();
        let code = fileBlocks[i + 3].trim();
        code = code.replace(/```[\s\S]*?\n([\s\S]*?)```/g, '$1').trim();

        try {
          const fileUri = allUris.find((u) => vscode.workspace.asRelativePath(u) === fileName);
          if (fileUri) {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
            edit.replace(fileUri, fullRange, code);
            await vscode.workspace.applyEdit(edit);
            appliedCount++;
            totalIssues += issues.split('\n').length;
          } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const newFileUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, fileName);
            const edit = new vscode.WorkspaceEdit();
            edit.createFile(newFileUri, { ignoreIfExists: true });
            edit.insert(newFileUri, new vscode.Position(0, 0), code);
            await vscode.workspace.applyEdit(edit);
            appliedCount++;
            totalIssues += issues.split('\n').length;
          }
        } catch (e) {
          panel.webview.postMessage({ type: 'ai', text: `⚠️ Could not apply changes to ${fileName}: ${e}` });
        }
      }
    }

    const summary =
      `✅ Legacy Agent Complete!\n\n` +
      `📊 Results:\n- Files analyzed: ${chunks.length}\n- Files improved: ${appliedCount}\n- Total issues fixed: ${totalIssues}\n\n` +
      `🔧 Changes were applied to your workspace.`;

    conversationMemory.push({ role: 'assistant', content: summary, timestamp: Date.now() });
    panel.webview.postMessage({ type: 'ai', text: summary });
  } catch (err: any) {
    panel.webview.postMessage({ type: 'ai', text: '❌ Agent error: ' + (err?.message || err) });
  }
}

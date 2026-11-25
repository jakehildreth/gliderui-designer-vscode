import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Version/availability info for the GliderUI runtime, mirrors upstream Get-RunnerInfo. */
interface RunnerInfo {
  pwsh: string;
  gliderui: string | null;
  server: string | null;
  ready: boolean;
  problem: string | null;
}

/** One running design: its pwsh process, buffered output and the temp script on disk. */
interface Run {
  proc: ChildProcess;
  exitCode: number | null;
  lines: Array<{ s: string; t: string }>;
  filePath: string;
}

let panel: vscode.WebviewPanel | undefined;
let run: Run | undefined;
let cachedInfo: RunnerInfo | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('glideruiDesigner.open', () => openDesigner(context)),
    vscode.commands.registerCommand('glideruiDesigner.installGliderUI', () => installGliderUI())
  );
}

export function deactivate(): void {
  stopRun();
}

function openDesigner(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal();
    return;
  }
  const designerRoot = vscode.Uri.joinPath(context.extensionUri, 'designer');
  panel = vscode.window.createWebviewPanel(
    'glideruiDesigner',
    'GliderUI Designer',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [designerRoot, vscode.Uri.joinPath(context.extensionUri, 'media')],
    }
  );
  panel.webview.html = buildHtml(context, panel.webview);
  panel.webview.onDidReceiveMessage((msg) => handleMessage(context, msg));
  panel.onDidDispose(() => {
    panel = undefined;
    stopRun();
  });
}

/**
 * Builds the webview HTML from the upstream designer's index.html. The only edits are
 * URI rewriting (so the submodule files load inside the webview) and injecting the
 * host shim after upstream's scripts. Upstream files stay byte-identical.
 */
function buildHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const designerPath = vscode.Uri.joinPath(context.extensionUri, 'designer');
  const htmlPath = vscode.Uri.joinPath(designerPath, 'index.html').fsPath;
  let html = fs.readFileSync(htmlPath, 'utf8');

  html = html.replace(/(src|href)="(?!https?:|data:|#)([^"]+)"/g, (_m, attr: string, rel: string) => {
    const uri = webview.asWebviewUri(vscode.Uri.joinPath(designerPath, rel));
    return `${attr}="${uri.toString()}"`;
  });

  const shimUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'host-shim.js'));
  html = html.replace('</body>', `<script src="${shimUri.toString()}"></script>\n</body>`);
  return html;
}

async function handleMessage(context: vscode.ExtensionContext, msg: { type: string; [k: string]: unknown }): Promise<void> {
  const reqId = typeof msg._req === 'number' ? { _req: msg._req } : {};
  switch (msg.type) {
    case 'ping': {
      const info = await getRunnerInfo(false);
      post({ ...reqId, type: 'ping', ok: true, info });
      if (!info.ready) offerInstall(info);
      break;
    }
    case 'refresh': {
      const info = await getRunnerInfo(true);
      post({ ...reqId, type: 'ping', ok: true, info });
      break;
    }
    case 'run':
      await startRun(String(msg.script ?? ''));
      break;
    case 'stop':
      stopRun();
      break;
    case 'openLink':
      void openRunFile(Number(msg.line) || 1);
      break;
    case 'saveProject':
      await saveFile('guiproj.json', String(msg.text ?? ''), 'GUI Creator project', { 'GUI Creator project': ['guiproj.json', 'json'] });
      break;
    case 'exportScript':
      await saveFile('ps1', String(msg.text ?? ''), 'PowerShell script', { PowerShell: ['ps1'] });
      break;
    case 'openProject': {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'GUI Creator project / exported script': ['guiproj.json', 'json', 'ps1'] },
      });
      if (picked?.length) {
        post({ type: 'openProjectResult', text: fs.readFileSync(picked[0].fsPath, 'utf8'), name: path.basename(picked[0].fsPath) });
      }
      break;
    }
    case 'openExternal':
      void vscode.env.openExternal(vscode.Uri.parse(String(msg.url)));
      break;
    case 'setState':
      await context.workspaceState.update('guiCreator.state', msg.state);
      break;
    case 'getState':
      post({ type: 'state', state: context.workspaceState.get('guiCreator.state') ?? null });
      break;
  }
}

async function saveFile(defaultExt: string, text: string, label: string, filters: vscode.SaveDialogOptions['filters']): Promise<void> {
  const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`form.${defaultExt}`), filters, saveLabel: label });
  if (uri) fs.writeFileSync(uri.fsPath, text, 'utf8');
}

function post(msg: unknown): void {
  void panel?.webview.postMessage(msg);
}

/** Runs a command and resolves with its stdout, never throwing. */
function exec(cmd: string, args: string[], timeoutMs = 15000): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; stdout: string; stderr: string; error?: string }>();
  const proc = spawn(cmd, args, { timeout: timeoutMs });
  let stdout = '';
  let stderr = '';
  proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
  proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  proc.on('error', (e) => resolve({ ok: false, stdout, stderr, error: e.message }));
  proc.on('exit', (code) => resolve({ ok: code === 0, stdout, stderr, error: code === 0 ? undefined : `exit code ${code}` }));
  return promise;
}

/** Finds a usable pwsh: on PATH first, then well-known install locations. */
async function findPwsh(): Promise<string | undefined> {
  const probe = await exec('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  if (probe.ok) return 'pwsh';
  const candidates =
    process.platform === 'darwin'
      ? ['/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh']
      : process.platform === 'win32'
        ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')]
        : ['/usr/bin/pwsh', '/snap/bin/pwsh'];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const p = await exec(c, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
      if (p.ok) return c;
    }
  }
  return undefined;
}

/**
 * Runs the upstream Get-RunnerInfo checks via pwsh: GliderUI module installed, and the
 * GliderUI.Server.* package of the same version. Cached; `refresh` forces a re-check.
 */
async function getRunnerInfo(refresh: boolean): Promise<RunnerInfo> {
  if (cachedInfo && !refresh) return cachedInfo;
  const pwshPath = await findPwsh();
  if (!pwshPath) {
    cachedInfo = {
      pwsh: '',
      gliderui: null,
      server: null,
      ready: false,
      problem: 'PowerShell 7 (pwsh) was not found on PATH. Install it first.',
    };
    return cachedInfo;
  }
  const ps = `
$m = Get-Module -ListAvailable -Name GliderUI | Sort-Object Version -Descending | Select-Object -First 1
$s = if ($m) { Get-Module -ListAvailable -Name 'GliderUI.Server.*' | Where-Object Version -EQ $m.Version | Select-Object -First 1 }
[pscustomobject]@{
  pwsh = $PSVersionTable.PSVersion.ToString()
  gliderui = if ($m) { $m.Version.ToString() } else { $null }
  server = if ($s) { "$($s.Name) $($s.Version)" } else { $null }
} | ConvertTo-Json -Compress`;
  const r = await exec(pwshPath, ['-NoProfile', '-Command', ps]);
  let info: RunnerInfo;
  if (!r.ok) {
    info = { pwsh: '', gliderui: null, server: null, ready: false, problem: `pwsh failed to answer: ${r.error ?? r.stderr}` };
  } else {
    const raw = JSON.parse(r.stdout.trim()) as { pwsh: string; gliderui: string | null; server: string | null };
    const problem = !raw.gliderui
      ? 'GliderUI is not installed.'
      : !raw.server
        ? `The GliderUI server for GliderUI ${raw.gliderui} is not installed.`
        : null;
    info = { ...raw, ready: !problem, problem };
  }
  cachedInfo = info;
  return info;
}

function offerInstall(info: RunnerInfo): void {
  const detail = info.gliderui ? 'Install-GLIServer' : 'Install-PSResource -Name GliderUI; Install-GLIServer';
  void vscode.window
    .showInformationMessage(`${info.problem} The designer can run it for you (${detail}).`, 'Install GliderUI', 'Not now')
    .then((choice) => {
      if (choice === 'Install GliderUI') installGliderUI();
    });
}

/** Installs GliderUI (and its server) in a visible terminal so the user sees prompts. */
function installGliderUI(): void {
  const pwshPath = findPwsh();
  if (!pwshPath) {
    void vscode.window.showErrorMessage('PowerShell 7 (pwsh) was not found on PATH. Install it first.');
    return;
  }
  const terminal = vscode.window.createTerminal('GliderUI install');
  terminal.show();
  terminal.sendText('Install-PSResource -Name GliderUI -TrustRepository; Install-GLIServer');
  void vscode.window
    .showInformationMessage('Installing GliderUI in the terminal. Click when it finishes.', 'Check again')
    .then(async () => {
      const info = await getRunnerInfo(true);
      post({ type: 'ping', ok: true, info });
    });
}

async function startRun(script: string): Promise<void> {
  stopRun();
  const pwshPath = await findPwsh();
  if (!pwshPath) {
    post({ type: 'runError', message: 'pwsh not found' });
    return;
  }
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gliderui-run-'));
  const filePath = path.join(runDir, `run-${Date.now().toString(36)}.ps1`);
  fs.writeFileSync(filePath, script, 'utf8');

  const proc = spawn(pwshPath, ['-NoProfile', '-File', filePath], { cwd: runDir });
  run = { proc, exitCode: null, lines: [], filePath };
  post({ type: 'runStarted' });

  proc.stdout?.on('data', (d: Buffer) => pushLine('out', d.toString('utf8')));
  proc.stderr?.on('data', (d: Buffer) => pushLine('err', d.toString('utf8')));
  proc.on('exit', (code) => {
    if (run) run.exitCode = code ?? 0;
    post({ type: 'runExited', exitCode: code ?? 0 });
    fs.rm(runDir, { recursive: true, force: true }, () => {});
  });
}

function pushLine(stream: string, text: string): void {
  if (!run) return;
  for (const line of text.split(/\r?\n/)) {
    if (line.length) run.lines.push({ s: stream, t: line });
  }
  post({ type: 'runOutput', stream, text });
}

function stopRun(): void {
  if (run && run.exitCode === null) {
    run.proc.kill();
  }
}

/** Opens the temp script of the current run at the given line in a real editor. */
async function openRunFile(line: number): Promise<void> {
  if (!run) return;
  const doc = await vscode.workspace.openTextDocument(run.filePath);
  const editor = await vscode.window.showTextDocument(doc, { preview: true });
  const pos = new vscode.Position(Math.max(0, line - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

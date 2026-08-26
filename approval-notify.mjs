// approval-notify: fire a Windows system toast AND flash the Edge taskbar icon
// whenever the DSH approval seam asks the user (durable session-log event
// `approval/asked`). The listener is observe-only: it never answers the
// request, so the web answerer keeps owning the decision. Diagnostics go to
// ~/.dsh/logs/approval-notify.log.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const name = "approval-notify";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const LOG_FILE = join(DSH_HOME, "logs", "approval-notify.log");

// Absolute path to the real Windows PowerShell 5.1, bypassing PATH resolution.
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/** Append one diagnostic line (best effort; never throws into the host). */
function logLine(line) {
  try {
    mkdirSync(join(DSH_HOME, "logs"), { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // logging must never break the approval flow
  }
}

/** Escape text for a PowerShell single-quoted literal (' -> ''). */
function psQuote(text) {
  return String(text ?? "").replace(/\r?\n/g, " ").replace(/'/g, "''");
}

/**
 * Write a BOM-prefixed UTF-8 script and run it with PowerShell 5.1.
 * `windowsHide: false` is REQUIRED for the toast path (toasts raised from a
 * hidden console are dropped); the flash-only child keeps its console hidden
 * so it never flickers on screen. `-LogPath` (plus any `extraArgs`) reach the
 * script as its parameters.
 */
function runPowershell(lines, windowsHide, extraArgs = []) {
  const scriptFile = join(tmpdir(), `dsh-approval-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  try {
    writeFileSync(scriptFile, `\uFEFF${lines.join("\r\n")}`, "utf8");
  } catch (error) {
    logLine(`script write failed: ${String(error)}`);
    return;
  }
  let child;
  try {
    child = spawn(
      POWERSHELL,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptFile, "-LogPath", LOG_FILE, ...extraArgs],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide },
    );
  } catch (error) {
    logLine(`spawn sync throw: ${String(error)}`);
    try {
      rmSync(scriptFile, { force: true });
    } catch {
      // stale temp file is harmless
    }
    return;
  }
  logLine(`ps spawn pid=${child.pid} hidden=${String(windowsHide)}`);
  const drain = (stream, tag) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) logLine(`${tag}: ${line.trim().slice(0, 400)}`);
      }
    });
  };
  drain(child.stdout, "ps-out");
  drain(child.stderr, "ps-err");
  child.on("error", (error) => logLine(`spawn error: ${String(error)}`));
  child.on("close", (code, signal) => {
    logLine(`powershell close code=${code} signal=${signal ?? "none"}`);
    try {
      rmSync(scriptFile, { force: true });
    } catch {
      // stale temp file is harmless
    }
  });
  child.unref();
}

/**
 * Show a toast. PRIMARY channel: raw WinRT under the freshly registered
 * `DshNotify.App` identity (Start Menu shortcut + AUMID). The legacy
 * "Windows PowerShell" identity is accepted by the toast platform on this
 * machine but never presented, and BurntToast 1.1.0 raises under that same
 * legacy identity via ToastNotificationManagerCompat — which is why both
 * looked "sent but invisible". The fresh identity is proven to present.
 * BurntToast / legacy WinRT remain as fallbacks when the shortcut is missing.
 *
 * Spawn constraints learned the hard way on this machine:
 *  - NO `detached: true` — PowerShell 5.1 launched with DETACHED_PROCESS
 *    starts and exits 0 WITHOUT executing the script at all;
 *  - NO hidden window for the toast child — hidden-console toasts are dropped;
 *  - UTF-8 WITH BOM — otherwise PowerShell 5.1 misdecodes Chinese text.
 */
const AUMID = "DshNotify.App";
const ICON_URL = pathToFileURL(fileURLToPath(new URL("./dsh-notify-icon.png", import.meta.url))).href;

function showToast(title, message) {
  const psLog = psQuote(LOG_FILE);
  const lines = [
    "param($LogPath)",
    "$ErrorActionPreference='Continue'",
    `Add-Content -LiteralPath '${psLog}' -Value ('ps: start session=' + (Get-Process -Id $PID).SessionId)`,
    `$shortcut = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\DSH Notify.lnk'`,
    "if (Test-Path $shortcut) {",
    `  Add-Content -LiteralPath '${psLog}' -Value 'ps: identity dshnotify-app'`,
    "  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "  $t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastImageAndText02)",
    `  $img = $t.GetElementsByTagName('image').Item(0); $img.SetAttribute('src', '${psQuote(ICON_URL)}')`,
    "  $n = $t.GetElementsByTagName('text')",
    `  $n.Item(0).AppendChild($t.CreateTextNode('${psQuote(title)}')) | Out-Null`,
    `  $n.Item(1).AppendChild($t.CreateTextNode('${psQuote(message)}')) | Out-Null`,
    "  $toast = [Windows.UI.Notifications.ToastNotification]::new($t)",
    `  Add-Content -LiteralPath '${psLog}' -Value ('ps: mhw=' + (Get-Process -Id $PID).MainWindowHandle)`,
    `  Add-Content -LiteralPath '${psLog}' -Value 'ps: before show'`,
    `  try { [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AUMID}').Show($toast) }`,
    `  catch { Add-Content -LiteralPath '${psLog}' -Value ('ps: show error: ' + $_.Exception.Message) }`,
    `  Add-Content -LiteralPath '${psLog}' -Value 'ps: after show'`,
    "  Start-Sleep -Milliseconds 1500",
    "} else {",
    `  Add-Content -LiteralPath '${psLog}' -Value 'ps: shortcut missing, fallback'`,
    "  $bt = Get-Module -ListAvailable BurntToast | Select-Object -First 1",
    "  if ($bt) {",
    "    Import-Module BurntToast",
    `    try { New-BurntToastNotification -Text '${psQuote(title)}','${psQuote(message)}' }`,
    `    catch { Add-Content -LiteralPath '${psLog}' -Value ('ps: show error: ' + $_.Exception.Message) }`,
    "  } else {",
    `    Add-Content -LiteralPath '${psLog}' -Value 'ps: fallback legacy winrt'`,
    "    $A = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "    $t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "    $n = $t.GetElementsByTagName('text')",
    `    $n.Item(0).AppendChild($t.CreateTextNode('${psQuote(title)}')) | Out-Null`,
    `    $n.Item(1).AppendChild($t.CreateTextNode('${psQuote(message)}')) | Out-Null`,
    "    $toast = [Windows.UI.Notifications.ToastNotification]::new($t)",
    "    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($A).Show($toast)",
    "  }",
    "}",
  ];
  runPowershell(lines, false);
}

/**
 * Ensure the DshNotify.App identity exists once per boot: a Start Menu
 * shortcut whose AppUserModelID is AUMID, plus the HKCU display-name entry.
 * Hidden console is fine here — no toast is raised.
 */
function ensureIdentity() {
  const psLog = psQuote(LOG_FILE);
  const lines = [
    "param($LogPath)",
    "$ErrorActionPreference='Continue'",
    `$shortcut = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\DSH Notify.lnk'`,
    `$appKey = 'HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\${AUMID}'`,
    "if (-not (Test-Path $shortcut)) {",
    "  $bt = Get-Module -ListAvailable BurntToast | Select-Object -First 1",
    "  if ($bt) {",
    "    Import-Module BurntToast",
    `    try { New-BTShortcut -AppId '${AUMID}' -DisplayName 'DSH Notify' -ShortcutPath $shortcut -ForceWindowsPowerShell | Out-Null; Add-Content -LiteralPath '${psLog}' -Value 'ps: identity shortcut created' }`,
    `    catch { Add-Content -LiteralPath '${psLog}' -Value ('ps: shortcut create error: ' + $_.Exception.Message) }`,
    "  } else {",
    `    Add-Content -LiteralPath '${psLog}' -Value 'ps: shortcut missing and no BurntToast to create it'`,
    "  }",
    "}",
    "if (-not (Test-Path $appKey)) {",
    "  try { New-Item -Path $appKey -Force | Out-Null; New-ItemProperty -Path $appKey -Name DisplayName -Value 'DSH Notify' -PropertyType String -Force | Out-Null } catch { }",
    "}",
  ];
  runPowershell(lines, true);
}

/**
 * Flash the taskbar icon of ONE Edge window through Win32 FlashWindowEx with
 * FLASHW_ALL | FLASHW_TIMERNOFG (15): it keeps flashing until the user brings
 * that exact window to the foreground (clicking the flashing taskbar icon does
 * that), which is the requested "flash until clicked" behavior. A supervisor
 * loop inside the same PowerShell child then:
 *   - exits as soon as the target window IS the foreground window,
 *   - exits when the target window disappears (Edge closed it),
 *   - exits when the DSH server parent process is gone,
 *   - or times out after 10 minutes as the absolute ceiling,
 * and finally sends an explicit FLASHW_STOP, so a leftover flash can never
 * survive. (The earlier TIMER/TIMERNOFG incidents happened when the target
 * could be a VS Code window — the class filter also matched Electron apps —
 * so the window the user clicked never satisfied the foreground condition;
 * the msedge process filter below fixed the targeting, not the flag.)
 *
 * Window scope is MSEDGE ONLY: the window class `Chrome_WidgetWin_*` is shared
 * with other Chromium/Electron apps (VS Code included), so every candidate is
 * additionally verified through GetWindowThreadProcessId + Get-Process to be
 * the real Edge process. Windows whose title names the DSH Web GUI are
 * preferred; when none match, the first visible non-foreground Edge window is
 * used. The already-foreground window is skipped, so an approval the user is
 * already looking at never flashes. If no Edge window exists, nothing flashes
 * — the toast alone carries the notice. Runs in its own hidden PowerShell 5.1
 * child; no toast presenter is involved, so a hidden console is safe here.
 */
function flashEdge() {
  const psLog = psQuote(LOG_FILE);
  const lines = [
    "param($LogPath, $ParentPid = 0)",
    "$ErrorActionPreference='Continue'",
    `Add-Content -LiteralPath '${psLog}' -Value 'ps: flash start'`,
    "try {",
    "  Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Text;",
    "using System.Runtime.InteropServices;",
    "public static class DshFlash {",
    "  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);",
    "  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);",
    "  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern bool IsWindow(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
    "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);",
    "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);",
    "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);",
    "  [StructLayout(LayoutKind.Sequential)] public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }",
    "  [DllImport(\"user32.dll\")] public static extern bool FlashWindowEx(ref FLASHWINFO pfwi);",
    "}",
    "'@",
    "  $matched = New-Object System.Collections.ArrayList",
    "  $fallback = New-Object System.Collections.ArrayList",
    "  $cb = [DshFlash+EnumWindowsProc]{ param($h, $l)",
    "    if (-not [DshFlash]::IsWindowVisible($h)) { return $true }",
    "    $cls = New-Object System.Text.StringBuilder 256",
    "    [void][DshFlash]::GetClassName($h, $cls, 256)",
    "    if ($cls.ToString() -notlike 'Chrome_WidgetWin_*') { return $true }",
    "    $pid2 = [uint32]0",
    "    [void][DshFlash]::GetWindowThreadProcessId($h, [ref]$pid2)",
    "    $pn = (Get-Process -Id $pid2 -ErrorAction SilentlyContinue).ProcessName",
    "    if ($pn -ne 'msedge') { return $true }",
    "    $ttl = New-Object System.Text.StringBuilder 512",
    "    [void][DshFlash]::GetWindowText($h, $ttl, 512)",
    "    if ($ttl.ToString() -match 'DSH|DeepSeek|Harness') { [void]$matched.Add($h) } else { [void]$fallback.Add($h) }",
    "    return $true",
    "  }",
    "  [void][DshFlash]::EnumWindows($cb, [IntPtr]::Zero)",
    "  $fg = [DshFlash]::GetForegroundWindow()",
    `  Add-Content -LiteralPath '${psLog}' -Value ('ps: flash matched=' + $matched.Count + ' fallback=' + $fallback.Count)`,
    "  $cand = if ($matched.Count -gt 0) { $matched } else { $fallback }",
    "  $target = $null",
    "  foreach ($h in $cand) { if ($h -ne $fg) { $target = $h; break } }",
    "  if ($target -eq $null) {",
    `    Add-Content -LiteralPath '${psLog}' -Value 'ps: flash no eligible edge window (foreground or absent)'`,
    "  } else {",
    "    $f = New-Object DshFlash+FLASHWINFO",
    "    $f.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($f)",
    "    $f.hwnd = $target",
    "    $f.dwFlags = 15",
    "    $f.uCount = 0",
    "    $f.dwTimeout = 0",
    "    if (-not [DshFlash]::FlashWindowEx([ref]$f)) {",
    `      Add-Content -LiteralPath '${psLog}' -Value 'ps: flash call failed'`,
    "    } else {",
    `      Add-Content -LiteralPath '${psLog}' -Value ('ps: flash hwnd=' + $target + ' flags=15 until-foreground')`,
    "      $reason = 'timeout'",
    "      $deadline = (Get-Date).AddMinutes(10)",
    "      while ((Get-Date) -lt $deadline) {",
    "        Start-Sleep -Milliseconds 500",
    "        if ([DshFlash]::GetForegroundWindow() -eq $target) { $reason = 'foreground'; break }",
    "        if (-not [DshFlash]::IsWindow($target)) { $reason = 'window-gone'; break }",
    "        if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { $reason = 'parent-gone'; break }",
    "      }",
    "      $f.dwFlags = 0",
    "      $f.uCount = 0",
    "      [void][DshFlash]::FlashWindowEx([ref]$f)",
    `      Add-Content -LiteralPath '${psLog}' -Value ('ps: flash stopped reason=' + $reason)`,
    "    }",
    "  }",
    "} catch {",
    `  Add-Content -LiteralPath '${psLog}' -Value ('ps: flash error: ' + $_.Exception.Message)`,
    "}",
    `Add-Content -LiteralPath '${psLog}' -Value 'ps: flash done'`,
  ];
  runPowershell(lines, true, ["-ParentPid", String(process.pid)]);
}

/** The session's effective approval policy (same fold as dsh-user-approval). */
function effectivePolicy(session) {
  const events = session?.events ?? [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === "approval/policy") return events[index].data.policy;
  }
  return "ask";
}

/**
 * Fast foreground probe: is a DSH-titled Edge window (title matches
 * DSH|DeepSeek|Harness) the current foreground window? When it is, the user
 * is already looking at the approval UI — a toast would be noise. Runs in a
 * hidden console (no toast involved, so hidden is safe). Resolves true only
 * for a definite foreground match; any failure resolves false (fail-open:
 * still notify).
 */
function checkDshForeground() {
  const lines = [
    "$ErrorActionPreference='Continue'",
    "try {",
    "  Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Text;",
    "using System.Runtime.InteropServices;",
    "public static class DshFg {",
    "  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);",
    "  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);",
    "  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
    "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);",
    "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);",
    "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);",
    "}",
    "'@",
    "  $matched = New-Object System.Collections.ArrayList",
    "  $cb = [DshFg+EnumWindowsProc]{ param($h, $l)",
    "    if (-not [DshFg]::IsWindowVisible($h)) { return $true }",
    "    $cls = New-Object System.Text.StringBuilder 256",
    "    [void][DshFg]::GetClassName($h, $cls, 256)",
    "    if ($cls.ToString() -notlike 'Chrome_WidgetWin_*') { return $true }",
    "    $pid2 = [uint32]0",
    "    [void][DshFg]::GetWindowThreadProcessId($h, [ref]$pid2)",
    "    $pn = (Get-Process -Id $pid2 -ErrorAction SilentlyContinue).ProcessName",
    "    if ($pn -ne 'msedge') { return $true }",
    "    $ttl = New-Object System.Text.StringBuilder 512",
    "    [void][DshFg]::GetWindowText($h, $ttl, 512)",
    "    if ($ttl.ToString() -match 'DSH|DeepSeek|Harness') { [void]$matched.Add($h) }",
    "    return $true",
    "  }",
    "  [void][DshFg]::EnumWindows($cb, [IntPtr]::Zero)",
    "  $fg = [DshFg]::GetForegroundWindow()",
    "  $isFg = $false",
    "  foreach ($h in $matched) { if ($h -eq $fg) { $isFg = $true; break } }",
    "  if ($isFg) { Write-Output 'FOREGROUND' } else { Write-Output 'BACKGROUND' }",
    "} catch {",
    "  Write-Output 'CHECK_ERROR'",
    "}",
  ];
  return new Promise((resolve) => {
    const scriptFile = join(tmpdir(), `dsh-approval-fg-${process.pid}-${Date.now()}.ps1`);
    try {
      writeFileSync(scriptFile, `\uFEFF${lines.join("\r\n")}`, "utf8");
    } catch (error) {
      logLine(`fg-check script write failed: ${String(error)}`);
      resolve(false);
      return;
    }
    let out = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        rmSync(scriptFile, { force: true });
      } catch {
        // stale temp file is harmless
      }
      resolve(value);
    };
    let child;
    try {
      child = spawn(
        POWERSHELL,
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptFile],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
    } catch (error) {
      logLine(`fg-check spawn throw: ${String(error)}`);
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      logLine("fg-check timeout — treating as background");
      finish(false);
    }, 4000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk; });
    child.on("error", (error) => {
      logLine(`fg-check spawn error: ${String(error)}`);
      clearTimeout(timer);
      finish(false);
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(out.includes("FOREGROUND"));
    });
    child.unref();
  });
}

/** First question text of an ask_user_question tool call, if parseable. */
function extractAskQuestion(argumentsJson) {
  try {
    const parsed = JSON.parse(argumentsJson);
    const first = Array.isArray(parsed?.questions) ? parsed.questions[0] : undefined;
    return typeof first?.question === "string" && first.question.trim().length > 0
      ? first.question.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

const TURN_END_TEXT = {
  completed: "任务已完成",
  error: "任务出错",
  "max-tokens": "输出达到 token 上限",
  aborted: "任务已取消",
  interrupted: "任务中断",
};

/**
 * Scan back from a turn/end event to its turn/start: the driving user
 * message's source (walking backwards, the final overwrite is the FIRST
 * message of the turn) and any goal/change operations in the window.
 */
function turnWindow(session, turnEnd) {
  const events = session?.events ?? [];
  const turn = turnEnd?.data?.turn;
  let endIndex = events.length - 1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.seq === turnEnd?.seq) { endIndex = i; break; }
  }
  let userSource;
  const goalOps = [];
  for (let i = endIndex; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) continue;
    if (event.type === "turn/start" && event.data?.turn === turn) break;
    if (event.type === "user/message" && event.data?.source) userSource = event.data.source;
    if (event.type === "goal/change" && event.data?.operation) goalOps.push(event.data.operation);
  }
  return { userSource, goalOps };
}

export function apply(ctx) {
  logLine(`mounted rev=23 pid=${process.pid}`);
  ensureIdentity();
  const notifyWithGate = (title, body) => {
    try {
      checkDshForeground().then((foreground) => {
        if (foreground) {
          logLine("skip notify: dsh page already foreground");
          return;
        }
        showToast(title, body.slice(0, 200));
        flashEdge();
      }).catch((error) => {
        logLine(`fg-check failed: ${String(error)}`);
        showToast(title, body.slice(0, 200));
        flashEdge();
      });
    } catch (error) {
      logLine(`notify failed: ${String(error)}`);
      ctx.logger?.warn?.(`approval-notify: notify failed: ${String(error)}`);
    }
  };
  ctx.on("session/event", (session, event) => {
    if (event.type === "turn/end") {
      const reason = event.data?.reason?.kind;
      if (typeof reason !== "string" || !(reason in TURN_END_TEXT)) return;
      // Subagent turns would flood the user; only the main session notifies.
      const depth = session?.header?.delegationDepth;
      if (session?.header?.origin === "subagent" || (typeof depth === "number" && depth > 0)) return;
      // /goal 自动推进回合默认静默,仅在目标完成/阻塞的最终回合提醒。
      const window = turnWindow(session, event);
      if (window.userSource?.kind === "goal" && window.userSource.round > 0) {
        const terminal = window.goalOps.some((op) => op === "complete" || op === "block");
        if (!terminal) return;
      }
      const turn = event.data.turn;
      const body = Number.isInteger(turn) ? `${TURN_END_TEXT[reason]}(第 ${turn} 轮)` : TURN_END_TEXT[reason];
      logLine(`turn/end reason=${reason} turn=${String(turn)}`);
      notifyWithGate("DeepSeek Harness · 回合完成", body);
      return;
    }
    if (event.type === "approval/asked") {
      // Under the deterministic `never` policy nothing is ever shown to a human.
      if (effectivePolicy(session) === "never") return;
      const { toolName, reason } = event.data ?? {};
      const body = reason ? `${toolName} — ${reason}` : String(toolName);
      logLine(`asked toolName=${toolName} reason=${String(reason ?? "").slice(0, 100)}`);
      notifyWithGate("DeepSeek Harness 需要你的审批", body);
      return;
    }
    if (event.type === "tool/call" && event.data?.name === "ask_user_question") {
      const question = extractAskQuestion(event.data.arguments);
      logLine(`question asked: ${question ? question.slice(0, 100) : "(unparsed)"}`);
      notifyWithGate("DeepSeek Harness 需要你的回答", question ?? "Agent 正在等待你的回答");
      return;
    }
  });
}

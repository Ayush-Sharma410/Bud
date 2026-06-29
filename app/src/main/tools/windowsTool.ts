import { tool, jsonSchema } from 'ai';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** Run a PowerShell command and return stdout/stderr */
async function runPowershell(command: string, timeoutMs: number = 60_000): Promise<{ stdout: string; stderr: string }> {
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  return execAsync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
    maxBuffer: 1024 * 1024,
    timeout: timeoutMs,
  });
}

export const windowsTool = tool({
  description: `**Windows Tool** — Primary tool for all native Windows OS operations.

This is ONE OF THE TWO MOST IMPORTANT TOOLS (along with Apps & Services Tool).

Use this tool for:
- Launching, closing, focusing, minimizing/maximizing applications
- File and folder operations (search, move, delete, create, rename, read)
- Running PowerShell commands
- System controls (volume, brightness, WiFi, Bluetooth)
- Clipboard access
- Process management (list/kill)
- Clearing temp files, getting system info

**GOLDEN RULE**: Always prefer this tool over Computer Use when the task can be done natively through Windows.

**Routing Priority**: Windows Settings → Windows Tool | File Operations → Windows Tool | PowerShell → Windows Tool

Never use Computer Use if this tool can solve the request.`,
  inputSchema: jsonSchema<{
    action: string;
    payload?: any;
    reason?: string;
  }>({
    type: 'object',
    properties: {
      action: {
        description: 'The Windows operation to perform.',
        type: 'string',
        enum: [
          'open_app', 'close_app', 'focus_window', 'minimize_window', 'maximize_window',
          'file_search', 'file_move', 'file_delete', 'file_create', 'file_rename', 'file_read',
          'run_powershell', 'get_processes', 'kill_process',
          'set_volume', 'set_brightness', 'toggle_wifi', 'toggle_bluetooth',
          'read_clipboard', 'write_clipboard', 'clear_temp', 'system_info'
        ]
      },
      payload: {
        description: 'Parameters for the chosen action (e.g. { app: "Cursor" }, { path: "C:\\\\Users\\\\...", newName: "..." }, { command: "ipconfig" })',
        type: 'object',
      },
      reason: {
        description: 'One sentence explanation why this tool is being called.',
        type: 'string'
      },
    },
    required: ['action'],
  }),
  execute: async ({ action, payload = {}, reason }) => {
    console.log(`🛠️ Tool: windows.${action} — ${reason || 'no reason'}`);

    try {
      let result: { stdout: string; stderr: string };

      switch (action) {
        // ── App Management ──
        case 'open_app':
          result = await runPowershell(`Start-Process '${payload.app || payload.path || ''}'`);
          break;

        case 'close_app':
          result = await runPowershell(`Stop-Process -Name '${payload.app || payload.name || ''}' -Force -ErrorAction SilentlyContinue`);
          break;

        case 'focus_window': {
          const title = payload.title || payload.app || '';
          result = await runPowershell(`
            Add-Type @'
              using System; using System.Runtime.InteropServices;
              public class Win { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
'@
            $p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${title}*' } | Select-Object -First 1
            if ($p) { [Win]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; 'Focused' } else { 'Window not found' }
          `);
          break;
        }

        case 'minimize_window': {
          const minTitle = payload.title || payload.app || '';
          result = await runPowershell(`
            Add-Type @'
              using System; using System.Runtime.InteropServices;
              public class Win { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd); }
'@
            $p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${minTitle}*' } | Select-Object -First 1
            if ($p) { [Win]::ShowWindow($p.MainWindowHandle, 6) | Out-Null; 'Minimized' } else { 'Window not found' }
          `);
          break;
        }

        case 'maximize_window': {
          const maxTitle = payload.title || payload.app || '';
          result = await runPowershell(`
            Add-Type @'
              using System; using System.Runtime.InteropServices;
              public class Win { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd); }
'@
            $p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${maxTitle}*' } | Select-Object -First 1
            if ($p) { [Win]::ShowWindow($p.MainWindowHandle, 3) | Out-Null; 'Maximized' } else { 'Window not found' }
          `);
          break;
        }

        // ── File Operations ──
        case 'file_search': {
          const searchPaths = Array.isArray(payload.locations) && payload.locations.length > 0
            ? payload.locations
            : [payload.path || 'C:\\Users'];
          const filter = payload.query || '*';
          const searchCmd = searchPaths.map((p: string) =>
            `Get-ChildItem -Path '${p}' -Recurse -Depth 5 -Filter '${filter}' -ErrorAction SilentlyContinue | Select-Object -First 20 FullName, Length, LastWriteTime`
          ).join('; ');
          result = await runPowershell(`${searchCmd} | Format-Table -AutoSize | Out-String`);
          break;
        }

        case 'file_move':
          result = await runPowershell(`Move-Item -Path '${payload.source || payload.path || ''}' -Destination '${payload.destination || payload.dest || ''}' -Force`);
          break;

        case 'file_delete':
          result = await runPowershell(`Remove-Item -Path '${payload.path || ''}' -Recurse -Force`);
          break;

        case 'file_create': {
          const content = payload.content || '';
          result = await runPowershell(`New-Item -Path '${payload.path || ''}' -ItemType File -Force -Value '${content.replace(/'/g, "''")}'`);
          break;
        }

        case 'file_rename':
          result = await runPowershell(`Rename-Item -Path '${payload.path || ''}' -NewName '${payload.newName || ''}'`);
          break;

        case 'file_read':
          result = await runPowershell(`Get-Content -Path '${payload.path || ''}' -Raw`);
          break;

        // ── PowerShell ──
        case 'run_powershell':
          result = await runPowershell(payload.command || '');
          break;

        // ── Process Management ──
        case 'get_processes':
          result = await runPowershell(`Get-Process | Sort-Object CPU -Descending | Select-Object -First 25 Name, Id, CPU, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize | Out-String`);
          break;

        case 'kill_process': {
          const target = payload.pid ? `-Id ${payload.pid}` : `-Name '${payload.name || ''}'`;
          result = await runPowershell(`Stop-Process ${target} -Force`);
          break;
        }

        // ── System Controls ──
        case 'set_volume': {
          const vol = payload.level ?? payload.volume ?? 50;
          result = await runPowershell(`
            $vol = [math]::Round(${vol} / 100, 2)
            $obj = New-Object -ComObject WScript.Shell
            1..50 | ForEach-Object { $obj.SendKeys([char]174) }
            $steps = [math]::Round(${vol} / 2)
            1..$steps | ForEach-Object { $obj.SendKeys([char]175) }
            "Volume set to ~$($vol)%"
          `);
          break;
        }

        case 'set_brightness': {
          const brightness = payload.level ?? payload.brightness ?? 50;
          result = await runPowershell(`(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, ${brightness})`);
          break;
        }

        case 'toggle_wifi': {
          const enable = payload.enable !== false;
          result = await runPowershell(`${enable ? 'netsh interface set interface "Wi-Fi" enable' : 'netsh interface set interface "Wi-Fi" disable'}`);
          break;
        }

        case 'toggle_bluetooth': {
          const btEnable = payload.enable !== false;
          result = await runPowershell(`
            Add-Type -AssemblyName System.Runtime.WindowsRuntime
            $radio = [Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime]
            $radios = [Windows.Devices.Radios.Radio]::GetRadiosAsync().GetResults() | Where-Object { $_.Kind -eq 'Bluetooth' }
            if ($radios) { $radios[0].SetStateAsync('${btEnable ? 'On' : 'Off'}').GetResults(); 'Bluetooth ${btEnable ? 'enabled' : 'disabled'}' } else { 'No Bluetooth radio found' }
          `);
          break;
        }

        // ── Clipboard ──
        case 'read_clipboard':
          result = await runPowershell('Get-Clipboard');
          break;

        case 'write_clipboard': {
          const clipText = (payload.text || payload.content || '').replace(/'/g, "''");
          result = await runPowershell(`Set-Clipboard -Value '${clipText}'`);
          break;
        }

        // ── Cleanup & Info ──
        case 'clear_temp':
          result = await runPowershell(`Remove-Item "$env:TEMP\\*" -Recurse -Force -ErrorAction SilentlyContinue; "Temp cleared"`);
          break;

        case 'system_info':
          result = await runPowershell(`
            $os = Get-CimInstance Win32_OperatingSystem
            $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
            $mem = [math]::Round($os.TotalVisibleMemorySize/1MB,1)
            $free = [math]::Round($os.FreePhysicalMemory/1MB,1)
            $disk = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { "$($_.DeviceID) $([math]::Round($_.FreeSpace/1GB,1))GB free / $([math]::Round($_.Size/1GB,1))GB" }
            @"
OS: $($os.Caption) $($os.Version) | CPU: $($cpu.Name) | RAM: $($free)GB free / $($mem)GB total
Disk: $($disk -join ', ')
Uptime: $((Get-Date) - $os.LastBootUpTime | ForEach-Object { "$($_.Days)d $($_.Hours)h $($_.Minutes)m" })
"@
          `);
          break;

        default:
          return { success: false, action, error: `Unknown action: ${action}` };
      }

      return {
        success: true,
        action,
        output: result.stdout.trim(),
        stderr: result.stderr?.trim() || undefined,
      };

    } catch (error: any) {
      const cleanMsg = (error.message || '').replace(/#< CLIXML[\s\S]*?<\/Objs>/g, '').trim();
      const cleanStderr = (error.stderr || '').replace(/#< CLIXML[\s\S]*?<\/Objs>/g, '').trim();
      console.error(`[Windows Tool] ${action} failed:`, cleanMsg || cleanStderr);
      return {
        success: false,
        action,
        error: cleanMsg || cleanStderr || 'Command failed',
        stderr: cleanStderr || undefined,
      };
    }
  },
});

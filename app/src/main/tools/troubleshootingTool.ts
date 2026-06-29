import { tool, jsonSchema } from 'ai';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function runPS(command: string): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"`,
      { maxBuffer: 1024 * 1024, timeout: 30_000 }
    );
    return stdout.trim();
  } catch (err: any) {
    return `[Error] ${err.message}`;
  }
}

export const troubleshootingTool = tool({
  description: `**Troubleshooting Tool** — Acts like a senior Windows engineer for diagnostics and fixes.

Use for complex technical issues:
- Docker / Node / Python / Git problems
- Windows Update failures, BSOD, driver issues
- Slow performance, networking (DNS, VPN, WiFi), port conflicts
- Microphone, audio, or hardware problems
- Registry or permissions issues

Internal workflow: Gather logs → Run diagnostics → Suggest + execute fixes.

Can be combined with Windows Tool and Web Search for best results.`,
  inputSchema: jsonSchema<{
    issue: string;
    context?: string;
    reason?: string;
  }>({
    type: 'object',
    properties: {
      issue: { description: 'Clear description of the technical problem the user is facing', type: 'string' },
      context: { description: 'Additional context: recent changes, error messages, symptoms, logs', type: 'string' },
      reason: { description: 'Why troubleshooting is needed right now', type: 'string' },
    },
    required: ['issue'],
  }),
  execute: async ({ issue, context, reason }) => {
    console.log(`🛠️ Tool: troubleshooting — "${issue}"`);
    if (context) console.log(`   Context: ${context}`);

    const diagnostics: Record<string, string> = {};

    // Gather system diagnostics in parallel
    const [sysInfo, recentErrors, diskSpace, networkStatus, topProcesses] = await Promise.all([
      // Basic system info
      runPS(`
        $os = Get-CimInstance Win32_OperatingSystem
        $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
        $mem = [math]::Round($os.TotalVisibleMemorySize/1MB,1)
        $free = [math]::Round($os.FreePhysicalMemory/1MB,1)
        "OS: $($os.Caption) $($os.Version) | CPU: $($cpu.Name) | RAM: $($free)GB free / $($mem)GB | Load: $($cpu.LoadPercentage)%"
      `),

      // Recent error events (last 24h)
      runPS(`
        Get-WinEvent -FilterHashtable @{LogName='System','Application';Level=1,2;StartTime=(Get-Date).AddHours(-24)} -MaxEvents 10 -ErrorAction SilentlyContinue |
        Select-Object TimeCreated, ProviderName, Message |
        ForEach-Object { "$($_.TimeCreated.ToString('HH:mm')) [$($_.ProviderName)] $($_.Message.Substring(0, [math]::Min(120, $_.Message.Length)))" } |
        Out-String
      `),

      // Disk space
      runPS(`
        Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |
        ForEach-Object { "$($_.DeviceID) $([math]::Round($_.FreeSpace/1GB,1))GB free / $([math]::Round($_.Size/1GB,1))GB ($([math]::Round(($_.Size-$_.FreeSpace)/$_.Size*100,0))% used)" } |
        Out-String
      `),

      // Network status
      runPS(`
        $adapters = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up' | Select-Object Name, Status, LinkSpeed
        $dns = (Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 2).ServerAddresses -join ', '
        $ping = Test-Connection 8.8.8.8 -Count 1 -ErrorAction SilentlyContinue
        $internet = if ($ping) { "OK ($($ping.ResponseTime)ms)" } else { "UNREACHABLE" }
        "Adapters: $($adapters | ForEach-Object { $_.Name + '(' + $_.LinkSpeed + ')' }) | DNS: $dns | Internet: $internet"
      `),

      // Top CPU consumers
      runPS(`
        Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name, Id, CPU, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}} |
        Format-Table -AutoSize | Out-String
      `),
    ]);

    diagnostics.systemInfo = sysInfo;
    diagnostics.recentErrors = recentErrors || 'No recent errors found';
    diagnostics.diskSpace = diskSpace;
    diagnostics.networkStatus = networkStatus;
    diagnostics.topProcesses = topProcesses;

    return {
      success: true,
      issue,
      context: context || undefined,
      diagnostics,
      note: 'Review the diagnostics above. Use Windows Tool to execute any fix commands, or Web Search for deeper investigation.',
    };
  },
});

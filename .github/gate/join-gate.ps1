# The one-tap join on a fresh Windows machine: install Anything from the live
# site, open a join link in Edge, press Join world, and watch the launcher open
# and carry on by itself to the join or to Microsoft's sign-in.
$ErrorActionPreference = "Stop"
$out = $env:GATE_OUT
New-Item -ItemType Directory -Force $out | Out-Null
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
$shell = New-Object -ComObject WScript.Shell

function Log([string]$line) { Write-Host $line; Add-Content (Join-Path $out "log.txt") $line }
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
# The launcher's own window, even with a browser on top of it.
function WindowShot([IntPtr]$handle, [string]$name) {
  $r = New-Object Win+RECT
  [void][Win]::GetWindowRect($handle, [ref]$r)
  $bmp = New-Object System.Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc(); [void][Win]::PrintWindow($handle, $dc, 2); $g.ReleaseHdc($dc)
  $bmp.Save((Join-Path $out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Log "window shot $name"
}
function Shot([string]$name) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save((Join-Path $out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Log "shot $name"
}

# 1. Anything, from the live download page, installed.
node .github/gate/site.mjs $out
$url = Get-Content (Join-Path $out "download-url.txt")
$installer = Join-Path $env:TEMP "Anything-setup.exe"
Invoke-WebRequest $url -OutFile $installer
Start-Process $installer -ArgumentList "/S" -Wait
Start-Sleep 3
Get-Process launcher -ErrorAction SilentlyContinue | Stop-Process -Force
$exe = Join-Path $env:LOCALAPPDATA "Anything\launcher.exe"
if (-not (Test-Path $exe)) { throw "not installed" }
$scheme = (Get-ItemProperty "HKCU:\Software\Classes\anything\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
Log "installed; anything:// registered by the installer: $([bool]$scheme) $scheme"

# 2. Edge would ask "Open Anything?" once; a person presses Open. On this
#    machine a policy answers it for the site, so the run can carry on.
$policy = "HKCU:\Software\Policies\Microsoft\Edge"
New-Item -Force $policy | Out-Null
Set-ItemProperty $policy "HideFirstRunExperience" 1 -Type DWord
Set-ItemProperty $policy "AutoLaunchProtocolsFromOrigins" '[{"protocol":"anything","allowed_origins":["https://minecraft.westwardconsulting.ai"]}]'

# 3. The join page, the button, and what happens after the press.
node .github/gate/join.mjs $out
Start-Sleep 5
Shot "join-03-after-press"

$window = $null
for ($i = 0; $i -lt 30 -and -not $window; $i++) {
  $proc = Get-Process launcher -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
  if ($proc) { $window = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle) } else { Start-Sleep 2 }
}
if (-not $window) { Shot "join-03-no-launcher"; throw "the join link did not open Anything" }
Log "Anything opened from the link (pid $($proc.Id))"
function Words {
  ($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
    ForEach-Object { $_.Current.Name } | Where-Object { $_ -and $_.Length -gt 1 } | Select-Object -Unique) -join " / "
}

$began = Get-Date; $n = 0
while (((Get-Date) - $began).TotalMinutes -lt 8) {
  [void][Win]::ShowWindow($proc.MainWindowHandle, 9); [void][Win]::SetForegroundWindow($proc.MainWindowHandle); Start-Sleep 1
  $n++
  $words = Words
  WindowShot $proc.MainWindowHandle ("join-04-launcher-{0:d2}" -f $n)
  Log ("  {0}" -f ($words.Substring(0, [Math]::Min(500, $words.Length))))
  if ($words -match "Type this code|Microsoft is waiting|Joining .* as|Starting the game") { break }
  Start-Sleep 12
}
WindowShot $proc.MainWindowHandle "join-05-launcher-final"
Shot "join-05-desktop-final"
Set-Content (Join-Path $out "launcher-final.txt") (Words)

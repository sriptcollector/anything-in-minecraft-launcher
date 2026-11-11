# Steps 4-5 of the customer gate: press the launcher's own buttons the way a
# new player would, through Windows UI Automation (what screen readers use),
# with a screenshot after each. Stops at Microsoft's sign-in, which needs a
# real person.
param([string]$out)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
$shell = New-Object -ComObject WScript.Shell
$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.TreeScope]

function Log([string]$line) { Write-Host $line; Add-Content (Join-Path $out "log.txt") $line }
function Shot([string]$name) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save((Join-Path $out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Log "shot $name | $(Words)"
}

$proc = $null; $window = $null
for ($i = 0; $i -lt 60 -and -not $window; $i++) {
  $proc = Get-Process launcher -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
  if ($proc) { $window = $A::FromHandle($proc.MainWindowHandle) }
  else { Start-Sleep 2 }
}
if (-not $window) { throw "the launcher never opened a window" }

function Front { $null = $shell.AppActivate($proc.Id); Start-Sleep -Milliseconds 700 }
function All { $window.FindAll($T::Descendants, [System.Windows.Automation.Condition]::TrueCondition) }
function Words {
  ((All | ForEach-Object { $_.Current.Name } | Where-Object { $_ -and $_.Length -gt 1 } | Select-Object -Unique) -join " / ") -replace "\s+", " " |
    ForEach-Object { if ($_.Length -gt 600) { $_.Substring(0, 600) } else { $_ } }
}
function Press([string]$pattern) {
  $hit = All | Where-Object {
    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -match $pattern -and $_.Current.IsEnabled
  } | Select-Object -First 1
  if (-not $hit) { Log "no button matching '$pattern'"; return $false }
  $hit.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Log "pressed '$($hit.Current.Name)'"
  Start-Sleep 1
  return $true
}

Front
Start-Sleep 4
Shot "04-first-launch"

# What a new player sees on each page before doing anything.
foreach ($name in "Servers", "Build", "Friends", "Settings") {
  if (Press "^$name") { Front; Shot ("04-first-launch-{0}" -f $name.ToLower()) }
}
$null = Press "^Play"

# The one obvious action.
if (-not (Press "Set it up|Start them all")) { $null = Press "Install it" }
Front
Shot "05-pressed-start"
$began = Get-Date; $n = 0
while (((Get-Date) - $began).TotalMinutes -lt 12) {
  Start-Sleep 15; $n++
  Front
  $words = Words
  if ($n -le 3 -or $n % 4 -eq 0) { Shot ("05-progress-{0:d2}" -f $n) }
  $engineDone = $words -match "done|Ready to play"
  $code = $words -match "Type this code|Microsoft is waiting"
  if ($engineDone -and $code) { break }
}
Front
Shot "05-microsoft-sign-in"
Set-Content (Join-Path $out "launcher-final.txt") (Words)

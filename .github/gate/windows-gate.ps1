# The customer gate on a fresh Windows machine (a GitHub runner):
# download from the live site, install through the installer's own pages,
# open the launcher, and take a screenshot after every step.
# Screenshots land in $env:GATE_OUT, named in step order.
$ErrorActionPreference = "Stop"
$out = $env:GATE_OUT
New-Item -ItemType Directory -Force $out | Out-Null
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$shell = New-Object -ComObject WScript.Shell

function Shot([string]$name) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save((Join-Path $out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "shot $name"
}

# --- 1-2. the site and the download, as a visitor ----------------------
node .github/gate/site.mjs $out
$url = Get-Content (Join-Path $out "download-url.txt")
$installer = Join-Path $env:USERPROFILE "Downloads\Anything-setup.exe"
New-Item -ItemType Directory -Force (Split-Path $installer) | Out-Null
Invoke-WebRequest $url -OutFile $installer
"downloaded $((Get-Item $installer).Length) bytes from $url" | Tee-Object (Join-Path $out "log.txt") -Append

# --- 3. install through its own pages ----------------------------------
$proc = Start-Process $installer -PassThru
for ($page = 1; $page -le 8 -and -not $proc.HasExited; $page++) {
  Start-Sleep 4
  $null = $shell.AppActivate($proc.Id)
  Start-Sleep 1
  Shot ("03-install-page{0}" -f $page)
  $shell.SendKeys("{ENTER}")
}
Start-Sleep 5
if (-not $proc.HasExited) { Shot "03-install-stuck"; throw "installer did not finish" }
$exe = Join-Path $env:LOCALAPPDATA "Anything\launcher.exe"
if (-not (Test-Path $exe)) { throw "installed, but $exe is missing" }
"installed: $exe" | Tee-Object (Join-Path $out "log.txt") -Append
Get-ChildItem "$env:USERPROFILE\Desktop", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs" -Filter "Anything*" -ErrorAction SilentlyContinue |
  ForEach-Object { "shortcut: $($_.FullName)" } | Tee-Object (Join-Path $out "log.txt") -Append

# --- 4. first launch ----------------------------------------------------
Start-Sleep 6
$running = Get-Process launcher -ErrorAction SilentlyContinue
"opened by the installer's last page: $([bool]$running)" | Tee-Object (Join-Path $out "log.txt") -Append
if (-not $running) { Start-Process $exe; Start-Sleep 8 }
& ./.github/gate/drive-launcher.ps1 -out $out

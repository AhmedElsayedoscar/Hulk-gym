$nodeInstalled = $false
try {
    $nodeVer = & node -v 2>$null
    if ($nodeVer -match "v\d+") { $nodeInstalled = $true }
} catch {
    $nodeInstalled = $false
}

if (-not $nodeInstalled) {
    Write-Host "[ERROR] Node.js is not installed on this computer!" -ForegroundColor Red
    Write-Host "This system requires Node.js v22 or newer." -ForegroundColor Yellow
    exit 1
}

$projectDir = (Split-Path -Parent $PSScriptRoot)
$targetVbs = Join-Path $projectDir "Launch-Gym.vbs"
$iconFile = Join-Path $projectDir "icon.ico"

$sh = New-Object -ComObject Shell.Application
$desk = $sh.Namespace('shell:Desktop').Self.Path

$localLnk = Join-Path $projectDir "Hulk GYM.lnk"
$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($localLnk)
$sc.TargetPath = "wscript.exe"
$sc.Arguments = "`"$targetVbs`""
$sc.WorkingDirectory = $projectDir
if (Test-Path $iconFile) {
    $sc.IconLocation = $iconFile
} else {
    $sc.IconLocation = "$env:SystemRoot\System32\shell32.dll,43"
}
$sc.Description = "Hulk GYM - نظام إدارة الجيم"
$sc.Save()

# 1. نسخ الاختصار إلى سطح المكتب
$destLnk = Join-Path $desk "Hulk GYM.lnk"
Copy-Item $localLnk -Destination $destLnk -Force

# 2. نسخ الاختصار إلى بدء التشغيل التلقائي للويندوز (Startup)
$startupFolder = [Environment]::GetFolderPath('Startup')
if (Test-Path $startupFolder) {
    $startupLnk = Join-Path $startupFolder "Hulk GYM.lnk"
    Copy-Item $localLnk -Destination $startupLnk -Force
}

Remove-Item $localLnk -Force -ErrorAction SilentlyContinue

if (Test-Path $destLnk) {
    Write-Host "SUCCESS: Hulk GYM shortcut created on Desktop with icon!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "Failed to create shortcut." -ForegroundColor Red
    exit 1
}

param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 3230,
  [string]$HostAddress = "0.0.0.0",
  [switch]$NoBrowser
)

$ErrorActionPreference = "Continue"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:ICARUS_PORT = "$Port"
$env:ICARUS_HOST = $HostAddress
if (-not $env:ICARUS_ALLOW_REMOTE) { $env:ICARUS_ALLOW_REMOTE = "true" }
if (-not $env:ICARUS_ALLOW_PUBLIC) { $env:ICARUS_ALLOW_PUBLIC = "true" }

$PublicRepoUrl = "https://github.com/Genis221/Icarus-Server-Manager.git"

function Refresh-Path {
  $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = @($machine, $user) -join ";"
}

function Test-Winget {
  return [bool](Get-Command winget -ErrorAction SilentlyContinue)
}

function Install-WithWinget {
  param(
    [Parameter(Mandatory)][string]$Id,
    [Parameter(Mandatory)][string]$Label
  )
  if (-not (Test-Winget)) {
    Write-Host "winget was not found. Install $Label manually, then run this launcher again." -ForegroundColor Red
    return $false
  }
  Write-Host "Installing $Label via winget..." -ForegroundColor Cyan
  $installArgs = @(
    "install", "--id", $Id, "-e", "--silent",
    "--accept-package-agreements", "--accept-source-agreements",
    "--disable-interactivity"
  )
  & winget @installArgs
  Refresh-Path
  return ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq -1978335189)
}

function Ensure-Git {
  Refresh-Path
  if (Get-Command git -ErrorAction SilentlyContinue) { return $true }
  Write-Host "Git is required for auto-updates." -ForegroundColor Yellow
  if (-not (Install-WithWinget -Id "Git.Git" -Label "Git")) { return $false }
  Refresh-Path
  if (Get-Command git -ErrorAction SilentlyContinue) { return $true }
  $gitExe = "C:\Program Files\Git\cmd\git.exe"
  if (Test-Path $gitExe) {
    $env:Path = "C:\Program Files\Git\cmd;" + $env:Path
    return $true
  }
  Write-Host "Git installed but is not on PATH yet. Close this window and run Start Icarus Manager.cmd again." -ForegroundColor Yellow
  return $false
}

function Ensure-Node {
  Refresh-Path
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    try {
      $major = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
      if ($major -ge 20) { return $true }
      Write-Host "Node.js $major detected; Icarus Manager needs Node.js 20+." -ForegroundColor Yellow
    } catch { }
  } else {
    Write-Host "Node.js was not found." -ForegroundColor Yellow
  }
  if (-not (Install-WithWinget -Id "OpenJS.NodeJS.LTS" -Label "Node.js LTS")) { return $false }
  Refresh-Path
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    foreach ($candidate in @(
      "$env:ProgramFiles\nodejs\node.exe",
      "${env:ProgramFiles(x86)}\nodejs\node.exe"
    )) {
      if (Test-Path $candidate) {
        $env:Path = (Split-Path $candidate) + ";" + $env:Path
        $node = Get-Command node -ErrorAction SilentlyContinue
        break
      }
    }
  }
  if (-not $node) {
    Write-Host "Node.js installed but is not on PATH yet. Close this window and run Start Icarus Manager.cmd again." -ForegroundColor Yellow
    return $false
  }
  try {
    $major = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
    if ($major -lt 20) {
      Write-Host "Node.js $major is still below 20. Install Node.js 20+ from https://nodejs.org" -ForegroundColor Red
      return $false
    }
  } catch { }
  return $true
}

function Get-LanIPv4 {
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike "127.*" -and
      $_.PrefixOrigin -ne "WellKnown" -and
      $_.AddressState -eq "Preferred"
    } |
    Select-Object -ExpandProperty IPAddress -First 1
}

function Stop-ListenerOnPort {
  param([int]$Port)

  $pids = @()
  try {
    $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
  } catch {
    # Fall through to netstat
  }

  if (-not $pids) {
    $pattern = ":\s*$Port\s+.*LISTENING\s+(\d+)\s*$"
    $pids = @(netstat -ano -p tcp |
      ForEach-Object {
        if ($_ -match $pattern) { [int]$Matches[1] }
      } |
      Select-Object -Unique)
  }

  foreach ($processId in $pids) {
    if ($processId -le 0) { continue }
    $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
    $label = if ($proc) { "$($proc.ProcessName) (PID $processId)" } else { "PID $processId" }
    try {
      Stop-Process -Id $processId -Force -ErrorAction Stop
      Write-Host "Stopped previous manager on port $Port ($label)." -ForegroundColor DarkGray
    } catch {
      Write-Host "Could not stop $label : $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }

  Start-Sleep -Milliseconds 400
}

function Invoke-GitQuiet {
  param([Parameter(Mandatory)][string[]]$GitArgs)
  $previousPrompt = $env:GIT_TERMINAL_PROMPT
  $previousGcm = $env:GCM_INTERACTIVE
  $env:GIT_TERMINAL_PROMPT = "0"
  $env:GCM_INTERACTIVE = "never"
  try {
    & git @GitArgs 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
  } finally {
    if ($null -eq $previousPrompt) { Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue }
    else { $env:GIT_TERMINAL_PROMPT = $previousPrompt }
    if ($null -eq $previousGcm) { Remove-Item Env:\GCM_INTERACTIVE -ErrorAction SilentlyContinue }
    else { $env:GCM_INTERACTIVE = $previousGcm }
  }
}

function Ensure-IcarusGitRepo {
  Push-Location $projectRoot
  try {
    if (Invoke-GitQuiet @("rev-parse", "--is-inside-work-tree")) {
      $originUrl = (git remote get-url origin 2>$null)
      if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($originUrl)) {
        Invoke-GitQuiet @("remote", "add", "origin", $PublicRepoUrl) | Out-Null
      }
      return $true
    }

    Write-Host "This folder is not a git repo yet - linking it to GitHub for updates..." -ForegroundColor Yellow
    if (-not (Invoke-GitQuiet @("init", "-b", "main"))) {
      Invoke-GitQuiet @("init") | Out-Null
      Invoke-GitQuiet @("checkout", "-B", "main") | Out-Null
    }
    Invoke-GitQuiet @("remote", "remove", "origin") | Out-Null
    if (-not (Invoke-GitQuiet @("remote", "add", "origin", $PublicRepoUrl))) {
      Write-Host "Could not add git remote. Skipping update check." -ForegroundColor Red
      return $false
    }
    return $true
  } finally {
    Pop-Location
  }
}

function Update-IcarusManagerFromGit {
  if (-not (Ensure-Git)) {
    Write-Host "Skipping update check (Git unavailable)." -ForegroundColor Yellow
    return $false
  }

  Push-Location $projectRoot
  try {
    if (-not (Ensure-IcarusGitRepo)) { return $false }

    Write-Host "Checking GitHub for Icarus Manager updates..." -ForegroundColor DarkGray

    $fetched = Invoke-GitQuiet @(
      "-c", "credential.helper=",
      "fetch", "--prune", "--no-tags", $PublicRepoUrl,
      "+refs/heads/main:refs/remotes/origin/main"
    )

    if (-not $fetched) {
      $fetched = Invoke-GitQuiet @("fetch", "--prune", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main")
    }

    if (-not $fetched) {
      Write-Host "Could not reach GitHub. Skipping update and starting with the current files." -ForegroundColor Yellow
      return $false
    }

    $remoteRef = "origin/main"
    if (-not (Invoke-GitQuiet @("rev-parse", "--verify", "$remoteRef^{commit}"))) {
      Write-Host "Could not resolve origin/main. Skipping update." -ForegroundColor Yellow
      return $false
    }

    $localSha = ""
    if (Invoke-GitQuiet @("rev-parse", "--verify", "HEAD")) {
      $localSha = (git rev-parse HEAD).Trim()
    }
    $remoteSha = (git rev-parse $remoteRef).Trim()
    if ($localSha -and ($localSha -eq $remoteSha)) {
      Write-Host "Already up to date." -ForegroundColor Green
      return $false
    }

    Write-Host "Updating Icarus Manager from $remoteRef..." -ForegroundColor Yellow
    if (-not (Invoke-GitQuiet @("checkout", "-B", "main", $remoteRef))) {
      if (-not (Invoke-GitQuiet @("reset", "--hard", $remoteRef))) {
        Write-Host "git update failed. Starting with the current files." -ForegroundColor Red
        return $false
      }
    } else {
      Invoke-GitQuiet @("reset", "--hard", $remoteRef) | Out-Null
    }
    Invoke-GitQuiet @("clean", "-fd") | Out-Null

    $shortSha = (git rev-parse --short HEAD).Trim()
    Write-Host "Updated to $shortSha. Local data/ and config.json were left alone." -ForegroundColor Green
    return $true
  } finally {
    Pop-Location
  }
}

function Ensure-ManagerFirewallPort {
  param([int]$Port)

  $ruleName = "Icarus Server Manager TCP $Port"
  $show = & netsh advfirewall firewall show rule name="$ruleName" 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0 -and $show -notmatch "No rules match") {
    Write-Host "Firewall already allows Icarus Manager port $Port (TCP)." -ForegroundColor DarkGray
    return
  }

  Write-Host "Opening Windows Firewall for Icarus Manager port $Port (TCP)..." -ForegroundColor Cyan
  & netsh advfirewall firewall add rule name="$ruleName" dir=in action=allow protocol=TCP localport=$Port | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Firewall rule added for TCP $Port." -ForegroundColor Green
    return
  }

  Write-Host "Admin permission needed to open port $Port - approve the Windows UAC prompt..." -ForegroundColor Yellow
  $elevated = @"
`$ErrorActionPreference = 'Stop'
`$name = '$ruleName'
`$port = $Port
`$show = & netsh advfirewall firewall show rule name=`$name 2>&1 | Out-String
if (`$LASTEXITCODE -ne 0 -or `$show -match 'No rules match') {
  & netsh advfirewall firewall add rule name=`$name dir=in action=allow protocol=TCP localport=`$port | Out-Null
  exit `$LASTEXITCODE
}
exit 0
"@
  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($elevated))
  try {
    $proc = Start-Process -FilePath "powershell.exe" `
      -ArgumentList @("-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", $encoded) `
      -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    if ($proc -and $proc.ExitCode -eq 0) {
      Write-Host "Firewall rule added for TCP $Port." -ForegroundColor Green
    } else {
      Write-Host "Could not open firewall port $Port (UAC denied or failed). Other PCs may not reach the manager." -ForegroundColor Yellow
    }
  } catch {
    Write-Host "Could not elevate for firewall port $Port : $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

Write-Host "Preparing Icarus Server Manager..." -ForegroundColor Cyan
if (-not (Ensure-Git)) {
  Write-Host "Git is missing. Auto-update will be unavailable until Git is installed." -ForegroundColor Yellow
}
if (-not (Ensure-Node)) {
  Write-Host "Node.js 20+ is required. Install from https://nodejs.org then run this launcher again." -ForegroundColor Red
  exit 1
}

$didUpdate = Update-IcarusManagerFromGit

if ($didUpdate) {
  Write-Host "Restarting manager with the updated files..." -ForegroundColor Cyan
}
Stop-ListenerOnPort -Port $Port
Ensure-ManagerFirewallPort -Port $Port

$lanIp = Get-LanIPv4
Write-Host "Starting Icarus Server Manager on port $Port..." -ForegroundColor Cyan
Write-Host "  Local: http://127.0.0.1:$Port"
if ($lanIp) {
  Write-Host "  Network: http://${lanIp}:$Port"
} else {
  Write-Host "  Network: http://<this-pc-ip>:$Port"
}
Write-Host "  WAN:     forward TCP $Port to this PC for the panel (Icarus also needs UDP game + query ports)"

Set-Location $projectRoot
$nodeArgs = @("server.mjs")
if ($NoBrowser) { $nodeArgs += "--no-open" }
& node @nodeArgs
exit $LASTEXITCODE

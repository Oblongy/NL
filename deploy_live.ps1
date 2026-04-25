param(
  [string]$HostName = $(if ($env:NL_VPS_HOST) { $env:NL_VPS_HOST } else { "44.206.42.27" }),
  [string]$UserName = $(if ($env:NL_VPS_USER) { $env:NL_VPS_USER } else { "ubuntu" }),
  [string]$RemoteDir = $(if ($env:NL_VPS_BACKEND_DIR) { $env:NL_VPS_BACKEND_DIR } else { "/opt/NL/backend" }),
  [string]$AppName = $(if ($env:NL_VPS_PM2_APP) { $env:NL_VPS_PM2_APP } else { "nl-backend" }),
  [string[]]$Files,
  [switch]$AllTracked,
  [switch]$SkipHealthcheck,
  [switch]$DryRun
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$deployScript = Join-Path $scriptDir "tools\deploy_live.py"

if (-not (Test-Path $deployScript)) {
  throw "Deploy script not found: $deployScript"
}

if (-not $env:NL_VPS_PASSWORD) {
  $securePassword = Read-Host -Prompt "VPS password for $UserName@$HostName" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  try {
    $env:NL_VPS_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

$args = @(
  $deployScript,
  "--host", $HostName,
  "--user", $UserName,
  "--remote-dir", $RemoteDir,
  "--app-name", $AppName
)

if ($SkipHealthcheck) {
  $args += "--skip-healthcheck"
}

if ($AllTracked) {
  $args += "--all-tracked"
}

foreach ($file in ($Files | Where-Object { $_ })) {
  $args += "--file"
  $args += $file
}

if ($DryRun) {
  $args += "--dry-run"
}

if (Get-Command py -ErrorAction SilentlyContinue) {
  & py -3 @args
} else {
  & python @args
}

exit $LASTEXITCODE

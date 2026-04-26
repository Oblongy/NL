param(
  [string]$HostName = $(if ($env:NL_VPS_HOST) { $env:NL_VPS_HOST } else { "44.206.42.27" }),
  [string]$UserName = $(if ($env:NL_VPS_USER) { $env:NL_VPS_USER } else { "ubuntu" }),
  [string]$KeyFile = $env:NL_VPS_KEY_FILE,
  [string]$KnownHostsFile = $env:NL_VPS_KNOWN_HOSTS_FILE,
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

$args = @(
  $deployScript,
  "--host", $HostName,
  "--user", $UserName,
  "--remote-dir", $RemoteDir,
  "--app-name", $AppName
)

if ($KeyFile) {
  $args += "--key-file"
  $args += $KeyFile
}

if ($KnownHostsFile) {
  $args += "--known-hosts-file"
  $args += $KnownHostsFile
}

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

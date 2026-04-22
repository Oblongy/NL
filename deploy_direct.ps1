# Direct deployment script for Windows - syncs local backend to VPS
# No Git required - uses SCP to copy files directly

param(
    [string]$VpsIp = "3.93.35.32",
    [string]$VpsUser = "ubuntu",
    [string]$IdentityFile
)

$ErrorActionPreference = "Stop"
$LocalBackendDir = $PSScriptRoot
$VpsBackendDir = "/opt/NL/backend"

function Invoke-NativeChecked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$ArgumentList
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($ArgumentList -join ' ')"
    }
}

function Invoke-UploadOverSsh {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$SshArgs,
        [Parameter(Mandatory = $true)]
        [string]$LocalFile,
        [Parameter(Mandatory = $true)]
        [string]$RemoteTarget
    )

    $quotedLocalFile = '"' + $LocalFile.Replace('"', '\"') + '"'
    $sshCommand = @("ssh") + $SshArgs + @("${VpsUser}@${VpsIp}", "`"cat > $RemoteTarget`"")
    $cmdLine = ($sshCommand -join ' ') + " < $quotedLocalFile"
    cmd /c $cmdLine
    if ($LASTEXITCODE -ne 0) {
        throw "Upload failed with exit code ${LASTEXITCODE}: $cmdLine"
    }
}

$SshCommonArgs = @()
if ($IdentityFile) {
    if (-not (Test-Path $IdentityFile)) {
        throw "Identity file not found: $IdentityFile"
    }
    $SshCommonArgs += @("-i", $IdentityFile)
}

Write-Host "=== Direct VPS Deployment ===" -ForegroundColor Cyan
Write-Host "Local:  $LocalBackendDir"
Write-Host "Remote: ${VpsUser}@${VpsIp}:${VpsBackendDir}"
Write-Host ""

# Check if ssh/scp are available
try {
    $null = Get-Command ssh -ErrorAction Stop
    $null = Get-Command scp -ErrorAction Stop
} catch {
    Write-Host "Error: SSH/SCP not found. Install OpenSSH:" -ForegroundColor Red
    Write-Host "  Settings > Apps > Optional Features > Add OpenSSH Client"
    exit 1
}

# Create a temporary archive of the backend (excluding unnecessary files)
Write-Host "Creating deployment package..." -ForegroundColor Yellow
$TempArchive = Join-Path $env:TEMP "nl-backend-deploy.zip"
$ExcludePatterns = @(
    "node_modules",
    ".git",
    ".env",
    "*.log",
    ".deploy-backups",
    "fixtures"
)

# Use 7zip or PowerShell compression
if (Get-Command 7z -ErrorAction SilentlyContinue) {
    $ExcludeArgs = $ExcludePatterns | ForEach-Object { "-xr!$_" }
    & 7z a -tzip $TempArchive "$LocalBackendDir\*" $ExcludeArgs -mx1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "7z failed with exit code ${LASTEXITCODE}"
    }
} else {
    # Fallback: create temp directory and copy files
    $TempDir = Join-Path $env:TEMP "nl-backend-deploy"
    if (Test-Path $TempDir) { Remove-Item $TempDir -Recurse -Force }
    New-Item -ItemType Directory -Path $TempDir | Out-Null
    
    Get-ChildItem $LocalBackendDir -Recurse | Where-Object {
        $item = $_
        $shouldExclude = $false
        foreach ($pattern in $ExcludePatterns) {
            if ($item.FullName -like "*\$pattern\*" -or $item.Name -like $pattern) {
                $shouldExclude = $true
                break
            }
        }
        -not $shouldExclude
    } | ForEach-Object {
        $dest = $_.FullName.Replace($LocalBackendDir, $TempDir)
        $destDir = Split-Path $dest -Parent
        if (-not (Test-Path $destDir)) {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }
        if (-not $_.PSIsContainer) {
            Copy-Item $_.FullName $dest -Force
        }
    }
    
    Compress-Archive -Path "$TempDir\*" -DestinationPath $TempArchive -Force
    Remove-Item $TempDir -Recurse -Force
}

Write-Host "Uploading to VPS..." -ForegroundColor Yellow
Invoke-UploadOverSsh -SshArgs $SshCommonArgs -LocalFile $TempArchive -RemoteTarget "/tmp/nl-backend-deploy.zip"

Write-Host "Extracting and installing on VPS..." -ForegroundColor Yellow

# Execute commands one by one to avoid line ending issues
Invoke-NativeChecked ssh @SshCommonArgs "${VpsUser}@${VpsIp}" "cd /tmp && unzip -o nl-backend-deploy.zip -d nl-backend-temp"
Invoke-NativeChecked ssh @SshCommonArgs "${VpsUser}@${VpsIp}" "rm -rf $VpsBackendDir/src"
Invoke-NativeChecked ssh @SshCommonArgs "${VpsUser}@${VpsIp}" "rm -f $VpsBackendDir/package*.json $VpsBackendDir/*.js $VpsBackendDir/*.sh $VpsBackendDir/*.ps1"
Invoke-NativeChecked ssh @SshCommonArgs "${VpsUser}@${VpsIp}" "mkdir -p $VpsBackendDir"
Invoke-NativeChecked ssh @SshCommonArgs "${VpsUser}@${VpsIp}" "cp -rf /tmp/nl-backend-temp/* $VpsBackendDir/"
Invoke-NativeChecked ssh @SshCommonArgs "${VpsUser}@${VpsIp}" "rm -rf /tmp/nl-backend-temp /tmp/nl-backend-deploy.zip"
Invoke-NativeChecked ssh @SshCommonArgs "${VpsUser}@${VpsIp}" "cd $VpsBackendDir && npm install --omit=dev"
Invoke-NativeChecked ssh @SshCommonArgs "${VpsUser}@${VpsIp}" "pm2 delete nl-backend || true"
Invoke-NativeChecked ssh @SshCommonArgs "${VpsUser}@${VpsIp}" "pm2 start $VpsBackendDir/ecosystem.config.cjs"

Write-Host ""
Write-Host "Checking status..." -ForegroundColor Yellow
Invoke-NativeChecked ssh @SshCommonArgs "${VpsUser}@${VpsIp}" "pm2 status"

Write-Host ""
Write-Host "Recent logs:" -ForegroundColor Yellow
Invoke-NativeChecked ssh @SshCommonArgs "${VpsUser}@${VpsIp}" "pm2 logs nl-backend --lines 20 --nostream"

Remove-Item $TempArchive -Force

Write-Host ""
Write-Host "=== Deployment Complete ===" -ForegroundColor Green
Write-Host "Your local backend is now running on the VPS"
Write-Host ""
Write-Host "Test it:"
Write-Host "  curl http://${VpsIp}/oneclient.html"
Write-Host "  curl http://${VpsIp}/healthz"

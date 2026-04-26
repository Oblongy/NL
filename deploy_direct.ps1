# Direct deployment script for Windows - syncs local backend to VPS
# No Git required - uses SCP to copy files directly

param(
    [string]$VpsIp = "44.206.42.27",
    [string]$VpsUser = "ubuntu",
    [string]$IdentityFile,
    [string]$KnownHostsFile = (Join-Path $HOME ".ssh\known_hosts")
)

$ErrorActionPreference = "Stop"
$LocalBackendDir = $PSScriptRoot
$VpsBackendDir = "/opt/NL/backend"
$script:SshPath = $null
$script:ScpPath = $null

function Resolve-DefaultIdentityFile {
    $candidates = @(
        (Join-Path $HOME ".ssh\codex_1320rewind_ed25519"),
        (Join-Path $HOME ".ssh\id_ed25519"),
        (Join-Path $HOME ".ssh\id_rsa")
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) {
            return $candidate
        }
    }

    return $null
}

function Invoke-SshChecked {
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
        [AllowEmptyCollection()]
        [string[]]$SshArgs = @(),
        [Parameter(Mandatory = $true)]
        [string]$LocalFile,
        [Parameter(Mandatory = $true)]
        [string]$RemoteTarget
    )

    $localDirectory = Split-Path -Path $LocalFile -Parent
    $localFileName = Split-Path -Path $LocalFile -Leaf

    Push-Location $localDirectory
    try {
        Invoke-SshChecked $script:ScpPath @SshArgs $localFileName "${VpsUser}@${VpsIp}:$RemoteTarget"
    } finally {
        Pop-Location
    }
}

$SshCommonArgs = @()
if (-not $IdentityFile) {
    $IdentityFile = Resolve-DefaultIdentityFile
    if ($IdentityFile) {
        Write-Host "Using SSH key: $IdentityFile" -ForegroundColor DarkGray
    }
}

if (-not $IdentityFile) {
    throw "No SSH identity file was provided or discovered. Pass -IdentityFile or place a deploy key in $HOME\.ssh."
}

if (-not (Test-Path $IdentityFile)) {
    throw "Identity file not found: $IdentityFile"
}

if (-not (Test-Path $KnownHostsFile)) {
    throw "Known hosts file not found: $KnownHostsFile. Add the VPS host key before deploying."
}

$SshCommonArgs += @(
    "-i", $IdentityFile,
    "-o", "PreferredAuthentications=publickey",
    "-o", "PubkeyAuthentication=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "UserKnownHostsFile=$KnownHostsFile"
)

Write-Host "=== Direct VPS Deployment ===" -ForegroundColor Cyan
Write-Host "Local:  $LocalBackendDir"
Write-Host "Remote: ${VpsUser}@${VpsIp}:${VpsBackendDir}"
Write-Host ""

# Check if ssh/scp are available
try {
    $script:SshPath = (Get-Command ssh -ErrorAction Stop).Source
    $script:ScpPath = (Get-Command scp -ErrorAction Stop).Source
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
    ".agents",
    ".claude",
    ".gitnexus",
    ".superpowers",
    ".env",
    ".env.*",
    "*.log",
    "*.err",
    "*.out",
    "hs_err_pid*",
    "*.md",
    "*.csv",
    "*.txt",
    ".codex-deploy-manifest.txt",
    "railway.json",
    "oblong-rebuild-result.json",
    "pass.bat",
    "query_roles.js",
    "test-*.js",
    "tests",
    "tools",
    "supabase",
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
Invoke-SshChecked $script:SshPath @SshCommonArgs "${VpsUser}@${VpsIp}" "cd /tmp && unzip -o nl-backend-deploy.zip -d nl-backend-temp"
Invoke-SshChecked $script:SshPath @SshCommonArgs "${VpsUser}@${VpsIp}" "rm -rf $VpsBackendDir/src"
Invoke-SshChecked $script:SshPath @SshCommonArgs "${VpsUser}@${VpsIp}" "rm -f $VpsBackendDir/package*.json $VpsBackendDir/*.js $VpsBackendDir/*.sh $VpsBackendDir/*.ps1"
Invoke-SshChecked $script:SshPath @SshCommonArgs "${VpsUser}@${VpsIp}" "mkdir -p $VpsBackendDir"
Invoke-SshChecked $script:SshPath @SshCommonArgs "${VpsUser}@${VpsIp}" "cp -rf /tmp/nl-backend-temp/* $VpsBackendDir/"
Invoke-SshChecked $script:SshPath @SshCommonArgs "${VpsUser}@${VpsIp}" "rm -rf /tmp/nl-backend-temp /tmp/nl-backend-deploy.zip"
Invoke-SshChecked $script:SshPath @SshCommonArgs "${VpsUser}@${VpsIp}" "cd $VpsBackendDir && npm install --omit=dev"
Invoke-SshChecked $script:SshPath @SshCommonArgs "${VpsUser}@${VpsIp}" "pm2 delete nl-backend || true"
Invoke-SshChecked $script:SshPath @SshCommonArgs "${VpsUser}@${VpsIp}" "pm2 start $VpsBackendDir/ecosystem.config.cjs"

Write-Host ""
Write-Host "Checking status..." -ForegroundColor Yellow
Invoke-SshChecked $script:SshPath @SshCommonArgs "${VpsUser}@${VpsIp}" "pm2 status"

Write-Host ""
Write-Host "Recent logs:" -ForegroundColor Yellow
Invoke-SshChecked $script:SshPath @SshCommonArgs "${VpsUser}@${VpsIp}" "pm2 logs nl-backend --lines 20 --nostream"

Remove-Item $TempArchive -Force

Write-Host ""
Write-Host "=== Deployment Complete ===" -ForegroundColor Green
Write-Host "Your local backend is now running on the VPS"
Write-Host ""
Write-Host "Test it:"
Write-Host "  curl http://${VpsIp}/oneclient.html"
Write-Host "  curl http://${VpsIp}/healthz"

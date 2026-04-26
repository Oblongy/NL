# Direct deployment script for Windows - syncs local backend to VPS
# No Git required - uses SCP to copy files directly

param(
    [string]$VpsIp = "44.206.42.27",
    [string]$VpsUser = "ubuntu",
    [string]$IdentityFile,
    [string]$Password
)

$ErrorActionPreference = "Stop"
$LocalBackendDir = $PSScriptRoot
$VpsBackendDir = "/opt/NL/backend"
$script:UsePasswordAuth = $false
$script:SshAskPassDir = $null
$script:SshAskPassScript = $null
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

function ConvertTo-PlainText {
    param(
        [Parameter(Mandatory = $true)]
        [Security.SecureString]$SecureValue
    )

    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Initialize-SshAskPass {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PlainTextPassword
    )

    $script:SshAskPassDir = Join-Path $env:TEMP "nl-ssh-askpass-$PID"
    New-Item -ItemType Directory -Path $script:SshAskPassDir -Force | Out-Null

    $passwordFile = Join-Path $script:SshAskPassDir "password.txt"
    $script:SshAskPassScript = Join-Path $script:SshAskPassDir "askpass.cmd"

    [System.IO.File]::WriteAllText($passwordFile, $PlainTextPassword, [System.Text.Encoding]::ASCII)
    @"
@echo off
<nul set /p= < "%~dp0password.txt"
"@ | Set-Content -Path $script:SshAskPassScript -Encoding ascii
}

function Invoke-SshChecked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$ArgumentList
    )

    $previousAskPass = $env:SSH_ASKPASS
    $previousAskPassRequire = $env:SSH_ASKPASS_REQUIRE
    $previousDisplay = $env:DISPLAY

    try {
        if ($script:UsePasswordAuth) {
            $env:SSH_ASKPASS = $script:SshAskPassScript
            $env:SSH_ASKPASS_REQUIRE = "force"
            if (-not $env:DISPLAY) {
                $env:DISPLAY = "codex"
            }
        }

        & $FilePath @ArgumentList
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($ArgumentList -join ' ')"
        }
    } finally {
        $env:SSH_ASKPASS = $previousAskPass
        $env:SSH_ASKPASS_REQUIRE = $previousAskPassRequire
        $env:DISPLAY = $previousDisplay
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

if ($IdentityFile) {
    if (-not (Test-Path $IdentityFile)) {
        throw "Identity file not found: $IdentityFile"
    }
    $SshCommonArgs += @("-i", $IdentityFile)
} else {
    if (-not $Password) {
        $securePassword = Read-Host "VPS password for ${VpsUser}@${VpsIp}" -AsSecureString
        $Password = ConvertTo-PlainText -SecureValue $securePassword
    }
    $script:UsePasswordAuth = $true
    Initialize-SshAskPass -PlainTextPassword $Password
    $SshCommonArgs += @(
        "-o", "PreferredAuthentications=keyboard-interactive,password",
        "-o", "KbdInteractiveAuthentication=yes",
        "-o", "PasswordAuthentication=yes",
        "-o", "PubkeyAuthentication=no",
        "-o", "StrictHostKeyChecking=accept-new"
    )
}

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
if ($script:SshAskPassDir -and (Test-Path $script:SshAskPassDir)) {
    Remove-Item $script:SshAskPassDir -Recurse -Force
}

Write-Host ""
Write-Host "=== Deployment Complete ===" -ForegroundColor Green
Write-Host "Your local backend is now running on the VPS"
Write-Host ""
Write-Host "Test it:"
Write-Host "  curl http://${VpsIp}/oneclient.html"
Write-Host "  curl http://${VpsIp}/healthz"

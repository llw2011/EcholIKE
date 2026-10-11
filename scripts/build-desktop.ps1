param(
    [ValidateSet("all", "nsis", "msi")]
    [string]$Bundle = "all",

    [ValidateSet("config", "online", "offline", "both")]
    [string]$WebView2 = "config"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$tauriDir = Join-Path $repoRoot "src-tauri"
$targetDir = Join-Path $tauriDir "target-codex-check"
$nsisDir = Join-Path $targetDir "release\bundle\nsis"
$msiDir = Join-Path $targetDir "release\bundle\msi"
$tempConfigDir = Join-Path $targetDir "tauri-config-overrides"
$packageJson = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "package.json") | ConvertFrom-Json
$version = $packageJson.version

$env:CARGO_TARGET_DIR = $targetDir
$publicApiBaseUrl = $env:ECHOLIKE_PUBLIC_API_BASE_URL
if ([string]::IsNullOrWhiteSpace($publicApiBaseUrl)) {
    $publicApiBaseUrl = "https://api.example.com/echo-api"
}
$publicApiBaseUrl = $publicApiBaseUrl.TrimEnd('/')
$env:VITE_ECHOLIKE_UPDATE_CHECK_URL = "$publicApiBaseUrl/app/update"
$env:VITE_ECHOLIKE_DESKTOP_BOOTSTRAP_URL = "$publicApiBaseUrl/desktop/bootstrap"

if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    $signingKeyPath = $env:TAURI_SIGNING_PRIVATE_KEY_PATH
    if (-not $signingKeyPath) {
        $signingKeyPath = Join-Path $env:USERPROFILE ".tauri\echolike-updater.key"
    }
    if (Test-Path $signingKeyPath) {
        $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw -LiteralPath $signingKeyPath
    }
}
if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    $defaultSigningPasswordPath = Join-Path $env:USERPROFILE ".tauri\echolike-updater.key.password"
    if (Test-Path $defaultSigningPasswordPath) {
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Get-Content -Raw -LiteralPath $defaultSigningPasswordPath
    }
}

function New-TauriConfig {
    param(
        [Parameter(Mandatory)]
        [ValidateSet("config", "online", "offline")]
        [string]$Mode
    )

    if ([string]::IsNullOrWhiteSpace($env:TAURI_UPDATER_PUBLIC_KEY)) {
        throw "TAURI_UPDATER_PUBLIC_KEY must be set for a desktop build."
    }

    New-Item -ItemType Directory -Force -Path $tempConfigDir | Out-Null
    $path = Join-Path $tempConfigDir "tauri.$Mode.json"
    $config = @{
        plugins = @{
            updater = @{
                pubkey = ($env:TAURI_UPDATER_PUBLIC_KEY).Trim()
            }
        }
    }
    if ($Mode -eq "online" -or $Mode -eq "offline") {
        $type = if ($Mode -eq "online") { "downloadBootstrapper" } else { "offlineInstaller" }
        $config.bundle = @{
            windows = @{
                webviewInstallMode = @{
                    type = $type
                    silent = $true
                }
            }
        }
    }
    $config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $path -Encoding UTF8
    return $path
}

function Invoke-TauriBuild {
    param(
        [Parameter(Mandatory)]
        [ValidateSet("all", "nsis", "msi")]
        [string]$RequestedBundle,

        [string]$ConfigPath
    )

    $tauriArgs = @("run", "tauri", "--", "build")
    if ($RequestedBundle -ne "all") {
        $tauriArgs += @("--bundles", $RequestedBundle)
    }
    if ($ConfigPath) {
        $tauriArgs += @("--config", $ConfigPath)
    }

    & npm.cmd @tauriArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri build failed with exit code $LASTEXITCODE."
    }
}

function Copy-NsisVariant {
    param(
        [Parameter(Mandatory)]
        [ValidateSet("online", "offline")]
        [string]$Mode
    )

    $sourceExe = Join-Path $nsisDir "EcholIKE_${version}_x64-setup.exe"
    $sourceSig = "$sourceExe.sig"
    $targetExe = Join-Path $nsisDir "EcholIKE_${version}_x64-$Mode-setup.exe"
    $targetSig = "$targetExe.sig"

    if (-not (Test-Path $sourceExe)) {
        throw "Expected NSIS artifact missing: $sourceExe"
    }
    if (-not (Test-Path $sourceSig)) {
        throw "Expected NSIS signature missing: $sourceSig"
    }

    Copy-Item -LiteralPath $sourceExe -Destination $targetExe -Force
    Copy-Item -LiteralPath $sourceSig -Destination $targetSig -Force

    return @($targetExe, $targetSig)
}

function ArtifactRecord {
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [string]$Label
    )

    if (-not (Test-Path $Path)) {
        return $null
    }

    $item = Get-Item -LiteralPath $Path
    $hash = if ($item.Extension -ieq ".exe" -or $item.Extension -ieq ".msi") {
        (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    else {
        $null
    }

    [pscustomobject]@{
        Label = $Label
        Path = $item.FullName
        SizeMb = [Math]::Round($item.Length / 1MB, 2)
        Sha256 = $hash
    }
}

Push-Location $repoRoot
try {
    $artifactRecords = @()

    if ($WebView2 -eq "both") {
        if ($Bundle -ne "nsis") {
            throw "-WebView2 both is only supported with -Bundle nsis."
        }

        foreach ($mode in @("online", "offline")) {
            Write-Host ""
            Write-Host "Building NSIS $mode WebView2 installer..."
            Invoke-TauriBuild -RequestedBundle "nsis" -ConfigPath (New-TauriConfig -Mode $mode)
            foreach ($artifact in (Copy-NsisVariant -Mode $mode)) {
                $artifactRecords += ArtifactRecord -Path $artifact -Label "nsis-$mode"
            }
        }
        $artifactRecords += ArtifactRecord -Path (Join-Path $targetDir "release\echolike.exe") -Label "binary"
    }
    else {
        $configPath = $null
        if ($WebView2 -eq "online" -or $WebView2 -eq "offline") {
            $configPath = New-TauriConfig -Mode $WebView2
        } else {
            $configPath = New-TauriConfig -Mode "config"
        }

        Invoke-TauriBuild -RequestedBundle $Bundle -ConfigPath $configPath

        if ($Bundle -eq "nsis") {
            if ($WebView2 -eq "online" -or $WebView2 -eq "offline") {
                foreach ($artifact in (Copy-NsisVariant -Mode $WebView2)) {
                    $artifactRecords += ArtifactRecord -Path $artifact -Label "nsis-$WebView2"
                }
            }
            $artifactRecords += ArtifactRecord -Path (Join-Path $nsisDir "EcholIKE_${version}_x64-setup.exe") -Label "nsis"
            $artifactRecords += ArtifactRecord -Path (Join-Path $nsisDir "EcholIKE_${version}_x64-setup.exe.sig") -Label "nsis-signature"
            $artifactRecords += ArtifactRecord -Path (Join-Path $targetDir "release\echolike.exe") -Label "binary"
        }
        elseif ($Bundle -eq "msi") {
            $artifactRecords += ArtifactRecord -Path (Join-Path $msiDir "EcholIKE_${version}_x64_en-US.msi") -Label "msi"
            $artifactRecords += ArtifactRecord -Path (Join-Path $msiDir "EcholIKE_${version}_x64_en-US.msi.sig") -Label "msi-signature"
            $artifactRecords += ArtifactRecord -Path (Join-Path $targetDir "release\echolike.exe") -Label "binary"
        }
        else {
            $artifactRecords += ArtifactRecord -Path (Join-Path $nsisDir "EcholIKE_${version}_x64-setup.exe") -Label "nsis"
            $artifactRecords += ArtifactRecord -Path (Join-Path $nsisDir "EcholIKE_${version}_x64-setup.exe.sig") -Label "nsis-signature"
            $artifactRecords += ArtifactRecord -Path (Join-Path $msiDir "EcholIKE_${version}_x64_en-US.msi") -Label "msi"
            $artifactRecords += ArtifactRecord -Path (Join-Path $msiDir "EcholIKE_${version}_x64_en-US.msi.sig") -Label "msi-signature"
            $artifactRecords += ArtifactRecord -Path (Join-Path $targetDir "release\echolike.exe") -Label "binary"
        }
    }

    Write-Host ""
    Write-Host "Desktop build artifacts ($Bundle, WebView2=$WebView2):"
    foreach ($artifact in ($artifactRecords | Where-Object { $_ })) {
        Write-Host ("- [{0}] {1} ({2} MB)" -f $artifact.Label, $artifact.Path, $artifact.SizeMb)
        if ($artifact.Sha256) {
            Write-Host ("  sha256: {0}" -f $artifact.Sha256)
        }
    }
}
finally {
    Pop-Location
}

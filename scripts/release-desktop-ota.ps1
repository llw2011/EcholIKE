param(
    [Parameter(Mandatory)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,

    [Parameter(Mandatory)]
    [string]$ReleaseNotesFile,

    [ValidateSet('Prepare', 'Static', 'Draft', 'Activate', 'Verify', 'All')]
    [string]$Stage = 'Prepare',

    [switch]$Publish,
    [switch]$Resume
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tauriDir = Join-Path $repoRoot 'src-tauri'
$targetDir = Join-Path $tauriDir 'target-codex-check'
$nsisDir = Join-Path $targetDir 'release\bundle\nsis'
$releaseDir = Join-Path $targetDir "ota-release\$Version"
$intentPath = Join-Path $releaseDir 'build-intent.json'
$manifestPath = Join-Path $releaseDir 'manifest.json'
$verificationPath = Join-Path $releaseDir 'verification.json'
$releaseLockPath = Join-Path $targetDir 'ota-release\.release-tool.lock'
$staticPublisherPath = Join-Path $repoRoot 'scripts\ota\publish_static.py'
$controlCliPath = Join-Path $repoRoot 'scripts\ota\control-release.mjs'
$artifactVerifierPath = Join-Path $repoRoot 'scripts\ota\verify-artifact.ts'
$tauriConfigPath = Join-Path $tauriDir 'tauri.conf.json'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false, $true)
$productionPublicApiBaseUrl = if ([string]::IsNullOrWhiteSpace($env:ECHOLIKE_PUBLIC_API_BASE_URL)) {
    'https://api.example.com/echo-api'
} else {
    ($env:ECHOLIKE_PUBLIC_API_BASE_URL).TrimEnd('/')
}
$productionArtifactBaseUrl = if ([string]::IsNullOrWhiteSpace($env:ECHOLIKE_OTA_ARTIFACT_BASE_URL)) {
    'https://api.example.com/echo-panel/ota/'
} else {
    $artifactBase = ($env:ECHOLIKE_OTA_ARTIFACT_BASE_URL).TrimEnd('/')
    "$artifactBase/"
}
$productionTauriEndpoint = if ([string]::IsNullOrWhiteSpace($env:ECHOLIKE_TAURI_UPDATE_ENDPOINT)) {
    "$productionPublicApiBaseUrl/app/update/tauri?version={{current_version}}&platform={{target}}&arch={{arch}}&channel=stable"
} else {
    $env:ECHOLIKE_TAURI_UPDATE_ENDPOINT
}

function Invoke-External {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string[]]$Arguments,
        [string]$FailureMessage = 'External command failed.'
    )

    $output = & $Command @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        $safeOutput = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
        throw "$FailureMessage Exit=$LASTEXITCODE`n$safeOutput"
    }
    return @($output | ForEach-Object { $_.ToString() })
}

function Invoke-ExternalStreaming {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string[]]$Arguments,
        [string]$FailureMessage = 'External command failed.'
    )

    $resolvedCommand = Get-Command -Name $Command -CommandType Application -ErrorAction Stop
    $previousErrorActionPreference = $ErrorActionPreference
    $exitCode = $null
    try {
        $ErrorActionPreference = 'Continue'
        & $resolvedCommand @Arguments 2>&1 | ForEach-Object { Write-Host $_.ToString() }
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($null -eq $exitCode -or $exitCode -ne 0) {
        throw "$FailureMessage Exit=$exitCode"
    }
}

function Resolve-InputFile {
    param([Parameter(Mandatory)][string]$Path)

    $candidate = if ([System.IO.Path]::IsPathRooted($Path)) { $Path } else { Join-Path $repoRoot $Path }
    $resolved = Resolve-Path -LiteralPath $candidate -ErrorAction Stop
    $item = Get-Item -LiteralPath $resolved.Path -Force
    if (-not $item.PSIsContainer -and -not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        return $item.FullName
    }
    throw "Expected a regular non-reparse file: $candidate"
}

function Read-ReleaseNotes {
    param([Parameter(Mandatory)][string]$Path)

    $resolved = Resolve-InputFile $Path
    $notesItem = Get-Item -LiteralPath $resolved -Force
    if ($notesItem.Length -le 0 -or $notesItem.Length -gt 16384) {
        throw 'Release notes file must contain 1 to 16384 UTF-8 bytes.'
    }
    $bytes = [System.IO.File]::ReadAllBytes($resolved)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        throw 'Release notes must be UTF-8 without BOM.'
    }
    $text = $utf8NoBom.GetString($bytes).Replace("`r`n", "`n")
    if ($text.Contains("`r")) { throw 'Release notes contain a non-canonical carriage return.' }
    if ($text.EndsWith("`n")) { $text = $text.Substring(0, $text.Length - 1) }
    if ($text.EndsWith("`n")) { throw 'Release notes may have at most one terminal line ending.' }
    if ([string]::IsNullOrWhiteSpace($text) -or $text.Length -gt 4000) {
        throw 'Release notes must contain 1 to 4000 non-blank characters.'
    }
    if ($text.Trim() -ne $text) {
        throw 'Release notes must not contain leading or trailing whitespace.'
    }
    return [pscustomobject]@{ Path = $resolved; Text = $text }
}

function Assert-ExactJsonProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Expected,
        [Parameter(Mandatory)][string]$Label
    )

    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    if ($actual.Count -ne $wanted.Count -or @(Compare-Object -ReferenceObject $wanted -DifferenceObject $actual).Count -gt 0) {
        throw "$Label has an unsupported JSON shape."
    }
}

function Read-StrictJsonFile {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or $item.Length -le 0 -or $item.Length -gt 1048576) {
        throw "$Label is not a bounded regular non-reparse file."
    }
    $bytes = [System.IO.File]::ReadAllBytes($item.FullName)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        throw "$Label must be UTF-8 without BOM."
    }
    try {
        return $utf8NoBom.GetString($bytes) | ConvertFrom-Json
    }
    catch {
        throw "$Label is not strict UTF-8 JSON."
    }
}

function Write-JsonFileAtomically {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][int]$Depth
    )

    $parent = [System.IO.Path]::GetDirectoryName($Path)
    [System.IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = Join-Path $parent ('.{0}.{1}.tmp' -f [System.IO.Path]::GetFileName($Path), [Guid]::NewGuid().ToString('N'))
    $stream = $null
    try {
        $payload = $utf8NoBom.GetBytes(($Value | ConvertTo-Json -Depth $Depth))
        $stream = [System.IO.FileStream]::new(
            $temporary,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None,
            4096,
            [System.IO.FileOptions]::WriteThrough
        )
        $stream.Write($payload, 0, $payload.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        [System.IO.File]::Move($temporary, $Path)
    }
    finally {
        if ($stream) { $stream.Dispose() }
        if (Test-Path -LiteralPath $temporary -PathType Leaf) {
            [System.IO.File]::Delete($temporary)
        }
    }
}

function Enter-ReleaseToolLock {
    param([Parameter(Mandatory)][string]$Path)

    $parent = [System.IO.Path]::GetDirectoryName($Path)
    [System.IO.Directory]::CreateDirectory($parent) | Out-Null
    try {
        return [System.IO.FileStream]::new(
            $Path,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None,
            1,
            [System.IO.FileOptions]::WriteThrough
        )
    }
    catch {
        throw 'Another desktop OTA release tool instance is already running.'
    }
}

function Assert-CleanWorktree {
    $status = @(Invoke-External -Command 'git.exe' -Arguments @('-C', $repoRoot, 'status', '--porcelain=v1', '--untracked-files=normal') -FailureMessage 'git status failed.')
    if ($status.Count -gt 0) {
        throw "OTA requires a clean worktree. Dirty entries:`n$($status -join [Environment]::NewLine)"
    }
}

function Get-HeadCommit {
    $lines = @(Invoke-External -Command 'git.exe' -Arguments @('-C', $repoRoot, 'rev-parse', 'HEAD') -FailureMessage 'Cannot resolve HEAD.')
    $commit = $lines[-1].Trim().ToLowerInvariant()
    if ($commit -notmatch '^[a-f0-9]{40}$') { throw 'HEAD is not a full Git commit hash.' }
    return $commit
}

function Assert-ManifestProvenance {
    param([Parameter(Mandatory)][string]$SourceCommit)

    $head = Get-HeadCommit
    if ($head -eq $SourceCommit) { return }
    & git.exe -C $repoRoot merge-base --is-ancestor $SourceCommit $head
    if ($LASTEXITCODE -ne 0) { throw 'Manifest source commit is not an ancestor of HEAD.' }
    $changed = Invoke-External -Command 'git.exe' -Arguments @('-C', $repoRoot, 'diff', '--name-only', "$SourceCommit..$head") -FailureMessage 'Cannot compare manifest provenance.'
    $allowedToolingChanges = @(
        'WORKLOG.md',
        'docs/desktop-ota-release-tool.md',
        'docs/project-guidelines.md',
        'scripts/release-desktop-ota.ps1'
    )
    $productChanges = @($changed | Where-Object {
        $_ -and
        $_ -notin $allowedToolingChanges -and
        -not $_.StartsWith('scripts/ota/', [System.StringComparison]::Ordinal) -and
        $_ -ne 'package.json'
    })
    if ($productChanges.Count -gt 0) {
        throw "Product files changed after the artifact source commit: $($productChanges -join ', ')"
    }
    if ($changed -contains 'package.json') {
        $oldPackageLines = @(Invoke-External -Command 'git.exe' -Arguments @('-C', $repoRoot, 'show', "${SourceCommit}:package.json") -FailureMessage 'Cannot read package.json at the artifact source commit.')
        $oldPackage = ($oldPackageLines -join "`n") | ConvertFrom-Json
        $currentPackage = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repoRoot 'package.json') | ConvertFrom-Json
        [void]$oldPackage.scripts.PSObject.Properties.Remove('release:desktop:ota')
        [void]$currentPackage.scripts.PSObject.Properties.Remove('release:desktop:ota')
        if (($oldPackage | ConvertTo-Json -Depth 30 -Compress) -ne ($currentPackage | ConvertTo-Json -Depth 30 -Compress)) {
            throw 'package.json changed beyond the formal OTA command entry after the artifact source commit.'
        }
    }
}

function Assert-VersionFacts {
    $package = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repoRoot 'package.json') | ConvertFrom-Json
    $lockText = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repoRoot 'package-lock.json')
    $tauri = Get-Content -Raw -Encoding UTF8 -LiteralPath $tauriConfigPath | ConvertFrom-Json
    $cargoToml = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $tauriDir 'Cargo.toml')
    $cargoLock = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $tauriDir 'Cargo.lock')
    $cargoTomlVersion = [regex]::Match($cargoToml, '(?m)^version = "([^"]+)"').Groups[1].Value
    $cargoLockVersion = [regex]::Match($cargoLock, '\[\[package\]\]\r?\nname = "echolike"\r?\nversion = "([^"]+)"').Groups[1].Value
    $lockRootVersion = [regex]::Match($lockText, '^\s*\{\s*"name"\s*:\s*"echolike"\s*,\s*"version"\s*:\s*"([^"]+)"').Groups[1].Value
    $lockPackageVersion = [regex]::Match($lockText, '"packages"\s*:\s*\{\s*""\s*:\s*\{\s*"name"\s*:\s*"echolike"\s*,\s*"version"\s*:\s*"([^"]+)"').Groups[1].Value
    $facts = @(
        $package.version,
        $lockRootVersion,
        $lockPackageVersion,
        $tauri.version,
        $cargoTomlVersion,
        $cargoLockVersion
    )
    if (@($facts | Where-Object { $_ -ne $Version }).Count -gt 0) {
        throw "Desktop version facts are inconsistent: $($facts -join ', ')"
    }
}

function Convert-ToVersionParts {
    param([Parameter(Mandatory)][string]$Value)

    $match = [regex]::Match($Value, '^(\d+)\.(\d+)\.(\d+)$')
    if (-not $match.Success) { throw "Not a canonical stable version: $Value" }
    return @(
        [System.Numerics.BigInteger]::Parse($match.Groups[1].Value),
        [System.Numerics.BigInteger]::Parse($match.Groups[2].Value),
        [System.Numerics.BigInteger]::Parse($match.Groups[3].Value)
    )
}

function Compare-StableVersion {
    param([string]$Left, [string]$Right)

    $leftParts = Convert-ToVersionParts $Left
    $rightParts = Convert-ToVersionParts $Right
    for ($index = 0; $index -lt 3; $index += 1) {
        if ($leftParts[$index] -lt $rightParts[$index]) { return -1 }
        if ($leftParts[$index] -gt $rightParts[$index]) { return 1 }
    }
    return 0
}

function Get-ReleaseEnvironment {
    $tauri = Get-Content -Raw -Encoding UTF8 -LiteralPath $tauriConfigPath | ConvertFrom-Json
    $endpoints = @($tauri.plugins.updater.endpoints)
    $endpointValue = if ($endpoints.Count -eq 1) { [string]$endpoints[0] } else { '' }
    if ($endpointValue -cne $productionTauriEndpoint) {
        throw 'Tauri updater endpoint is not bound to the authoritative production environment.'
    }
    return [pscustomobject]@{
        ApiBase = $productionPublicApiBaseUrl
        ArtifactBase = $productionArtifactBaseUrl
    }
}

function Get-HttpResponse {
    param([Parameter(Mandatory)][string]$Uri)

    Add-Type -AssemblyName System.Net.Http
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
    $deadline = [System.Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(30))
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Uri)
    $request.Headers.AcceptEncoding.ParseAdd('identity')
    $response = $null
    $stream = $null
    $memory = $null
    try {
        $response = $client.SendAsync(
            $request,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead,
            $deadline.Token
        ).GetAwaiter().GetResult()
        if ($response.Headers.Location) { throw 'Public JSON endpoint returned a redirect.' }
        if ($response.Content.Headers.ContentEncoding.Count -gt 0) {
            throw 'Public JSON endpoint used a content encoding.'
        }
        $declaredLength = $response.Content.Headers.ContentLength
        if ($null -ne $declaredLength -and [long]$declaredLength -gt 1048576) {
            throw 'Public JSON endpoint exceeded the 1 MiB response limit.'
        }
        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $memory = [System.IO.MemoryStream]::new()
        $buffer = New-Object byte[] 65536
        [long]$total = 0
        while (($read = $stream.ReadAsync($buffer, 0, $buffer.Length, $deadline.Token).GetAwaiter().GetResult()) -gt 0) {
            $total += $read
            if ($total -gt 1048576) { throw 'Public JSON endpoint exceeded the 1 MiB response limit.' }
            $memory.Write($buffer, 0, $read)
        }
        if ($null -ne $declaredLength -and [long]$declaredLength -ne $total) {
            throw 'Public JSON endpoint content length did not match its body.'
        }
        return [pscustomobject]@{
            Status = [int]$response.StatusCode
            Content = $utf8NoBom.GetString($memory.ToArray())
        }
    }
    finally {
        if ($memory) { $memory.Dispose() }
        if ($stream) { $stream.Dispose() }
        if ($response) { $response.Dispose() }
        $request.Dispose()
        $deadline.Dispose()
        $client.Dispose()
        $handler.Dispose()
    }
}

function Get-PublicLatestVersion {
    param([Parameter(Mandatory)]$Environment)

    $response = Get-HttpResponse "$($Environment.ApiBase)/app/update?version=0.0.0&platform=windows&arch=x86_64&channel=stable"
    if ($response.Status -ne 200) { throw "Public update baseline returned HTTP $($response.Status)." }
    $payload = $response.Content | ConvertFrom-Json
    [void](Convert-ToVersionParts $payload.latestVersion)
    return [string]$payload.latestVersion
}

function Assert-PublicBaseline {
    param([Parameter(Mandatory)]$Environment, [Parameter(Mandatory)][string]$BaselineVersion)

    foreach ($route in @('healthz', 'readyz')) {
        $response = Get-HttpResponse "$($Environment.ApiBase)/$route"
        if ($response.Status -ne 200) { throw "$route returned HTTP $($response.Status)." }
    }
    $current = Get-HttpResponse "$($Environment.ApiBase)/app/update?version=$BaselineVersion&platform=windows&arch=x86_64&channel=stable"
    $currentJson = $current.Content | ConvertFrom-Json
    if (
        $current.Status -ne 200 -or
        $currentJson.latestVersion -ne $BaselineVersion -or
        $currentJson.updateAvailable -or
        $currentJson.downloadUrl -or
        $currentJson.sha256 -or
        $currentJson.releaseNotes
    ) {
        throw 'Public latest-version baseline is inconsistent.'
    }
    foreach ($target in @('windows-x86_64', 'x86_64-pc-windows-msvc')) {
        $manifest = Get-HttpResponse "$($Environment.ApiBase)/app/update/tauri?version=$BaselineVersion&platform=$target&arch=x86_64&channel=stable"
        if ($manifest.Status -ne 204 -or $manifest.Content) { throw "Current Tauri manifest is not 204 for $target." }
    }
    $bootstrap = Get-HttpResponse "$($Environment.ApiBase)/desktop/bootstrap?version=$BaselineVersion&platform=windows&arch=x86_64&channel=stable"
    $bootstrapJson = $bootstrap.Content | ConvertFrom-Json
    if (
        $bootstrap.Status -ne 200 -or
        $bootstrapJson.ota.status -ne 'current' -or
        $bootstrapJson.policy.remoteConfigDelivery -ne 'startup' -or
        $bootstrapJson.policy.activation -ne 'next_start' -or
        $bootstrapJson.policy.backgroundPolling -ne $false -or
        $bootstrap.Content -match '(?i)downloadUrl|signature|fileName|storagePath|setup\.exe'
    ) {
        throw 'Bootstrap baseline policy or secrecy contract is inconsistent.'
    }
}

function Assert-FilesEqual {
    param([Parameter(Mandatory)][string]$Left, [Parameter(Mandatory)][string]$Right)

    $leftStream = [System.IO.File]::OpenRead($Left)
    $rightStream = [System.IO.File]::OpenRead($Right)
    try {
        if ($leftStream.Length -ne $rightStream.Length) { throw 'Artifact aliases have different lengths.' }
        $leftBuffer = New-Object byte[] 1048576
        $rightBuffer = New-Object byte[] 1048576
        do {
            $leftRead = $leftStream.Read($leftBuffer, 0, $leftBuffer.Length)
            $rightRead = $rightStream.Read($rightBuffer, 0, $rightBuffer.Length)
            if ($leftRead -ne $rightRead) { throw 'Artifact aliases returned different read lengths.' }
            for ($index = 0; $index -lt $leftRead; $index += 1) {
                if ($leftBuffer[$index] -ne $rightBuffer[$index]) {
                    throw "Artifact aliases differ at byte $($leftStream.Position - $leftRead + $index)."
                }
            }
        } while ($leftRead -gt 0)
    }
    finally {
        $leftStream.Dispose()
        $rightStream.Dispose()
    }
}

function Convert-ToWslPath {
    param([Parameter(Mandatory)][string]$WindowsPath)

    $lines = @(Invoke-External -Command 'wsl.exe' -Arguments @('-e', 'wslpath', '-a', '--', $WindowsPath) -FailureMessage 'Cannot convert Windows path to WSL.')
    $path = $lines[-1].Trim()
    if (-not $path.StartsWith('/')) { throw "Invalid WSL path: $path" }
    return $path
}

function Assert-PeVersion {
    param([Parameter(Mandatory)][string]$Actual, [Parameter(Mandatory)][string]$Label)

    $normalized = $Actual.Trim()
    if ($normalized -ne $Version -and $normalized -ne "$Version.0") {
        throw "$Label version is $normalized, expected $Version or $Version.0."
    }
}

function Get-StringSha256 {
    param([Parameter(Mandatory)][string]$Value)

    $digest = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($digest.ComputeHash($utf8NoBom.GetBytes($Value)))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $digest.Dispose()
    }
}

function Get-LocalArtifactPaths {
    $canonical = Join-Path $nsisDir "EcholIKE_${Version}_x64-setup.exe"
    return [pscustomobject]@{
        Canonical = $canonical
        CanonicalSignature = "$canonical.sig"
        Online = Join-Path $nsisDir "EcholIKE_${Version}_x64-online-setup.exe"
        OnlineSignature = Join-Path $nsisDir "EcholIKE_${Version}_x64-online-setup.exe.sig"
        Binary = Join-Path $targetDir 'release\echolike.exe'
    }
}

function Get-ArtifactFacts {
    param([Parameter(Mandatory)]$Paths)

    foreach ($path in @($Paths.Canonical, $Paths.CanonicalSignature, $Paths.Online, $Paths.OnlineSignature, $Paths.Binary)) {
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw "Artifact is not a regular non-reparse file: $path"
        }
    }
    foreach ($path in @($Paths.Canonical, $Paths.Online, $Paths.Binary)) {
        $length = (Get-Item -LiteralPath $path -Force).Length
        if ($length -le 0 -or $length -gt 536870912) {
            throw "Desktop artifact exceeds the 512 MiB local limit: $path"
        }
    }
    foreach ($path in @($Paths.CanonicalSignature, $Paths.OnlineSignature)) {
        $length = (Get-Item -LiteralPath $path -Force).Length
        if ($length -le 0 -or $length -gt 16384) {
            throw "Updater signature exceeds the 16 KiB local limit: $path"
        }
    }
    Assert-FilesEqual $Paths.Canonical $Paths.Online
    Assert-FilesEqual $Paths.CanonicalSignature $Paths.OnlineSignature
    Assert-PeVersion (Get-Item -LiteralPath $Paths.Canonical).VersionInfo.FileVersion 'Installer FileVersion'
    Assert-PeVersion (Get-Item -LiteralPath $Paths.Canonical).VersionInfo.ProductVersion 'Installer ProductVersion'
    Assert-PeVersion (Get-Item -LiteralPath $Paths.Binary).VersionInfo.FileVersion 'Binary FileVersion'
    Assert-PeVersion (Get-Item -LiteralPath $Paths.Binary).VersionInfo.ProductVersion 'Binary ProductVersion'

    $signatureValue = [System.IO.File]::ReadAllText($Paths.CanonicalSignature, $utf8NoBom)
    if ([string]::IsNullOrWhiteSpace($signatureValue) -or $signatureValue.Trim() -ne $signatureValue) {
        throw 'Updater signature is empty or has surrounding whitespace.'
    }
    $tsx = Join-Path $repoRoot 'server\node_modules\.bin\tsx.cmd'
    $verifyLines = @(
        Invoke-External -Command $tsx -Arguments @(
            $artifactVerifierPath,
            '--artifact', $Paths.Canonical,
            '--signature', $Paths.CanonicalSignature,
            '--config', $tauriConfigPath
        ) -FailureMessage 'Local Minisign verification failed.'
    )
    if ($verifyLines.Count -ne 1) {
        throw 'Local Minisign verifier returned an unsupported output shape.'
    }
    $verified = $verifyLines[0] | ConvertFrom-Json
    Assert-ExactJsonProperties $verified @('valid', 'artifactBytes', 'artifactSha256', 'signatureBytes', 'signatureSha256') 'Local Minisign verifier result'
    if ($verified.valid -ne $true) { throw 'Local Minisign verifier did not return valid=true.' }

    $unexpected = @(Get-ChildItem -LiteralPath (Join-Path $targetDir 'release\bundle') -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -like "*${Version}*" -and $_.FullName -notin @(
            (Get-Item $Paths.Canonical).FullName,
            (Get-Item $Paths.CanonicalSignature).FullName,
            (Get-Item $Paths.Online).FullName,
            (Get-Item $Paths.OnlineSignature).FullName
        )
    })
    if ($unexpected.Count -gt 0) { throw "Unexpected bundles for ${Version}: $($unexpected.Name -join ', ')" }

    return [pscustomobject]@{
        ArtifactBytes = [long]$verified.artifactBytes
        ArtifactSha256 = [string]$verified.artifactSha256
        SignatureBytes = [long]$verified.signatureBytes
        SignatureSha256 = [string]$verified.signatureSha256
        SignatureValue = $signatureValue
        BinaryBytes = (Get-Item -LiteralPath $Paths.Binary).Length
        BinarySha256 = (Get-FileHash -LiteralPath $Paths.Binary -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

function Write-ReleaseManifest {
    param(
        [Parameter(Mandatory)][string]$SourceCommit,
        [Parameter(Mandatory)][string]$BaselineVersion,
        [Parameter(Mandatory)][string]$Notes,
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)]$Facts
    )

    New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
    $manifest = [ordered]@{
        schemaVersion = 1
        sourceCommit = $SourceCommit
        publicApiBaseUrl = $productionPublicApiBaseUrl
        baselineVersion = $BaselineVersion
        version = $Version
        buildMode = 'online-nsis'
        releaseNotes = $Notes
        artifact = [ordered]@{
            fileName = [System.IO.Path]::GetFileName($Paths.Canonical)
            sourcePath = Convert-ToWslPath $Paths.Canonical
            bytes = $Facts.ArtifactBytes
            sha256 = $Facts.ArtifactSha256
            signature = [ordered]@{
                fileName = [System.IO.Path]::GetFileName($Paths.CanonicalSignature)
                sourcePath = Convert-ToWslPath $Paths.CanonicalSignature
                bytes = $Facts.SignatureBytes
                sha256 = $Facts.SignatureSha256
                value = $Facts.SignatureValue
            }
        }
    }
    Write-JsonFileAtomically -Path $manifestPath -Value $manifest -Depth 10
    return [pscustomobject]$manifest
}

function Write-BuildIntent {
    param(
        [Parameter(Mandatory)][string]$SourceCommit,
        [Parameter(Mandatory)][string]$BaselineVersion,
        [Parameter(Mandatory)][string]$Notes
    )

    New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
    $intent = [ordered]@{
        schemaVersion = 1
        sourceCommit = $SourceCommit
        publicApiBaseUrl = $productionPublicApiBaseUrl
        baselineVersion = $BaselineVersion
        version = $Version
        buildMode = 'online-nsis'
        releaseNotesSha256 = (Get-StringSha256 $Notes)
    }
    Write-JsonFileAtomically -Path $intentPath -Value $intent -Depth 5
    return [pscustomobject]$intent
}

function Read-BuildIntent {
    param([Parameter(Mandatory)][string]$ExpectedNotes)

    $intent = Read-StrictJsonFile -Path $intentPath -Label 'Build intent'
    Assert-ExactJsonProperties $intent @(
        'schemaVersion', 'sourceCommit', 'publicApiBaseUrl', 'baselineVersion', 'version', 'buildMode', 'releaseNotesSha256'
    ) 'Build intent'
    if (
        $intent.schemaVersion -ne 1 -or
        $intent.version -ne $Version -or
        $intent.publicApiBaseUrl -ne $productionPublicApiBaseUrl -or
        $intent.buildMode -ne 'online-nsis' -or
        $intent.sourceCommit -notmatch '^[a-f0-9]{40}$' -or
        $intent.releaseNotesSha256 -ne (Get-StringSha256 $ExpectedNotes) -or
        (Compare-StableVersion $intent.version $intent.baselineVersion) -le 0
    ) { throw 'Build intent does not match the requested release.' }
    Assert-ManifestProvenance ([string]$intent.sourceCommit)
    return $intent
}

function Read-ReleaseManifest {
    param([Parameter(Mandatory)][string]$ExpectedNotes)

    $manifest = Read-StrictJsonFile -Path $manifestPath -Label 'Release manifest'
    Assert-ExactJsonProperties $manifest @(
        'schemaVersion', 'sourceCommit', 'publicApiBaseUrl', 'baselineVersion', 'version', 'buildMode', 'releaseNotes', 'artifact'
    ) 'Release manifest'
    Assert-ExactJsonProperties $manifest.artifact @(
        'fileName', 'sourcePath', 'bytes', 'sha256', 'signature'
    ) 'Release manifest artifact'
    Assert-ExactJsonProperties $manifest.artifact.signature @(
        'fileName', 'sourcePath', 'bytes', 'sha256', 'value'
    ) 'Release manifest signature'
    if (
        $manifest.schemaVersion -ne 1 -or
        $manifest.version -ne $Version -or
        $manifest.publicApiBaseUrl -ne $productionPublicApiBaseUrl -or
        $manifest.buildMode -ne 'online-nsis' -or
        $manifest.releaseNotes -ne $ExpectedNotes -or
        $manifest.sourceCommit -notmatch '^[a-f0-9]{40}$' -or
        $manifest.artifact.bytes -le 0 -or
        $manifest.artifact.bytes -gt 536870912 -or
        $manifest.artifact.sha256 -notmatch '^[a-f0-9]{64}$' -or
        $manifest.artifact.signature.bytes -le 0 -or
        $manifest.artifact.signature.bytes -gt 16384 -or
        $manifest.artifact.signature.sha256 -notmatch '^[a-f0-9]{64}$' -or
        [string]::IsNullOrWhiteSpace([string]$manifest.artifact.signature.value) -or
        ([string]$manifest.artifact.signature.value).Trim() -ne [string]$manifest.artifact.signature.value -or
        $manifest.artifact.sourcePath -eq $manifest.artifact.signature.sourcePath -or
        $manifest.artifact.fileName -ne "EcholIKE_${Version}_x64-setup.exe" -or
        $manifest.artifact.signature.fileName -ne "EcholIKE_${Version}_x64-setup.exe.sig"
    ) {
        throw 'Release manifest identity does not match the requested release.'
    }
    if ((Compare-StableVersion $manifest.version $manifest.baselineVersion) -le 0) {
        throw 'Manifest target version is not newer than its public baseline.'
    }
    Assert-ManifestProvenance ([string]$manifest.sourceCommit)
    return $manifest
}

function Assert-ManifestMatchesLocalArtifacts {
    param([Parameter(Mandatory)]$Manifest)

    $paths = Get-LocalArtifactPaths
    $facts = Get-ArtifactFacts $paths
    if (
        $facts.ArtifactBytes -ne [long]$Manifest.artifact.bytes -or
        $facts.ArtifactSha256 -ne [string]$Manifest.artifact.sha256 -or
        $facts.SignatureBytes -ne [long]$Manifest.artifact.signature.bytes -or
        $facts.SignatureSha256 -ne [string]$Manifest.artifact.signature.sha256 -or
        $facts.SignatureValue -ne [string]$Manifest.artifact.signature.value -or
        (Convert-ToWslPath $paths.Canonical) -ne [string]$Manifest.artifact.sourcePath -or
        (Convert-ToWslPath $paths.CanonicalSignature) -ne [string]$Manifest.artifact.signature.sourcePath
    ) {
        throw 'Release manifest no longer matches the local artifacts.'
    }
}

function Assert-NoConcurrentDesktopBuild {
    $processes = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -in @('cargo.exe', 'rustc.exe', 'tauri.exe') -and $_.CommandLine -like '*EchoLike*'
    })
    if ($processes.Count -gt 0) { throw "Another EchoLike build is running: $($processes.ProcessId -join ', ')" }
}

function Assert-SigningMaterial {
    foreach ($path in @(
        (Join-Path $env:USERPROFILE '.tauri\echolike-updater.key'),
        (Join-Path $env:USERPROFILE '.tauri\echolike-updater.key.password')
    )) {
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if (
            $item.PSIsContainer -or
            ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            $item.Length -le 0
        ) {
            throw 'Updater signing material must be nonempty regular non-reparse files.'
        }
    }
}

function Invoke-Prepare {
    param([Parameter(Mandatory)][string]$Notes)

    Assert-CleanWorktree
    Assert-VersionFacts

    if (Test-Path -LiteralPath $manifestPath) {
        if (-not $Resume) { throw 'Release manifest already exists; pass -Resume to reuse it.' }
        $manifest = Read-ReleaseManifest $Notes
        Assert-ManifestMatchesLocalArtifacts $manifest
        Write-Host "Resume manifest verified: $manifestPath"
        return $manifest
    }

    $paths = Get-LocalArtifactPaths
    $stale = @(
        @($paths.Canonical, $paths.CanonicalSignature, $paths.Online, $paths.OnlineSignature) |
            Where-Object { Test-Path -LiteralPath $_ }
    )
    if ($Resume) {
        if (-not (Test-Path -LiteralPath $intentPath)) {
            throw 'Cannot resume without a release manifest or build intent.'
        }
        $intent = Read-BuildIntent $Notes
        if ($stale.Count -ne 4) { throw 'Build intent exists but the complete artifact set is unavailable.' }
        Assert-NoConcurrentDesktopBuild
        $facts = Get-ArtifactFacts $paths
        Assert-CleanWorktree
        Assert-VersionFacts
        Assert-ManifestProvenance ([string]$intent.sourceCommit)
        $manifest = Write-ReleaseManifest -SourceCommit ([string]$intent.sourceCommit) -BaselineVersion ([string]$intent.baselineVersion) -Notes $Notes -Paths $paths -Facts $facts
        Write-Host "Recovered manifest from verified build intent: $manifestPath"
        return $manifest
    }
    if ($stale.Count -gt 0) {
        throw 'Pre-existing target-version artifacts make build provenance ambiguous; remove them through an explicitly reviewed cleanup or resume from an existing manifest.'
    }
    if (Test-Path -LiteralPath $intentPath) { throw 'Build intent already exists; pass -Resume to recover it.' }

    $environment = Get-ReleaseEnvironment
    $baseline = Get-PublicLatestVersion $environment
    if ((Compare-StableVersion $Version $baseline) -le 0) {
        throw "Target $Version must be newer than public baseline $baseline."
    }
    Assert-PublicBaseline $environment $baseline
    $sourceCommit = Get-HeadCommit
    Assert-SigningMaterial
    Assert-NoConcurrentDesktopBuild
    [void](Write-BuildIntent -SourceCommit $sourceCommit -BaselineVersion $baseline -Notes $Notes)
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    Invoke-ExternalStreaming -Command 'npm.cmd' -Arguments @('run', 'build:desktop:ota') -FailureMessage 'Desktop OTA build failed.'
    $timer.Stop()
    Assert-CleanWorktree
    Assert-VersionFacts
    Assert-ManifestProvenance $sourceCommit
    Assert-NoConcurrentDesktopBuild
    $facts = Get-ArtifactFacts $paths
    $manifest = Write-ReleaseManifest -SourceCommit $sourceCommit -BaselineVersion $baseline -Notes $Notes -Paths $paths -Facts $facts
    Write-Host ("Prepare complete in {0:N1}s: {1} bytes, sha256 {2}" -f $timer.Elapsed.TotalSeconds, $facts.ArtifactBytes, $facts.ArtifactSha256)
    return $manifest
}

function Get-ProductionRoot {
    $lines = @(Invoke-External -Command 'wsl.exe' -Arguments @('-e', 'systemctl', 'show', 'echo-server.service', '--property=WorkingDirectory', '--value') -FailureMessage 'Cannot read EchoLike Server working directory.')
    $root = $lines[-1].Trim()
    if (-not $root.StartsWith('/') -or $root -eq '/' -or $root.Contains("`n") -or $root.Contains("`r") -or $root.Contains([string][char]92)) {
        throw 'EchoLike Server working directory is invalid.'
    }
    return $root.TrimEnd('/')
}

function Invoke-StaticPublisher {
    param([Parameter(Mandatory)]$Manifest)

    if (-not $Publish) { throw 'Static publication requires the explicit -Publish switch.' }
    $publisher = Convert-ToWslPath $staticPublisherPath
    $manifestWsl = Convert-ToWslPath $manifestPath
    Invoke-External -Command 'wsl.exe' -Arguments @('-e', 'python3', $publisher, '--manifest', $manifestWsl, '--preflight') -FailureMessage 'Static publisher preflight failed.' | ForEach-Object { Write-Host $_ }
    $rootWrapper = Get-Command wsl-u -ErrorAction SilentlyContinue
    if ($rootWrapper) {
        Invoke-External -Command $rootWrapper.Source -Arguments @('root', 'python3', $publisher, '--manifest', $manifestWsl, '--publish') -FailureMessage 'Static root publication failed.' | ForEach-Object { Write-Host $_ }
        Write-Host 'WSL root transport: wsl-u root'
    }
    else {
        Invoke-External -Command 'wsl.exe' -Arguments @('-u', 'root', '-e', 'python3', $publisher, '--manifest', $manifestWsl, '--publish') -FailureMessage 'Static root publication failed.' | ForEach-Object { Write-Host $_ }
        Write-Host 'WSL root transport: wsl.exe -u root (wsl-u unavailable)'
    }
}

function Invoke-ControlCli {
    param([Parameter(Mandatory)][ValidateSet('--inspect', '--create-draft', '--activate')][string]$Action)

    $productionRoot = Get-ProductionRoot
    $controlCli = Convert-ToWslPath $controlCliPath
    $manifestWsl = Convert-ToWslPath $manifestPath
    $lines = @(Invoke-External -Command 'wsl.exe' -Arguments @(
        '-e', '/usr/bin/node', $controlCli,
        '--manifest', $manifestWsl,
        '--production-root', $productionRoot,
        $Action
    ) -FailureMessage "OTA control action $Action failed.")
    $result = $lines[-1] | ConvertFrom-Json
    $expectedAction = $Action.Substring(2)
    if ($result.ok -ne $true -or $result.action -ne $expectedAction) {
        throw "OTA control action $expectedAction returned an invalid success envelope."
    }
    Write-Host ($result | ConvertTo-Json -Compress -Depth 10)
    return $result
}

function Assert-InspectableControlState {
    param([Parameter(Mandatory)]$State, [Parameter(Mandatory)]$Manifest)

    if (
        $State.ok -ne $true -or
        $State.action -ne 'inspect' -or
        $State.version -ne $Version -or
        $State.baselineVersion -ne $Manifest.baselineVersion -or
        $State.targetCount -notin @(0, 1) -or
        $State.enabledCount -lt 0 -or
        $State.latestVersion -notmatch '^\d+\.\d+\.\d+$'
    ) {
        throw 'OTA control inspection returned an invalid state envelope.'
    }
    if ($State.targetCount -eq 1 -and $State.payloadExact -ne $true) {
        throw 'The existing target release conflicts with the manifest payload.'
    }
}

function Assert-DisabledControlState {
    param([Parameter(Mandatory)]$State, [Parameter(Mandatory)]$Manifest)

    Assert-InspectableControlState $State $Manifest
    if (
        $State.targetCount -ne 1 -or
        $State.targetEnabled -ne $false -or
        $State.targetRevision -ne 0 -or
        $State.state -ne 'draft' -or
        $State.latestVersion -ne $Manifest.baselineVersion -or
        $State.baselineMatches -ne $true
    ) {
        throw 'OTA draft did not converge to one exact disabled target over the bound baseline.'
    }
}

function Assert-ActiveControlState {
    param([Parameter(Mandatory)]$State, [Parameter(Mandatory)]$Manifest)

    Assert-InspectableControlState $State $Manifest
    if (
        $State.targetCount -ne 1 -or
        $State.targetEnabled -ne $true -or
        $State.targetRevision -ne 1 -or
        $State.state -ne 'active' -or
        $State.latestVersion -ne $Version -or
        $State.enabledCount -ne 1
    ) {
        throw 'OTA control state did not converge to one enabled target release.'
    }
}

function Assert-DisabledDraftGate {
    param([Parameter(Mandatory)]$Manifest)

    $environment = Get-ReleaseEnvironment
    $latest = Get-PublicLatestVersion $environment
    if ($latest -ne $Manifest.baselineVersion) {
        throw "Disabled draft changed public latest version from $($Manifest.baselineVersion) to $latest."
    }
    Assert-PublicBaseline $environment ([string]$Manifest.baselineVersion)
}

function Get-PublicFileFacts {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][long]$ExpectedBytes
    )

    if ($ExpectedBytes -le 0) { throw "Public $Label expected length is invalid." }

    Add-Type -AssemblyName System.Net.Http
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
    $deadline = [System.Threading.CancellationTokenSource]::new([TimeSpan]::FromMinutes(3))
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Uri)
    $request.Headers.AcceptEncoding.ParseAdd('identity')
    $response = $null
    $stream = $null
    $digest = $null
    try {
        $response = $client.SendAsync(
            $request,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead,
            $deadline.Token
        ).GetAwaiter().GetResult()
        if ([int]$response.StatusCode -ne 200 -or $response.Headers.Location) {
            throw "Public $Label returned HTTP $([int]$response.StatusCode) or a redirect."
        }
        if ($response.Content.Headers.ContentEncoding.Count -gt 0) {
            throw "Public $Label used a content encoding."
        }
        $contentLength = $response.Content.Headers.ContentLength
        if ($null -eq $contentLength -or [long]$contentLength -ne $ExpectedBytes) {
            throw "Public $Label content length does not match the release manifest."
        }
        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $digest = [System.Security.Cryptography.SHA256]::Create()
        $buffer = New-Object byte[] 1048576
        [long]$total = 0
        while (($read = $stream.ReadAsync($buffer, 0, $buffer.Length, $deadline.Token).GetAwaiter().GetResult()) -gt 0) {
            [void]$digest.TransformBlock($buffer, 0, $read, $buffer, 0)
            $total += $read
            if ($total -gt $ExpectedBytes) {
                throw "Public $Label exceeded the release manifest length."
            }
        }
        [void]$digest.TransformFinalBlock((New-Object byte[] 0), 0, 0)
        if ($total -ne $ExpectedBytes) {
            throw "Public $Label streamed body does not match the release manifest length."
        }
        return [pscustomobject]@{
            Bytes = $total
            Sha256 = ([System.BitConverter]::ToString($digest.Hash)).Replace('-', '').ToLowerInvariant()
        }
    }
    finally {
        if ($digest) { $digest.Dispose() }
        if ($stream) { $stream.Dispose() }
        if ($response) { $response.Dispose() }
        $request.Dispose()
        $deadline.Dispose()
        $client.Dispose()
        $handler.Dispose()
    }
}

function Assert-PublicStaticArtifact {
    param([Parameter(Mandatory)]$Manifest)

    $environment = Get-ReleaseEnvironment
    $downloadUrl = "$($environment.ArtifactBase)$($Manifest.artifact.fileName)"
    $artifactFacts = Get-PublicFileFacts -Uri $downloadUrl -Label 'artifact-preflight' -ExpectedBytes ([long]$Manifest.artifact.bytes)
    $signatureFacts = Get-PublicFileFacts -Uri "$downloadUrl.sig" -Label 'signature-preflight' -ExpectedBytes ([long]$Manifest.artifact.signature.bytes)
    if (
        $artifactFacts.Bytes -ne [long]$Manifest.artifact.bytes -or
        $artifactFacts.Sha256 -ne [string]$Manifest.artifact.sha256 -or
        $signatureFacts.Bytes -ne [long]$Manifest.artifact.signature.bytes -or
        $signatureFacts.Sha256 -ne [string]$Manifest.artifact.signature.sha256
    ) { throw 'Public static artifact does not match the release manifest.' }
}

function Invoke-PublicVerification {
    param([Parameter(Mandatory)]$Manifest)

    $environment = Get-ReleaseEnvironment
    $notes = [string]$Manifest.releaseNotes
    $downloadUrl = "$($environment.ArtifactBase)$($Manifest.artifact.fileName)"
    foreach ($route in @('healthz', 'readyz')) {
        if ((Get-HttpResponse "$($environment.ApiBase)/$route").Status -ne 200) { throw "$route failed." }
    }
    $old = Get-HttpResponse "$($environment.ApiBase)/app/update?version=$($Manifest.baselineVersion)&platform=windows&arch=x86_64&channel=stable"
    $oldJson = $old.Content | ConvertFrom-Json
    if (
        $old.Status -ne 200 -or
        $oldJson.latestVersion -ne $Version -or
        -not $oldJson.updateAvailable -or
        $oldJson.autoUpdate -or
        $oldJson.forceUpdate -or
        $oldJson.downloadUrl -ne $downloadUrl -or
        $oldJson.sha256 -ne $Manifest.artifact.sha256 -or
        $oldJson.releaseNotes -ne $notes
    ) { throw 'Old-version public update contract mismatch.' }
    $current = Get-HttpResponse "$($environment.ApiBase)/app/update?version=$Version&platform=windows&arch=x86_64&channel=stable"
    $currentJson = $current.Content | ConvertFrom-Json
    if ($current.Status -ne 200 -or $currentJson.latestVersion -ne $Version -or $currentJson.updateAvailable -or $currentJson.downloadUrl -or $currentJson.sha256 -or $currentJson.releaseNotes) {
        throw 'Current-version public update contract mismatch.'
    }
    foreach ($target in @('windows-x86_64', 'x86_64-pc-windows-msvc')) {
        $oldManifest = Get-HttpResponse "$($environment.ApiBase)/app/update/tauri?version=$($Manifest.baselineVersion)&platform=$target&arch=x86_64&channel=stable"
        $payload = $oldManifest.Content | ConvertFrom-Json
        $platformNames = @($payload.platforms.PSObject.Properties.Name)
        if (
            $oldManifest.Status -ne 200 -or
            $payload.version -ne $Version -or
            $payload.notes -ne $notes -or
            $platformNames.Count -ne 1 -or
            $platformNames[0] -ne 'windows-x86_64' -or
            $payload.platforms.'windows-x86_64'.url -ne $downloadUrl -or
            $payload.platforms.'windows-x86_64'.signature -ne $Manifest.artifact.signature.value
        ) { throw "Tauri manifest mismatch for $target." }
        $currentManifest = Get-HttpResponse "$($environment.ApiBase)/app/update/tauri?version=$Version&platform=$target&arch=x86_64&channel=stable"
        if ($currentManifest.Status -ne 204 -or $currentManifest.Content) { throw "Current Tauri manifest mismatch for $target." }
    }
    foreach ($clientVersion in @([string]$Manifest.baselineVersion, $Version)) {
        $bootstrap = Get-HttpResponse "$($environment.ApiBase)/desktop/bootstrap?version=$clientVersion&platform=windows&arch=x86_64&channel=stable"
        $payload = $bootstrap.Content | ConvertFrom-Json
        $expectedStatus = if ($clientVersion -eq $Version) { 'current' } else { 'available' }
        if (
            $bootstrap.Status -ne 200 -or
            $payload.ota.status -ne $expectedStatus -or
            $payload.policy.remoteConfigDelivery -ne 'startup' -or
            $payload.policy.activation -ne 'next_start' -or
            $payload.policy.backgroundPolling -ne $false -or
            $bootstrap.Content -match '(?i)downloadUrl|signature|fileName|storagePath|setup\.exe'
        ) { throw "Bootstrap contract mismatch for $clientVersion." }
    }
    $artifactFacts = Get-PublicFileFacts -Uri $downloadUrl -Label 'artifact' -ExpectedBytes ([long]$Manifest.artifact.bytes)
    $signatureFacts = Get-PublicFileFacts -Uri "$downloadUrl.sig" -Label 'signature' -ExpectedBytes ([long]$Manifest.artifact.signature.bytes)
    if (
        $artifactFacts.Bytes -ne [long]$Manifest.artifact.bytes -or
        $artifactFacts.Sha256 -ne [string]$Manifest.artifact.sha256 -or
        $signatureFacts.Bytes -ne [long]$Manifest.artifact.signature.bytes -or
        $signatureFacts.Sha256 -ne [string]$Manifest.artifact.signature.sha256
    ) { throw 'Public artifact or signature bytes differ from the release manifest.' }

    $verification = [ordered]@{
        schemaVersion = 1
        verifiedAt = [DateTimeOffset]::UtcNow.ToString('O')
        version = $Version
        baselineVersion = [string]$Manifest.baselineVersion
        health = 200
        ready = 200
        tauriTargets = 2
        currentTauriStatus = 204
        artifactBytes = $artifactFacts.Bytes
        artifactSha256 = $artifactFacts.Sha256
        signatureBytes = $signatureFacts.Bytes
        signatureSha256 = $signatureFacts.Sha256
        bootstrapOld = 'available'
        bootstrapCurrent = 'current'
    }
    [System.IO.File]::WriteAllText($verificationPath, ($verification | ConvertTo-Json -Depth 6), $utf8NoBom)
    Write-Host ($verification | ConvertTo-Json -Compress)
    return [pscustomobject]$verification
}

$releaseToolLock = $null
Push-Location $repoRoot
try {
    $releaseToolLock = Enter-ReleaseToolLock $releaseLockPath
    if ($Stage -in @('Static', 'Draft', 'Activate', 'All') -and -not $Publish) {
        throw "$Stage requires the explicit -Publish switch."
    }
    Assert-CleanWorktree
    Assert-VersionFacts
    $notesInput = Read-ReleaseNotes $ReleaseNotesFile

    switch ($Stage) {
        'Prepare' {
            [void](Invoke-Prepare $notesInput.Text)
        }
        'Static' {
            $manifest = Read-ReleaseManifest $notesInput.Text
            Assert-ManifestMatchesLocalArtifacts $manifest
            Invoke-StaticPublisher $manifest
            Assert-PublicStaticArtifact $manifest
        }
        'Draft' {
            $manifest = Read-ReleaseManifest $notesInput.Text
            Assert-PublicStaticArtifact $manifest
            [void](Invoke-ControlCli '--create-draft')
            $draftState = Invoke-ControlCli '--inspect'
            Assert-DisabledControlState $draftState $manifest
            Assert-DisabledDraftGate $manifest
        }
        'Activate' {
            $manifest = Read-ReleaseManifest $notesInput.Text
            Assert-PublicStaticArtifact $manifest
            [void](Invoke-ControlCli '--activate')
            $activeState = Invoke-ControlCli '--inspect'
            Assert-ActiveControlState $activeState $manifest
            [void](Invoke-PublicVerification $manifest)
        }
        'Verify' {
            $manifest = Read-ReleaseManifest $notesInput.Text
            $activeState = Invoke-ControlCli '--inspect'
            Assert-ActiveControlState $activeState $manifest
            [void](Invoke-PublicVerification $manifest)
        }
        'All' {
            $manifest = Invoke-Prepare $notesInput.Text
            Invoke-StaticPublisher $manifest
            Assert-PublicStaticArtifact $manifest
            $state = Invoke-ControlCli '--inspect'
            Assert-InspectableControlState $state $manifest
            if ($state.targetEnabled -ne $true) {
                [void](Invoke-ControlCli '--create-draft')
                $draftState = Invoke-ControlCli '--inspect'
                Assert-DisabledControlState $draftState $manifest
                Assert-DisabledDraftGate $manifest
            }
            [void](Invoke-ControlCli '--activate')
            $activeState = Invoke-ControlCli '--inspect'
            Assert-ActiveControlState $activeState $manifest
            [void](Invoke-PublicVerification $manifest)
        }
    }
}
finally {
    if ($releaseToolLock) { $releaseToolLock.Dispose() }
    Pop-Location
}

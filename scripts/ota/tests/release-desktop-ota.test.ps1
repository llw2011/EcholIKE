$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$releaseScript = Join-Path $repoRoot 'scripts\release-desktop-ota.ps1'
$source = [System.IO.File]::ReadAllText($releaseScript, [System.Text.Encoding]::UTF8)
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $releaseScript,
    [ref]$tokens,
    [ref]$errors
)
if ($errors.Count -gt 0) {
    throw "PowerShell parser rejected the release tool: $($errors[0].Message)"
}
if ($source -match "-Arguments\s+@\(\s*'--'") {
    throw 'WSL commands must use -e argument transport instead of a shell command line.'
}

foreach ($name in @(
    'Invoke-External',
    'Invoke-ExternalStreaming',
    'Convert-ToWslPath',
    'Convert-ToVersionParts',
    'Compare-StableVersion',
    'Assert-VersionFacts',
    'Get-ReleaseEnvironment',
    'Enter-ReleaseToolLock',
    'Assert-ExactJsonProperties',
    'Read-StrictJsonFile',
    'Write-JsonFileAtomically'
)) {
    $matches = @($ast.FindAll(
        {
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                $node.Name -eq $Name
        },
        $true
    ))
    if ($matches.Count -ne 1) { throw "Expected exactly one release function named $name." }
    . ([ScriptBlock]::Create($matches[0].Extent.Text))
}

$staleAssignments = @($ast.FindAll(
    {
        param($node)
        $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
            $node.Left.Extent.Text -eq '$stale'
    },
    $true
))
if (
    $staleAssignments.Count -ne 1 -or
    $staleAssignments[0].Right -isnot [System.Management.Automation.Language.CommandExpressionAst] -or
    $staleAssignments[0].Right.Expression -isnot [System.Management.Automation.Language.ArrayExpressionAst]
) {
    throw 'Prepare must preserve zero or one existing artifacts as an array under strict mode.'
}

$verifierAssignments = @($ast.FindAll(
    {
        param($node)
        $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
            $node.Left.Extent.Text -eq '$verifyLines'
    },
    $true
))
if (
    $verifierAssignments.Count -ne 1 -or
    $verifierAssignments[0].Right -isnot [System.Management.Automation.Language.CommandExpressionAst] -or
    $verifierAssignments[0].Right.Expression -isnot [System.Management.Automation.Language.ArrayExpressionAst]
) {
    throw 'Local verifier output must remain an array when it emits one JSON line.'
}

$utf8NoBom = [System.Text.UTF8Encoding]::new($false, $true)
$tauriDir = Join-Path $repoRoot 'src-tauri'
$tauriConfigPath = Join-Path $tauriDir 'tauri.conf.json'
$productionPublicApiBaseUrl = 'https://api.example.com/echo-api'
$productionArtifactBaseUrl = 'https://api.example.com/echo-panel/ota/'
$productionTauriEndpoint = 'https://api.example.com/echo-api/app/update/tauri?version={{current_version}}&platform={{target}}&arch={{arch}}&channel=stable'
$Version = (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repoRoot 'package.json') | ConvertFrom-Json).version
Assert-VersionFacts
$releaseEnvironment = Get-ReleaseEnvironment
if (
    $releaseEnvironment.ApiBase -ne $productionPublicApiBaseUrl -or
    $releaseEnvironment.ArtifactBase -ne $productionArtifactBaseUrl
) {
    throw 'Release environment is not bound to the production authority.'
}
Invoke-ExternalStreaming -Command 'cmd.exe' -Arguments @('/d', '/c', 'echo informational 1>&2 & exit /b 0')
if ($ErrorActionPreference -ne 'Stop') {
    throw 'Streaming external command did not restore ErrorActionPreference after success.'
}
$streamingFailure = $false
try {
    Invoke-ExternalStreaming -Command 'cmd.exe' -Arguments @('/d', '/c', 'echo failure-detail 1>&2 & exit /b 7')
}
catch {
    $streamingFailure = $_.Exception.Message -match 'Exit=7'
}
if (-not $streamingFailure) { throw 'Streaming external command did not preserve its exit code.' }
if ($ErrorActionPreference -ne 'Stop') {
    throw 'Streaming external command did not restore ErrorActionPreference after failure.'
}
$missingStreamingCommandFailed = $false
try {
    Invoke-ExternalStreaming -Command 'echolike-missing-release-command.exe' -Arguments @()
}
catch {
    $missingStreamingCommandFailed = $true
}
if (-not $missingStreamingCommandFailed -or $ErrorActionPreference -ne 'Stop') {
    throw 'Streaming external command did not fail closed on an unresolved application.'
}
$singleLine = @(Invoke-External -Command 'cmd.exe' -Arguments @('/d', '/c', 'echo single-json-line'))
if ($singleLine.Count -ne 1 -or $singleLine[0] -ne 'single-json-line') {
    throw 'Single-line external output did not remain a one-item array at the call site.'
}
$converted = Convert-ToWslPath $releaseScript
if (
    -not $converted.StartsWith('/') -or
    $converted.Contains([string][char]92) -or
    -not $converted.EndsWith('/scripts/release-desktop-ota.ps1')
) {
    throw "WSL path conversion returned an invalid path: $converted"
}

if ((Compare-StableVersion '9007199254740993.0.0' '9007199254740992.999.999') -ne 1) {
    throw 'Stable version comparison lost integer precision.'
}
if ((Compare-StableVersion '0.2.15' '0.2.15') -ne 0) {
    throw 'Stable version equality is inconsistent.'
}

$testRoot = Join-Path $repoRoot ('.ota-tool-selftest-' + [Guid]::NewGuid().ToString('N'))
$authorityPath = Join-Path $testRoot 'state.json'
$lockPath = Join-Path $testRoot 'release.lock'
[System.IO.Directory]::CreateDirectory($testRoot) | Out-Null
try {
    $firstLock = Enter-ReleaseToolLock $lockPath
    try {
        $secondLockFailed = $false
        try { [void](Enter-ReleaseToolLock $lockPath) } catch { $secondLockFailed = $true }
        if (-not $secondLockFailed) { throw 'Release tool lock allowed a second owner.' }
    }
    finally {
        $firstLock.Dispose()
    }
    $reacquired = Enter-ReleaseToolLock $lockPath
    $reacquired.Dispose()

    $artifactRoot = Join-Path $testRoot 'artifact-matrix'
    [System.IO.Directory]::CreateDirectory($artifactRoot) | Out-Null
    $artifactPaths = @(1..4 | ForEach-Object { Join-Path $artifactRoot "artifact-$_.bin" })
    $existingArtifacts = @(
        $artifactPaths | Where-Object { Test-Path -LiteralPath $_ }
    )
    if ($existingArtifacts.Count -ne 0) {
        throw 'Empty artifact discovery did not remain an empty array under strict mode.'
    }
    [System.IO.File]::WriteAllBytes($artifactPaths[0], [byte[]]@(1))
    $existingArtifacts = @(
        $artifactPaths | Where-Object { Test-Path -LiteralPath $_ }
    )
    if ($existingArtifacts.Count -ne 1 -or $existingArtifacts[0] -ne $artifactPaths[0]) {
        throw 'Single artifact discovery did not remain a one-item array under strict mode.'
    }
    foreach ($path in $artifactPaths[1..3]) {
        [System.IO.File]::WriteAllBytes($path, [byte[]]@(1))
    }
    $existingArtifacts = @(
        $artifactPaths | Where-Object { Test-Path -LiteralPath $_ }
    )
    if ($existingArtifacts.Count -ne 4) {
        throw 'Complete artifact discovery did not preserve all four items.'
    }
    Remove-Item -LiteralPath $artifactRoot -Recurse -Force

    $authority = [ordered]@{ schemaVersion = 1; value = '中文' }
    Write-JsonFileAtomically -Path $authorityPath -Value $authority -Depth 3
    $readback = Read-StrictJsonFile -Path $authorityPath -Label 'Self-test authority'
    Assert-ExactJsonProperties $readback @('schemaVersion', 'value') 'Self-test authority'
    if ($readback.schemaVersion -ne 1 -or $readback.value -ne '中文') {
        throw 'Atomic UTF-8 authority readback failed.'
    }

    $collisionFailed = $false
    try {
        Write-JsonFileAtomically -Path $authorityPath -Value ([ordered]@{
            schemaVersion = 2
            value = 'must-not-overwrite'
        }) -Depth 3
    }
    catch {
        $collisionFailed = $true
    }
    if (-not $collisionFailed) { throw 'Atomic authority write did not fail on collision.' }
    $unchanged = Read-StrictJsonFile -Path $authorityPath -Label 'Self-test authority'
    if ($unchanged.schemaVersion -ne 1) { throw 'Collision overwrote the first authority file.' }

    $residue = @(Get-ChildItem -LiteralPath $testRoot -Force)
    $expectedResidue = @($authorityPath, $lockPath) | Sort-Object
    $actualResidue = @($residue.FullName | Sort-Object)
    if ($actualResidue.Count -ne 2 -or @(Compare-Object $expectedResidue $actualResidue).Count -gt 0) {
        throw 'Atomic authority test left an unexpected temporary file.'
    }
}
finally {
    if (Test-Path -LiteralPath $authorityPath -PathType Leaf) {
        Remove-Item -LiteralPath $authorityPath -Force
    }
    if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
        Remove-Item -LiteralPath $lockPath -Force
    }
    if (Test-Path -LiteralPath $testRoot -PathType Container) {
        Remove-Item -LiteralPath $testRoot -Force
    }
}

Write-Output "release-desktop-ota PowerShell tests passed; tokens=$($tokens.Count)"

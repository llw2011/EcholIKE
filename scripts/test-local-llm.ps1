param(
    [string]$BaseUrl = $env:ECHO_LOCAL_LLM_BASE_URL,
    [string]$Model = $env:ECHO_LOCAL_LLM_MODEL,
    [string]$Prompt = "Reply with OK only."
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    throw "BaseUrl is required. Pass -BaseUrl or set ECHO_LOCAL_LLM_BASE_URL."
}
if ([string]::IsNullOrWhiteSpace($Model)) {
    throw "Model is required. Pass -Model or set ECHO_LOCAL_LLM_MODEL."
}

$base = $BaseUrl.Trim().TrimEnd("/")
$modelsUrl = "$base/models"
$chatUrl = "$base/chat/completions"

$modelResponse = Invoke-RestMethod -Method Get -Uri $modelsUrl -TimeoutSec 15
$modelIds = @()

if ($modelResponse.data) {
    foreach ($item in $modelResponse.data) {
        if ($item.id) {
            $modelIds += [string]$item.id
        }
    }
}
if ($modelResponse.models) {
    foreach ($item in $modelResponse.models) {
        if ($item.name) {
            $modelIds += [string]$item.name
        }
    }
}

$modelIds = $modelIds | Sort-Object -Unique
if (-not $modelIds -or $modelIds.Count -eq 0) {
    throw "No models returned by $modelsUrl."
}

$resolvedModel = $Model.Trim()
if ($modelIds -notcontains $resolvedModel) {
    $matches = @($modelIds | Where-Object { $_.StartsWith($resolvedModel) })
    if ($matches.Count -eq 0) {
        throw "Model '$resolvedModel' was not found. Available: $($modelIds -join ', ')"
    }
    $resolvedModel = $matches[0]
}

$body = @{
    model = $resolvedModel
    messages = @(@{ role = "user"; content = $Prompt })
    temperature = 0
    max_tokens = 16
    stream = $false
} | ConvertTo-Json -Depth 8

$started = Get-Date
$response = Invoke-RestMethod -Method Post -Uri $chatUrl -ContentType "application/json" -Body $body -TimeoutSec 90
$elapsedMs = [int]((Get-Date) - $started).TotalMilliseconds
$content = [string]$response.choices[0].message.content

if ([string]::IsNullOrWhiteSpace($content)) {
    throw "Chat completion returned an empty message."
}

Write-Host "Local LLM smoke test passed"
Write-Host ("Base URL: {0}" -f $base)
Write-Host ("Model: {0}" -f $resolvedModel)
Write-Host ("Latency: {0}ms" -f $elapsedMs)
Write-Host ("Response: {0}" -f $content.Trim())

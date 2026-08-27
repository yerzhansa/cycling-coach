#!/usr/bin/env pwsh
#Requires -Version 7.0

param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,
  [string]$SubjectDn = "CN=Enduragent Self-Signed Test, O=Enduragent Test Fixture",
  [string]$TimestampServer = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"

function Find-Signtool {
  $command = Get-Command signtool.exe -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -ne $command) { return $command.Source }
  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (-not (Test-Path -LiteralPath $kitsRoot -PathType Container)) { return $null }
  $versions = @(Get-ChildItem -LiteralPath $kitsRoot -Directory | ForEach-Object {
    try {
      [ordered]@{ version = [version]$_.Name; path = $_.FullName }
    } catch {
    }
  } | Sort-Object version -Descending)
  foreach ($version in $versions) {
    $candidate = Join-Path $version.path "x64\signtool.exe"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  return $null
}

function Invoke-Rfc3161Sign {
  param(
    [string]$SigntoolPath,
    [string]$Target,
    [string]$Thumbprint,
    [string]$TimestampUrl
  )
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $SigntoolPath
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in @(
    "sign", "/sha1", $Thumbprint, "/s", "My", "/fd", "SHA256",
    "/tr", $TimestampUrl, "/td", "SHA256", $Target
  )) {
    $null = $startInfo.ArgumentList.Add($argument)
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  $null = $process.Start()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $null = $stdoutTask.GetAwaiter().GetResult()
  $null = $stderrTask.GetAwaiter().GetResult()
  return $process.ExitCode
}

if (-not $IsWindows) {
  Write-Output ([ordered]@{ error = "windows-only" } | ConvertTo-Json -Compress)
  exit 2
}

$certificate = $null
try {
  $scriptDirectory = Split-Path -Parent $PSCommandPath
  $repositoryRoot = [IO.Path]::GetFullPath((Join-Path $scriptDirectory "..\..\.."))
  $resolvedOutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
  $repositoryPrefix = $repositoryRoot.TrimEnd('\') + '\'
  if (
    [string]::Equals($resolvedOutputDirectory, $repositoryRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $resolvedOutputDirectory.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "output directory must be outside the repository"
  }
  $null = New-Item -ItemType Directory -Path $resolvedOutputDirectory -Force
  $resolvedOutputDirectory = (Resolve-Path -LiteralPath $resolvedOutputDirectory).ProviderPath
  if (
    [string]::Equals($resolvedOutputDirectory, $repositoryRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $resolvedOutputDirectory.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "output directory must be outside the repository"
  }
  $fixturePath = Join-Path $resolvedOutputDirectory "fixture.exe"
  Copy-Item -LiteralPath (Join-Path ([System.Environment]::SystemDirectory) "where.exe") -Destination $fixturePath
  $certificate = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $SubjectDn `
    -HashAlgorithm SHA256 `
    -CertStoreLocation Cert:\CurrentUser\My `
    -NotAfter ([DateTime]::Now.AddDays(1))
  $rfc3161 = $false
  $signtoolPath = Find-Signtool
  if ($null -ne $signtoolPath) {
    $rfc3161 = (Invoke-Rfc3161Sign `
      -SigntoolPath $signtoolPath `
      -Target $fixturePath `
      -Thumbprint $certificate.Thumbprint `
      -TimestampUrl $TimestampServer) -eq 0
  }
  if ($rfc3161) {
    $signature = Get-AuthenticodeSignature -LiteralPath $fixturePath
  } else {
    Copy-Item -LiteralPath (Join-Path ([System.Environment]::SystemDirectory) "where.exe") -Destination $fixturePath -Force
    $signature = Set-AuthenticodeSignature `
      -LiteralPath $fixturePath `
      -Certificate $certificate `
      -HashAlgorithm SHA256
  }
  $summary = [ordered]@{
    fixturePath = $fixturePath
    subject = $certificate.Subject
    thumbprint = $certificate.Thumbprint
    timestamped = $null -ne $signature.TimeStamperCertificate
    rfc3161 = $rfc3161
  }
  Write-Output ($summary | ConvertTo-Json -Compress)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  Write-Output ([ordered]@{ error = "fixture-generation-failed" } | ConvertTo-Json -Compress)
  exit 1
} finally {
  if ($null -ne $certificate) {
    Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
  }
}

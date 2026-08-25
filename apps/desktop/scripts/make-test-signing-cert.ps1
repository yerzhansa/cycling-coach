#!/usr/bin/env pwsh
#Requires -Version 7.0

param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,
  [string]$SubjectDn = "CN=Enduragent Self-Signed Test, O=Enduragent Test Fixture",
  [string]$TimestampServer = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"

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
  try {
    $signature = Set-AuthenticodeSignature `
      -LiteralPath $fixturePath `
      -Certificate $certificate `
      -HashAlgorithm SHA256 `
      -TimestampServer $TimestampServer
  } catch {
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

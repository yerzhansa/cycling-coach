#!/usr/bin/env pwsh
#Requires -Version 7.0

param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedPublisherDn,
  [string]$ExpectedThumbprint,
  [switch]$AllowSelfSignedTest,
  [switch]$AllowMissingSigntool
)

$ErrorActionPreference = "Stop"
$checks = [Collections.Generic.List[object]]::new()
$resolvedInstallerPath = $InstallerPath
$signer = $null
$timestamper = $null
$status = $null
$statusMessage = $null
$digestAlgorithm = $null
$rfc3161 = $false
$signtool = [ordered]@{ path = $null; exitCode = $null; output = "" }
$versionInfo = [ordered]@{ productVersion = $null; legalTrademarks = $null }

function Add-VerificationCheck {
  param([string]$Name, [bool]$Ok, [string]$Detail)
  $checks.Add([ordered]@{ name = $Name; ok = $Ok; detail = $Detail })
}

function Write-VerificationSummary {
  param([bool]$Ok)
  $summary = [ordered]@{
    schema = "windows-authenticode-verification/2"
    installerPath = $resolvedInstallerPath
    ok = $Ok
    signer = $signer
    timestamper = $timestamper
    status = $status
    statusMessage = $statusMessage
    digestAlgorithm = $digestAlgorithm
    rfc3161 = $rfc3161
    signtool = $signtool
    versionInfo = $versionInfo
    allowSelfSignedTest = [bool]$AllowSelfSignedTest
    checks = @($checks)
  }
  Write-Output ($summary | ConvertTo-Json -Depth 6 -Compress)
}

function Get-PrimarySignedCms {
  param([string]$Path)
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
    throw "invalid PE header"
  }
  $peOffset = [BitConverter]::ToUInt32($bytes, 60)
  if ($peOffset -gt $bytes.Length - 28) { throw "invalid PE offset" }
  if (
    $bytes[$peOffset] -ne 0x50 -or
    $bytes[$peOffset + 1] -ne 0x45 -or
    $bytes[$peOffset + 2] -ne 0 -or
    $bytes[$peOffset + 3] -ne 0
  ) {
    throw "invalid PE signature"
  }
  $optionalHeaderOffset = $peOffset + 24
  $magic = [BitConverter]::ToUInt16($bytes, $optionalHeaderOffset)
  if ($magic -eq 0x10b) {
    $dataDirectoryOffset = $optionalHeaderOffset + 96
    $directoryCountOffset = $optionalHeaderOffset + 92
  } elseif ($magic -eq 0x20b) {
    $dataDirectoryOffset = $optionalHeaderOffset + 112
    $directoryCountOffset = $optionalHeaderOffset + 108
  } else {
    throw "invalid PE optional header"
  }
  if ($directoryCountOffset -gt $bytes.Length - 4) { throw "invalid PE data directories" }
  if ([BitConverter]::ToUInt32($bytes, $directoryCountOffset) -le 4) {
    throw "missing PE security directory"
  }
  $securityEntryOffset = $dataDirectoryOffset + 32
  if ($securityEntryOffset -gt $bytes.Length - 8) { throw "invalid PE security directory" }
  $certificateOffset = [BitConverter]::ToUInt32($bytes, $securityEntryOffset)
  $certificateDirectorySize = [BitConverter]::ToUInt32($bytes, $securityEntryOffset + 4)
  if (
    $certificateOffset -eq 0 -or
    $certificateDirectorySize -lt 8 -or
    $certificateOffset -gt $bytes.Length - 8 -or
    $certificateDirectorySize -gt $bytes.Length - $certificateOffset
  ) {
    throw "invalid PE certificate table"
  }
  $certificateLength = [BitConverter]::ToUInt32($bytes, $certificateOffset)
  if (
    $certificateLength -lt 8 -or
    $certificateLength -gt $certificateDirectorySize -or
    $certificateLength -gt $bytes.Length - $certificateOffset
  ) {
    throw "invalid WIN_CERTIFICATE"
  }
  $encodedLength = $certificateLength - 8
  $encoded = [byte[]]::new($encodedLength)
  [Array]::Copy($bytes, $certificateOffset + 8, $encoded, 0, $encodedLength)
  $cms = [System.Security.Cryptography.Pkcs.SignedCms]::new()
  $cms.Decode($encoded)
  return $cms
}

function Get-ContentDigestOid {
  param($Cms)
  $reader = [System.Formats.Asn1.AsnReader]::new(
    $Cms.ContentInfo.Content,
    [System.Formats.Asn1.AsnEncodingRules]::DER
  )
  $content = $reader.ReadSequence()
  $null = $content.ReadEncodedValue()
  $digestInfo = $content.ReadSequence()
  $algorithm = $digestInfo.ReadSequence()
  return $algorithm.ReadObjectIdentifier()
}

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

function Invoke-Signtool {
  param([string]$Path, [string]$Target)
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $Path
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in @("verify", "/pa", "/all", "/v", $Target)) {
    $null = $startInfo.ArgumentList.Add($argument)
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  $null = $process.Start()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $output = "$($stdoutTask.GetAwaiter().GetResult())$($stderrTask.GetAwaiter().GetResult())"
  return [ordered]@{ exitCode = $process.ExitCode; output = $output }
}

try {
  if ($ExpectedPublisherDn -eq "" -or $ExpectedPublisherDn -ne $ExpectedPublisherDn.Trim()) {
    throw "invalid expected publisher DN"
  }
  if (
    $ExpectedThumbprint -ne "" -and
    -not [Text.RegularExpressions.Regex]::IsMatch($ExpectedThumbprint, "\A[0-9A-Fa-f]{40}\z")
  ) {
    throw "invalid expected thumbprint"
  }
  $resolvedInstallerPath = [IO.Path]::GetFullPath($InstallerPath)
  $item = Get-Item -LiteralPath $resolvedInstallerPath -Force -ErrorAction SilentlyContinue
  $fileOk =
    $null -ne $item -and
    -not $item.PSIsContainer -and
    ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and
    [string]::Equals([IO.Path]::GetExtension($resolvedInstallerPath), ".exe", [StringComparison]::OrdinalIgnoreCase)
  Add-VerificationCheck -Name "file" -Ok $fileOk -Detail $(if ($fileOk) { "regular-executable" } else { "invalid-installer-path" })
  if (-not $fileOk) {
    Add-VerificationCheck -Name "status" -Ok $false -Detail "file-unavailable"
    Add-VerificationCheck -Name "digest" -Ok $false -Detail "file-unavailable"
    Add-VerificationCheck -Name "timestamp" -Ok $false -Detail "file-unavailable"
    Add-VerificationCheck -Name "subject" -Ok $false -Detail "file-unavailable"
    if ($ExpectedThumbprint -ne "") {
      Add-VerificationCheck -Name "thumbprint" -Ok $false -Detail "file-unavailable"
    }
    Add-VerificationCheck -Name "chain" -Ok $false -Detail "file-unavailable"
    Add-VerificationCheck -Name "signtool" -Ok $false -Detail "file-unavailable"
    Write-VerificationSummary -Ok $false
    exit 1
  }

  $fileVersionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($resolvedInstallerPath)
  if ($null -ne $fileVersionInfo) {
    $versionInfo.productVersion = $fileVersionInfo.ProductVersion
    $versionInfo.legalTrademarks = $fileVersionInfo.LegalTrademarks
  }
  $null = Add-Type -AssemblyName System.Security.Cryptography.Pkcs
  $signature = Get-AuthenticodeSignature -LiteralPath $resolvedInstallerPath
  $status = [string]$signature.Status
  $statusMessage = [string]$signature.StatusMessage
  if ($null -ne $signature.SignerCertificate) {
    $signer = [ordered]@{
      subject = $signature.SignerCertificate.Subject
      thumbprint = $signature.SignerCertificate.Thumbprint
      issuer = $signature.SignerCertificate.Issuer
      notAfter = $signature.SignerCertificate.NotAfter.ToUniversalTime().ToString("o")
    }
  }
  if ($null -ne $signature.TimeStamperCertificate) {
    $timestamper = [ordered]@{ subject = $signature.TimeStamperCertificate.Subject }
  }
  $thumbprintMatches =
    $ExpectedThumbprint -ne "" -and
    $null -ne $signature.SignerCertificate -and
    [string]::Equals(
      $signature.SignerCertificate.Thumbprint,
      $ExpectedThumbprint,
      [StringComparison]::OrdinalIgnoreCase
    )
  $untrustedRoot =
    ($status -eq "NotTrusted" -or $status -eq "UnknownError") -and
    [Text.RegularExpressions.Regex]::IsMatch(
      $statusMessage,
      "untrusted root|root certificate which is not trusted|terminated in a root certificate",
      [Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
  $testTrustAccepted =
    [bool]$AllowSelfSignedTest -and
    $ExpectedThumbprint -ne "" -and
    $thumbprintMatches -and
    $untrustedRoot
  $statusOk = $status -eq "Valid" -or $testTrustAccepted
  Add-VerificationCheck -Name "status" -Ok $statusOk -Detail $status

  try {
    $cms = Get-PrimarySignedCms -Path $resolvedInstallerPath
    $digestOid = Get-ContentDigestOid -Cms $cms
    if ($digestOid -eq "2.16.840.1.101.3.4.2.1") {
      $digestAlgorithm = "sha256"
    } elseif ($digestOid -eq "1.3.14.3.2.26") {
      $digestAlgorithm = "sha1"
    } else {
      $digestAlgorithm = $digestOid
    }
    Add-VerificationCheck -Name "digest" -Ok ($digestOid -eq "2.16.840.1.101.3.4.2.1") -Detail $digestAlgorithm
    $primarySigner = if ($cms.SignerInfos.Count -gt 0) { $cms.SignerInfos[0] } else { $null }
    $rfc3161 =
      $null -ne $primarySigner -and
      @($primarySigner.UnsignedAttributes | Where-Object {
        $_.Oid.Value -eq "1.3.6.1.4.1.311.3.3.1"
      }).Count -gt 0
  } catch {
    Add-VerificationCheck -Name "digest" -Ok $false -Detail "unreadable-primary-signature"
    $rfc3161 = $false
  }
  $timestampOk = $rfc3161 -and $null -ne $signature.TimeStamperCertificate
  Add-VerificationCheck -Name "timestamp" -Ok $timestampOk -Detail $(if ($timestampOk) { "rfc3161" } else { "rfc3161-missing" })

  $subjectOk =
    $null -ne $signature.SignerCertificate -and
    [string]::Equals(
      $signature.SignerCertificate.Subject,
      $ExpectedPublisherDn,
      [StringComparison]::Ordinal
    )
  Add-VerificationCheck -Name "subject" -Ok $subjectOk -Detail $(if ($null -eq $signer) { "signer-missing" } else { $signer.subject })
  if ($ExpectedThumbprint -ne "") {
    Add-VerificationCheck -Name "thumbprint" -Ok $thumbprintMatches -Detail $(if ($null -eq $signer) { "signer-missing" } else { $signer.thumbprint })
  }

  $chainOk = $status -eq "Valid" -or $testTrustAccepted
  $chainDetail = if ($testTrustAccepted) { "untrusted-root-accepted-for-test" } elseif ($status -eq "Valid") { "trusted" } else { "untrusted" }
  Add-VerificationCheck -Name "chain" -Ok $chainOk -Detail $chainDetail

  $signtoolPath = Find-Signtool
  if ($null -eq $signtoolPath) {
    $signtoolOk = [bool]$AllowMissingSigntool
    Add-VerificationCheck -Name "signtool" -Ok $signtoolOk -Detail "signtool-unavailable"
  } else {
    $signtool.path = $signtoolPath
    $signtoolResult = Invoke-Signtool -Path $signtoolPath -Target $resolvedInstallerPath
    $signtool.exitCode = $signtoolResult.exitCode
    $signtool.output = $signtoolResult.output
    $signtoolOk = $signtoolResult.exitCode -eq 0 -or [bool]$AllowSelfSignedTest
    Add-VerificationCheck -Name "signtool" -Ok $signtoolOk -Detail "exit-code-$($signtoolResult.exitCode)"
  }

  $ok = @($checks | Where-Object { -not $_.ok }).Count -eq 0
  Write-VerificationSummary -Ok $ok
  if ($ok) { exit 0 }
  exit 1
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $checks.Clear()
  Add-VerificationCheck -Name "error" -Ok $false -Detail "script-error"
  Write-VerificationSummary -Ok $false
  exit 2
}

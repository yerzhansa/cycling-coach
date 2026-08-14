param(
  [Parameter(Mandatory = $true)]
  [string]$RequestPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Get-UninstallRegistrations {
  param($Request)
  $root = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
  $installRoot = "HKCU:\Software\$($Request.guid)"
  $installLocation = if (Test-Path -LiteralPath $installRoot) {
    (Get-ItemProperty -LiteralPath $installRoot).InstallLocation
  } else {
    $null
  }
  if (-not (Test-Path -LiteralPath $root)) { return @() }
  $items = @(Get-ChildItem -LiteralPath $root | ForEach-Object {
    $value = Get-ItemProperty -LiteralPath $_.PSPath
    $matchesIdentity =
      $value.DisplayName -eq "$($Request.productName) $($Request.version)" -or
      $_.PSChildName -eq $Request.guid -or
      $_.PSChildName -eq $Request.appId
    if ($matchesIdentity) {
      [ordered]@{
        keyPath = $_.Name
        keyName = $_.PSChildName
        displayName = $value.DisplayName
        displayVersion = $value.DisplayVersion
        installLocation = $installLocation
        uninstallString = $value.UninstallString
        quietUninstallString = $value.QuietUninstallString
      }
    }
  })
  return $items
}

function Test-ContainedPath {
  param([string]$Root, [string]$Candidate)
  $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $candidatePath = [IO.Path]::GetFullPath($Candidate)
  return $candidatePath.Equals($rootPath, [StringComparison]::OrdinalIgnoreCase) -or
    $candidatePath.StartsWith("$rootPath\", [StringComparison]::OrdinalIgnoreCase)
}

function Get-ProgramResidues {
  param($Request)
  if (-not (Test-Path -LiteralPath $Request.programsRoot -PathType Container)) { return @() }
  return @(Get-ChildItem -LiteralPath $Request.programsRoot -Force -Directory | Where-Object {
    (Test-Path -LiteralPath (Join-Path $_.FullName "$($Request.productName).exe") -PathType Leaf) -or
      (Test-Path -LiteralPath (Join-Path $_.FullName "Uninstall $($Request.productName).exe") -PathType Leaf)
  } | ForEach-Object { $_.FullName })
}

function Get-MatchingProcesses {
  param($Request)
  if ($null -ne $Request.installRoot -and $Request.installRoot -ne "") {
    $roots = @($Request.installRoot)
  } else {
    $roots = @()
    $roots += @(Get-ProgramResidues -Request $Request)
    $roots += @(Get-UninstallRegistrations -Request $Request | ForEach-Object {
      $_.installLocation
    } | Where-Object {
      $null -ne $_ -and $_ -ne "" -and
        (Test-ContainedPath -Root $Request.programsRoot -Candidate $_)
    })
  }
  return @(Get-CimInstance Win32_Process | ForEach-Object {
    if ($null -eq $_.ExecutablePath -or $_.ExecutablePath -eq "") { return }
    foreach ($root in $roots) {
      if (Test-ContainedPath -Root $root -Candidate $_.ExecutablePath) {
        [ordered]@{ id = [int]$_.ProcessId; executablePath = $_.ExecutablePath }
        break
      }
    }
  })
}

function Get-RegistryValueEvidence {
  param([string]$KeyPath, [string]$Name, [bool]$Binary)
  if (-not (Test-Path -LiteralPath $KeyPath)) {
    return [ordered]@{ exists = $false; value = $null; valueBase64 = $null }
  }
  $key = Get-Item -LiteralPath $KeyPath
  if (-not ($key.GetValueNames() -contains $Name)) {
    return [ordered]@{ exists = $false; value = $null; valueBase64 = $null }
  }
  $value = $key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($Binary) {
    return [ordered]@{ exists = $true; value = $null; valueBase64 = [Convert]::ToBase64String([byte[]]$value) }
  }
  return [ordered]@{ exists = $true; value = [string]$value; valueBase64 = $null }
}

function Get-ReparsePaths {
  param($Roots)
  $paths = @()
  foreach ($root in @($Roots)) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $rootItem = Get-Item -LiteralPath $root -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $paths += $rootItem.FullName }
    $paths += @(Get-ChildItem -LiteralPath $root -Force -Recurse | Where-Object {
      ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    } | ForEach-Object { $_.FullName })
  }
  return @($paths | Sort-Object -Unique)
}

function Get-Signatures {
  param($Paths)
  return @(@($Paths) | Sort-Object -Unique | ForEach-Object {
    $signature = Get-AuthenticodeSignature -LiteralPath $_
    [ordered]@{
      path = [IO.Path]::GetFullPath($_)
      status = [string]$signature.Status
      statusMessage = $signature.StatusMessage
      signerSubject = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.Subject }
    }
  })
}

function Get-ShortcutEvidence {
  param($Request)
  if (-not (Test-Path -LiteralPath $Request.shortcutPath -PathType Leaf)) {
    return [ordered]@{
      path = $Request.shortcutPath
      exists = $false
      targetPath = $null
      arguments = $null
      workingDirectory = $null
    }
  }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Request.shortcutPath)
  return [ordered]@{
    path = $Request.shortcutPath
    exists = $true
    targetPath = $shortcut.TargetPath
    arguments = $shortcut.Arguments
    workingDirectory = $shortcut.WorkingDirectory
  }
}

function Get-Evidence {
  param($Request)
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  $startupKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
  return [ordered]@{
    ok = $true
    registrations = @(Get-UninstallRegistrations -Request $Request)
    programResidues = @(Get-ProgramResidues -Request $Request)
    processes = @(Get-MatchingProcesses -Request $Request)
    shortcut = Get-ShortcutEvidence -Request $Request
    run = Get-RegistryValueEvidence -KeyPath $runKey -Name $Request.appId -Binary $false
    startupApproved = Get-RegistryValueEvidence -KeyPath $startupKey -Name $Request.appId -Binary $true
    reparsePaths = @(Get-ReparsePaths -Roots $Request.treeRoots)
    signatures = @(Get-Signatures -Paths $Request.signaturePaths)
  }
}

try {
  $requestFile = [IO.Path]::GetFullPath($RequestPath)
  if (-not (Test-Path -LiteralPath $requestFile -PathType Leaf)) { throw "request file is unavailable" }
  $request = Get-Content -LiteralPath $requestFile -Raw | ConvertFrom-Json
  if ($request.action -eq "seed-startup") {
    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $startupKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
    New-Item -Path $runKey -Force | Out-Null
    New-Item -Path $startupKey -Force | Out-Null
    Set-ItemProperty -LiteralPath $runKey -Name $request.appId -Value $request.runValue -Type String
    Set-ItemProperty -LiteralPath $startupKey -Name $request.appId -Value ([Convert]::FromBase64String($request.startupApprovedValueBase64)) -Type Binary
    $result = Get-Evidence -Request $request
  } elseif ($request.action -eq "terminate-installed") {
    $installRoot = [string]$request.installRoot
    if (-not [IO.Path]::IsPathRooted($installRoot) -or $installRoot -match '^[\\/](?![\\/])') { throw "install root is not absolute" }
    $processes = @(Get-MatchingProcesses -Request $request | Where-Object {
      Test-ContainedPath -Root $request.installRoot -Candidate $_.executablePath
    })
    foreach ($process in $processes) {
      $current = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$process.id)"
      if ($null -eq $current) { continue }
      if ($current.ExecutablePath -ne $process.executablePath) { throw "installed process identity changed" }
      if (-not (Test-ContainedPath -Root $request.installRoot -Candidate $current.ExecutablePath)) {
        throw "installed process escaped install root"
      }
      Stop-Process -Id $process.id -Force
    }
    if ($processes.Count -gt 0) { Start-Sleep -Milliseconds ([int]$request.cleanupGraceMs) }
    $remaining = @(Get-MatchingProcesses -Request $request | Where-Object {
      Test-ContainedPath -Root $request.installRoot -Candidate $_.executablePath
    })
    if ($remaining.Count -ne 0) { throw "installed processes remain after termination" }
    $result = [ordered]@{ ok = $true; terminated = $processes }
  } elseif ($request.action -eq "evidence") {
    $result = Get-Evidence -Request $request
  } else {
    throw "unsupported native evidence action"
  }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 8))
} catch {
  $result = [ordered]@{ ok = $false; error = $_.Exception.Message }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 8))
  exit 1
}

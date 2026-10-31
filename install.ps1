[CmdletBinding()]
param([switch]$NoRun, [switch]$NoPathUpdate)
$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    throw 'Stackbite installation requires FullLanguage; contact your administrator about the active PowerShell policy.'
}
$version = '0.5.91'
$commit = '2d94b964c839d24b1968b4dbb725621d49e9b707'
$url = 'https://github.com/Shinick-Han/stackbite/releases/download/v0.5.91/stackbite-0.5.91-windows-x64-2d94b964c839.zip'
$expected = '557726a30ece87ec0f7541a3f05794648ec3b5326ecc6e6a64e4cbfaa0b69331'
$root = 'stackbite-0.5.91-windows-x64-2d94b964c839'
if ($expected -notmatch '^[0-9a-fA-F]{64}$' -or $commit -notmatch '^[0-9a-fA-F]{40}$' -or
    $root -notmatch '^[a-zA-Z0-9._-]+$') { throw 'Invalid bootstrap release identity' }

# An unpredictable, access-restricted directory belongs to this invocation only.
$temp = Join-Path ([IO.Path]::GetTempPath()) ('stackbite-bootstrap-' + [Guid]::NewGuid().ToString('N'))
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
[IO.Directory]::CreateDirectory($temp, $acl) | Out-Null
try {
    $zip = Join-Path $temp 'release.zip'
    Write-Host "Downloading Stackbite $version..."
    $client = New-Object Net.WebClient
    try { $client.DownloadFile($url, $zip) } finally { $client.Dispose() }
    $hash = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($zip)
    try { $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $hash.Dispose() }
    if ($actual -ne $expected) { throw 'Downloaded archive checksum mismatch' }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName
            $parts = $name.Split('/')
            $mode = ($entry.ExternalAttributes -shr 16) -band 0xF000
            $directory = $name.EndsWith('/')
            if ($name.Contains('\') -or $parts[0] -cne $root -or $parts.Count -lt 2 -or
                ($mode -ne 0 -and $mode -ne 0x8000 -and $mode -ne 0x4000) -or
                (($entry.ExternalAttributes -band 0x400) -ne 0) -or
                ($directory -and $mode -eq 0x8000) -or (-not $directory -and $mode -eq 0x4000)) {
                throw "Unsafe archive member: $name"
            }
            for ($i = 0; $i -lt $parts.Count; $i++) {
                $part = $parts[$i]
                if ($directory -and $i -eq $parts.Count - 1 -and $part -eq '') { continue }
                if ($part -eq '' -or $part -eq '.' -or $part -eq '..' -or $part -match '[:*?"<>|\x00-\x1f]' -or
                    $part.EndsWith('.') -or $part.EndsWith(' ') -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') {
                    throw "Unsafe archive member: $name"
                }
            }
            if (-not $seen.Add($name.TrimEnd('/'))) { throw "Duplicate archive member: $name" }
        }
        [IO.Compression.ZipFileExtensions]::ExtractToDirectory($archive, $temp)
    } finally { $archive.Dispose() }
    $bootstrapBundle = Join-Path $temp $root
    $metadata = Get-Content -LiteralPath (Join-Path $bootstrapBundle 'portable.json') -Raw | ConvertFrom-Json
    if ($metadata.version -cne $version -or $metadata.commit -cne $commit) { throw 'Archive release identity mismatch' }
    $installer = Get-Content -LiteralPath (Join-Path $bootstrapBundle 'install.ps1') -Raw
    # The verified frozen installer uses PSScriptRoot once. Supply the verified
    # extraction directory when compiling it as a scriptblock in this process.
    if (([regex]::Matches($installer, '\$PSScriptRoot\b')).Count -ne 1) { throw 'Unexpected installer context' }
    $installer = $installer.Replace('$PSScriptRoot', '$bootstrapBundle')
    Write-Host 'Installing verified release...'
    $installBlock = [ScriptBlock]::Create($installer)
    & $installBlock -AddToPath:(-not $NoPathUpdate)
    if (-not $NoRun -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) {
        $exe = Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA 'Stackbite\app') ($version + '-' + $commit.Substring(0, 12))) 'stackbite.exe'
        & $exe
        if ($LASTEXITCODE -ne 0) { throw "Stackbite exited with code $LASTEXITCODE" }
    }
} finally {
    if ([IO.Directory]::Exists($temp)) { [IO.Directory]::Delete($temp, $true) }
}

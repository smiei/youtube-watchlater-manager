# Packages the Firefox WebExtension into an uploadable .zip file for addons.mozilla.org (AMO)
# Uses forward slashes (/) for subdirectory entries inside the ZIP archive (required by Mozilla AMO Validator).
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$OutDir = Join-Path $PSScriptRoot "dist"
if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir | Out-Null
}

$ZipPath = Join-Path $OutDir "watch-later-playlist-manager-firefox.zip"
if (Test-Path $ZipPath) {
    Remove-Item $ZipPath -Force
}

$FilesToPack = @(
    @{ Source = "manifest.json"; Entry = "manifest.json" },
    @{ Source = "youtube_watch_later_manager.user.js"; Entry = "youtube_watch_later_manager.user.js" },
    @{ Source = "LICENSE"; Entry = "LICENSE" },
    @{ Source = "assets\icon.svg"; Entry = "assets/icon.svg" },
    @{ Source = "_locales\en\messages.json"; Entry = "_locales/en/messages.json" },
    @{ Source = "_locales\de\messages.json"; Entry = "_locales/de/messages.json" }
)

$ZipStream = [System.IO.File]::Open($ZipPath, [System.IO.FileMode]::Create)
try {
    $Archive = New-Object System.IO.Compression.ZipArchive($ZipStream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($item in $FilesToPack) {
            $fullSource = Join-Path $PSScriptRoot $item.Source
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Archive, $fullSource, $item.Entry) | Out-Null
        }
    } finally {
        $Archive.Dispose()
    }
} finally {
    $ZipStream.Dispose()
}

Write-Host "Firefox Add-on successfully packaged: $ZipPath" -ForegroundColor Green

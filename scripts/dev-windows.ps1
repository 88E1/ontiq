# Local Windows dev: dynamically link Microsoft's ONNX Runtime (same as CI).
# Avoids pyke's static ort-sys binaries, which fail to link against MSVC CRT.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$OrtVersion = "1.24.2"
$OrtLib = Join-Path $Root "ort-dist\onnxruntime-win-x64-$OrtVersion\lib"

if (-not (Test-Path (Join-Path $OrtLib "onnxruntime.lib"))) {
    Write-Host "Downloading ONNX Runtime $OrtVersion..."
    $Zip = Join-Path $Root "ort.zip"
    $Url = "https://github.com/microsoft/onnxruntime/releases/download/v$OrtVersion/onnxruntime-win-x64-$OrtVersion.zip"
    Invoke-WebRequest -Uri $Url -OutFile $Zip
    Expand-Archive -Path $Zip -DestinationPath (Join-Path $Root "ort-dist") -Force
    Remove-Item $Zip
}

$env:ORT_LIB_LOCATION = (Resolve-Path $OrtLib).Path
$env:ORT_PREFER_DYNAMIC_LINK = "1"
Write-Host "ORT_LIB_LOCATION=$env:ORT_LIB_LOCATION"
Write-Host "Starting tauri dev..."
bun run tauri dev @args

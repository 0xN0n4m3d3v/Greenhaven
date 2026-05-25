param(
  [string]$VaultRoot = (Resolve-Path "$PSScriptRoot\..\..\..\..").Path
)

$ErrorActionPreference = 'Stop'

$script = Join-Path $PSScriptRoot 'compile_vault_preview.py'
python $script --vault-root $VaultRoot
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

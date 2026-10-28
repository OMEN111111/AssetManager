# 在多个 SketchUp 版本上跑 am_probe.rb，收集各版本 Ruby/API 能力
# 用法：pwsh -File devtest/su/probe-all.ps1 [-Versions 2024,2025]
param([string[]]$Versions = @('2024','2025','2026','2027'))

$ErrorActionPreference = 'Continue'
# -File 传数组时可能变成 "[2022,2023]" 这种字符串，这里拆开
if ($Versions.Count -eq 1 -and $Versions[0] -match '[,\[\]]') {
  $Versions = ($Versions[0] -replace '[\[\]]', '').Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$map = @{
  '2024' = @{ exe = 'D:\Software\PluginMake\SketchUp2024\SketchUp.exe';
              tpl = 'D:\Software\PluginMake\SketchUp2024\resources\en-US\Templates\Temp01a - Simple.skp' }
  '2025' = @{ exe = 'D:\Software\PluginMake\SketchUp2025\SketchUp\SketchUp.exe';
              tpl = 'D:\Software\PluginMake\SketchUp2025\SketchUp\resources\en-US\Templates\Temp01a - Simple.skp' }
  '2026' = @{ exe = 'D:\Software\01_DCC\99_Other\SketchUp2026\SketchUp\SketchUp.exe';
              tpl = 'D:\Software\01_DCC\99_Other\SketchUp2026\SketchUp\resources\en-US\Templates\Temp01a - Simple.skp' }
  '2027' = @{ exe = 'D:\Software\01_DCC\99_Other\SketchUp2027\SketchUp\SketchUp.exe';
              tpl = 'D:\Software\01_DCC\99_Other\SketchUp2027\SketchUp\resources\en-US\Templates\Temp01a - Simple.skp' }
}

$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent   # devtest/su → 仓库根
$probeSrc = Join-Path $PSScriptRoot 'am_probe.rb'
$workDir = Join-Path $env:TEMP 'am-su-test'
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

function Close-Popups([int]$pid_) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $pid_)
  $clicked = @()
  foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
    $all = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($e in $all) {
      if ($e.Current.ControlType.ProgrammaticName -ne 'ControlType.Button') { continue }
      if ($e.Current.Name -in @('否(N)', '确定', '是(Y)', 'OK', '否')) {
        try {
          $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
          $clicked += $e.Current.Name
        } catch { }
      }
    }
  }
  return $clicked
}

foreach ($v in $Versions) {
  if (-not $map.ContainsKey($v)) { Write-Host "[$v] 未知版本，跳过"; continue }
  $info = $map[$v]
  $plugins = Join-Path $env:APPDATA "SketchUp\SketchUp $v\SketchUp\Plugins"
  $json = Join-Path $env:TEMP "am-su-probe-$v.json"

  Write-Host "`n===== SketchUp $v ====="
  Get-Process SketchUp -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  Remove-Item $json -Force -ErrorAction SilentlyContinue

  New-Item -ItemType Directory -Force -Path $plugins | Out-Null
  Copy-Item $probeSrc (Join-Path $plugins 'am_probe.rb') -Force
  # 放一份 main.rb 让探针能检测「现有实现能否解析」
  $mainSrc = Join-Path $repo 'app\bridge\su\2026\assetmanager_su\main.rb'
  if (Test-Path $mainSrc) {
    New-Item -ItemType Directory -Force -Path (Join-Path $plugins 'assetmanager_su') | Out-Null
    Copy-Item $mainSrc (Join-Path $plugins 'assetmanager_su\main.rb') -Force
  }

  # 用临时副本模板，避免「恢复版本比该文件更新」弹窗
  $blank = Join-Path $workDir "blank-$v.skp"
  Copy-Item $info.tpl $blank -Force
  Start-Process -FilePath $info.exe -ArgumentList "`"$blank`""
  Start-Sleep -Seconds 3

  $done = $false
  for ($i = 0; $i -lt 90; $i++) {
    $p = Get-Process SketchUp -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p) { $c = Close-Popups $p.Id; if ($c.Count) { Write-Host "  点了弹窗: $($c -join ',')" } }
    if (Test-Path $json) { $done = $true; break }
    Start-Sleep -Seconds 2
  }

  if ($done) {
    $d = Get-Content $json -Raw | ConvertFrom-Json
    "{0,-6} ruby={1,-8} ver={2,-12} pbr={3,-5} env={4,-5} imagerep={5,-6} setdata={6} htmldlg={7} parse={8}" -f `
      $v, $d.ruby, $d.sketchup_version, $d.'m_metallic_texture=', $d.model_environments, `
      [bool]$d.imagerep_methods, $d.set_data_arity, $d.html_dialog, $d.main_parse
    if ($d.fatal) { Write-Host "  FATAL: $($d.fatal)" }
  } else {
    Write-Host "  !! $v 超时，没拿到探针结果"
  }

  Get-Process SketchUp -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
}

Write-Host "`n探针结果文件在 $env:TEMP\am-su-probe-*.json"

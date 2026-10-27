# 3ds Max 桥接 · 真机联调（GUI 里跑真实任务）
#
# 用途：3dsmaxbatch 拿不到许可、或者你想验证「真实 GUI 会话里」的插件时用这条。
#      它起一个临时服务（默认 8787 —— 插件的默认探测端口）+ 临时素材库，
#      等 GUI Max 里的插件心跳上来，然后发一条 material 任务，看插件回报。
#
# 前置：
#   1) 手动打开目标版本的 3ds Max（插件已在 scripts\startup）
#   2) 本机没有别的 AssetManager 实例占着 8787（脚本会检查）
#
# 用法：
#   pwsh -File devtest\max\live-test.ps1                # 8787
#   pwsh -File devtest\max\live-test.ps1 -Port 8788     # 换端口（插件只默认试 8787，换端口要改 bridge.json）
param(
  [int]$Port = 8787,
  [int]$TimeoutSec = 120,
  [switch]$NoRebuild
)

$ErrorActionPreference = "Stop"
$root = "D:\Program\AssetManager"
$app = Join-Path $root "app"
$work = Join-Path $root "devtest\max\work"
$data = Join-Path $root "devtest\max\.live-data"
$lib = Join-Path $root "devtest\max\.live-lib"

function Say($s, $color = "Gray") { Write-Host $s -ForegroundColor $color }
function Pass($s) { $script:passCount++; Say ("PASS  " + $s) "Green" }
function Fail($s) { $script:failCount++; Say ("FAIL  " + $s) "Yellow" }
$passCount = 0
$failCount = 0

# 0) 端口是否被占
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) { throw "端口 $Port 已被占用（可能是正在运行的 AssetManager）；先关掉它，或换 -Port" }

# 1) 临时素材库：一个材质（.mtlx + 贴图）
Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $work, $data | Out-Null
$matDir = Join-Path $lib "Material\AMB_Live_Mat"
New-Item -ItemType Directory -Force -Path $matDir | Out-Null
@'
<?xml version="1.0"?>
<materialx version="1.38">
  <standard_surface name="AMB_Live" type="surfaceshader"/>
  <surfacematerial name="AMB_Live_mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="AMB_Live"/>
  </surfacematerial>
</materialx>
'@ | Set-Content -Path (Join-Path $matDir "AMB_Live_Mat.mtlx") -Encoding UTF8

Add-Type -AssemblyName System.Drawing
$colors = @{ basecolor = [System.Drawing.Color]::FromArgb(200, 120, 60); rough = [System.Drawing.Color]::Gray; normal = [System.Drawing.Color]::FromArgb(128, 128, 255); metallic = [System.Drawing.Color]::White }
foreach ($k in $colors.Keys) {
  $bmp = New-Object System.Drawing.Bitmap 64, 64
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear($colors[$k])
  $g.Dispose()
  $bmp.Save((Join-Path $matDir "AMB_Live_Mat_$k.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
Say ("临时素材库：" + $matDir)

# 1b) 备份 bridge.json（临时服务会改写它，跑完还原）
$locator = Join-Path $env:LOCALAPPDATA "AssetManager\bridge.json"
$locatorBak = $null
if (Test-Path $locator) { $locatorBak = Get-Content $locator -Raw; Copy-Item $locator "$locator.bak-livetest" -Force }

# 2) 起临时服务
if (-not $NoRebuild) {
  Push-Location $app
  try {
    & node node_modules/esbuild/bin/esbuild src/server/index.ts --bundle --platform=node --format=esm --outfile=build/server.mjs | Out-Null
  } finally { Pop-Location }
}
$env:AM_DATA = $data
$env:PORT = "$Port"
$log = Join-Path $work "live-server.log"
$server = Start-Process -FilePath "node" -ArgumentList "build/server.mjs" -WorkingDirectory $app `
  -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError ($log + ".err")
Say ("临时服务 pid=$($server.Id) port=$Port")

$code = 1
try {
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -TimeoutSec 2; if ($r.appRoot) { $ready = $true; break } } catch { Start-Sleep -Milliseconds 400 }
  }
  if (-not $ready) { throw "服务没起来（看 $log）" }
  Pass "临时服务就绪"

  # 3) 加库 → 等扫描
  $libId = (Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/libraries" -Method Post -Body (@{ root = $lib } | ConvertTo-Json) -ContentType "application/json" -TimeoutSec 20).id
  Say ("库 id=$libId")
  $matAsset = $null
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $list = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/assets?lib=$libId&limit=50" -TimeoutSec 5
    $items = if ($list.items) { $list.items } else { $list.assets }
    $matAsset = $items | Where-Object { $_.type -eq 'material' } | Select-Object -First 1
    if ($matAsset) { break }
  }
  if ($matAsset) { Pass ("扫描到材质素材：" + $matAsset.name + " (id=" + $matAsset.id + ")") } else { Fail "没有扫描到材质素材" }

  if ($matAsset) {
    # 4) 等 GUI Max 的插件心跳（插件默认探测 8787）
    Say "等待 GUI Max 里的插件心跳（最多 $TimeoutSec 秒）…"
    $connected = $false
    $ver = ""
    for ($i = 0; $i -lt $TimeoutSec; $i++) {
      $st = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/bridge/status" -TimeoutSec 5
      if ($st.targets.max.connected) { $connected = $true; $ver = $st.targets.max.version; break }
      Start-Sleep -Seconds 1
    }
    if ($connected) { Pass ("插件已连上（Max 版本 " + $ver + "）") } else { Fail "等不到插件心跳（Max 开着吗？插件在 startup 吗？）" }

    if ($connected) {
      # 5) 发一条真实材质任务
      $send = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/bridge/send" -Method Post `
        -Body (@{ assetId = $matAsset.id; target = 'max'; mode = 'material' } | ConvertTo-Json) `
        -ContentType "application/json" -TimeoutSec 20
      Say ("任务已入队：" + ($send | ConvertTo-Json -Compress))

      $done = $null
      for ($i = 0; $i -lt $TimeoutSec; $i++) {
        Start-Sleep -Seconds 1
        $jobs = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/bridge/jobs?target=max&limit=5" -TimeoutSec 5
        $done = $jobs.jobs | Where-Object { $_.status -eq 'done' -or $_.status -eq 'failed' } | Select-Object -First 1
        if ($done) { break }
      }
      if ($done -and $done.status -eq 'done') {
        Pass ("插件执行成功：" + $done.message)
      } elseif ($done) {
        Fail ("插件执行失败：" + $done.message)
      } else {
        Fail "任务没在 $TimeoutSec 秒内完成（看 Max 的侦听器和 %TEMP%\AssetManager\bridge.log）"
      }
    }
  }
} finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  Start-Sleep -Milliseconds 500
  # 还原 bridge.json
  if ($locatorBak) { Set-Content -Path $locator -Value $locatorBak -NoNewline -Encoding UTF8; Say "bridge.json 已还原" }
  elseif (Test-Path $locator) { Remove-Item $locator -Force; Say "bridge.json 已删除（跑之前就没有）" }
  Say "临时服务已关闭"
}

Say ""
Say ("结果：PASS=" + $passCount + "  FAIL=" + $failCount) $(if ($failCount) { "Yellow" } else { "Green" })
if ($failCount -eq 0 -and $passCount -gt 0) { $code = 0 }
exit $code

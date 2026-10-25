# 真机（GUI Maya 2025）验证：验证 Arnold 相关节点 + 插件自动启动 + HDRI/IES 实跑
#
# 用法：pwsh -File devtest\maya\gui-verify.ps1
#
# 做四件事：
#   1. 重新打包 server.mjs，起临时服务（8790，临时数据目录）
#   2. 把插件装进 %USERPROFILE%\Documents\maya\2025\modules（和软件里点「安装/更新插件到 Maya」等价）
#   3. 用 maya.exe -script 拉起 GUI Maya，跑 devtest\maya\gui_probe.py（探测 Arnold / 菜单 / 跑任务）后自动退出
#   4. 打印探测结果 + 服务端看到的 maya 心跳状态

param(
  [int]$Port = 8790,
  [string]$MayaRoot = "D:\Software\01_DCC\01_Autodesk\Maya2025",
  [int]$WaitMs = 25000,
  [string]$Probe = "gui_probe.py",
  [switch]$NoRebuild
)

$ErrorActionPreference = "Stop"
$root = "D:\Program\AssetManager"
$app = Join-Path $root "app"
$work = Join-Path $root "devtest\maya\work"
$data = Join-Path $root "devtest\maya\.data"
New-Item -ItemType Directory -Force -Path $work, $data | Out-Null

$maya = Join-Path $MayaRoot "bin\maya.exe"
if (-not (Test-Path $maya)) { throw "找不到 maya.exe：$maya" }

$out = Join-Path $work "gui_probe.json"
if ($Probe -ne "gui_probe.py") { $out = Join-Path $work ([System.IO.Path]::GetFileNameWithoutExtension($Probe) + ".json") }
Remove-Item $out -Force -ErrorAction SilentlyContinue

# 测试素材：一个最小的 IES + 一张 EXR（内容不重要，验的是节点/连线）
$ies = Join-Path $work "AMTest_Minimal.ies"
@"
IESNA:LM-63-2002
[TEST] AssetManager minimal
[MANUFAC] AssetManager
TILT=NONE
1 1000 1 3 1 1 2 0.1 0.1 0
1
0 45 90
0
100 80 50
"@ | Set-Content -Path $ies -Encoding ASCII
$exr = Join-Path $work "AMTest_Sky.exr"
if (-not (Test-Path $exr)) { Copy-Item (Join-Path $work "tex\T_BaseColor.png") $exr -ErrorAction SilentlyContinue }

# 1) 重新打包服务端
if (-not $NoRebuild) {
  Push-Location $app
  try {
    & node node_modules/esbuild/bin/esbuild src/server/index.ts --bundle --platform=node --format=esm --outfile=build/server.mjs
    if ($LASTEXITCODE -ne 0) { throw "esbuild 打包失败" }
  } finally { Pop-Location }
}

# 2) 起临时服务
$env:AM_DATA = $data
$env:PORT = "$Port"
$server = Start-Process -FilePath "node" -ArgumentList "build/server.mjs" -WorkingDirectory $app `
  -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $work "server-gui.log") `
  -RedirectStandardError (Join-Path $work "server-gui.err")
Start-Sleep -Seconds 3
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -TimeoutSec 2 | Out-Null; $ready = $true; break }
  catch { Start-Sleep -Milliseconds 300 }
}
if (-not $ready) { if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }; throw "服务没起来" }
Write-Host "[gui] 服务就绪 port=$Port pid=$($server.Id)"

try {
  # 3) 装插件（和软件里点按钮走同一个后端接口）
  $inst = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/bridge/install-maya" -Method Post -ContentType "application/json" -Body "{}"
  Write-Host ("[gui] 插件安装：ok={0} 装到 {1}" -f $inst.ok, (($inst.installed | ForEach-Object { $_.dir }) -join "; "))
  if (-not $inst.ok) { throw "插件安装失败" }

  # 4) 拉 GUI Maya 跑探测脚本（用 MEL 的 python() 执行文件，避免 PowerShell 引号地狱）
  $mel = Join-Path $work "am_gui_probe.mel"
  $py = (Join-Path $root "devtest\maya\$Probe") -replace '\\', '/'
  "python(`"exec(open(r'$py', encoding='utf-8').read())`");" | Set-Content -Path $mel -Encoding ASCII
  $env:AM_GUI_OUT = $out
  $env:AM_GUI_IES = $ies
  $env:AM_GUI_EXR = $exr
  $env:AM_GUI_FBX = (Join-Path $work "lib\Model\AMTest_Box\AMTest_Box.fbx")
  $env:AM_GUI_WAIT_MS = "$WaitMs"

  $log = Join-Path $work "maya_gui.log"
  Write-Host "[gui] 启动 Maya（GUI，约 60 秒）…"
  $proc = Start-Process -FilePath $maya -ArgumentList @("-script", "`"$mel`"") -PassThru `
    -RedirectStandardOutput $log -RedirectStandardError ($log + ".err")
  try {
    Wait-Process -Id $proc.Id -Timeout 300 -ErrorAction Stop
    Write-Host "[gui] Maya 已退出"
  } catch {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Write-Host "[gui] ✘ Maya 超时 300 秒被强制结束（看 $log）" -ForegroundColor Yellow
  }

  # 5) 服务端看到的 maya 心跳
  $st = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/bridge/status"
  $mayaSt = $st.targets.maya
  Write-Host ""
  Write-Host "=== 服务端看到的 Maya 状态 ==="
  $mayaSt | ConvertTo-Json -Depth 4

  if (Test-Path $out) {
    Write-Host ""
    Write-Host "=== GUI 探测结果 ==="
    $j = Get-Content $out -Raw | ConvertFrom-Json
    $j.steps | ForEach-Object {
      $k = $_.PSObject.Properties.Name[0]
      $v = $_.$k
      if ($v -is [System.Management.Automation.PSCustomObject] -or $v -is [array]) {
        Write-Host ("--- {0}:" -f $k)
        ($v | ConvertTo-Json -Depth 6)
      } else {
        Write-Host ("--- {0}: {1}" -f $k, $v)
      }
    }
    if ($j.error) { Write-Host "探测异常：$($j.error)" -ForegroundColor Yellow }
  } else {
    Write-Host "[gui] 没有探测结果文件（Maya 可能没跑起来，看 $log）" -ForegroundColor Yellow
    exit 2
  }
} finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  Write-Host "[gui] 服务已关闭"
}

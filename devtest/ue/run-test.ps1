# UE 桥接插件集成测试：起临时服务 + 临时素材库 + 真机 UE 编辑器跑 test_ue.py
#
# 用法：
#   pwsh -File devtest\ue\run-test.ps1                 # 默认 UE 5.7
#   pwsh -File devtest\ue\run-test.ps1 -Engine 5.6     # 指定引擎版本（5.6 / 5.7 / 5.8）
#   pwsh -File devtest\ue\run-test.ps1 -SkipEditor     # 只跑服务端准备，不开 UE
#
# 说明：
#   - 服务跑在 8790，数据目录在 devtest\ue\.data（临时，不动用户真实库）
#   - 每个引擎版本一个空工程：AMTest56 / AMTest / AMTest58（插件自动拷进它的 Plugins 目录）
#   - 测试结束自动关服务、关编辑器；结果在 devtest\ue\work\test_ue_result.json

param(
  [string]$Engine = "5.7",
  [int]$Port = 8790,
  [switch]$SkipEditor,
  [string]$Project = ""
)

$ErrorActionPreference = "Stop"
$root = "D:\Program\AssetManager"
$work = Join-Path $root "devtest\ue\work"
$data = Join-Path $root "devtest\ue\.data"

$engines = @{
  "5.6" = @{ exe = "D:\Software\03_GameEngine\UE_5.6\Engine\Binaries\Win64\UnrealEditor.exe"; proj = "AMTest56" }
  "5.7" = @{ exe = "D:\Software\03_GameEngine\UE_5.7\Engine\Binaries\Win64\UnrealEditor.exe"; proj = "AMTest" }
  "5.8" = @{ exe = "D:\Software\03_GameEngine\UE_5.8\Engine\Binaries\Win64\UnrealEditor.exe"; proj = "AMTest58" }
}
if (-not $engines.ContainsKey($Engine)) { throw "不支持的引擎版本：$Engine（可选 5.6 / 5.7 / 5.8）" }
$ue = $engines[$Engine].exe
if (-not (Test-Path $ue)) { throw "找不到 UE $Engine 的编辑器：$ue" }
if (-not $Project) {
  $Project = Join-Path $root ("devtest\ue\" + $engines[$Engine].proj + "\" + $engines[$Engine].proj + ".uproject")
}
if (-not (Test-Path $Project)) { throw "找不到测试工程：$Project" }

New-Item -ItemType Directory -Force -Path $work, $data | Out-Null
# 上一次的结果先删掉：编辑器超时被杀时不能把旧结果当成这次通过
Remove-Item (Join-Path $work "test_ue_result.json") -Force -ErrorAction SilentlyContinue

# 1) 同步对应系列插件到测试工程
$src = Join-Path $root ("app\bridge\ue\" + $Engine + "\AssetManagerBridge")
if (-not (Test-Path $src)) { throw "缺少系列目录：$src" }
$dst = Join-Path (Split-Path $Project) "Plugins\AssetManagerBridge"
if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
Copy-Item -Recurse -Force $src $dst
Write-Host "[test] UE $Engine · 插件已同步到 $dst"

# 2) 起临时服务
$env:AM_DATA = $data
$env:PORT = "$Port"
$server = Start-Process -FilePath "node" -ArgumentList "build/server.mjs" -WorkingDirectory (Join-Path $root "app") `
  -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $work "server.log") `
  -RedirectStandardError (Join-Path $work "server.err.log")
Write-Host "[test] 服务已启动 pid=$($server.Id) port=$Port"

try {
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -TimeoutSec 2
      if (($r.appRoot -or $r.app -eq "AssetManager")) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 300 }
  }
  if (-not $ready) { throw "服务没起来（看 devtest\ue\work\server.err.log）" }
  Write-Host "[test] 服务就绪"

  if (-not $SkipEditor) {
    $env:AM_TEST_SCRIPT = (Join-Path $root "app\bridge\ue\tools\test_ue.py") -replace '\\', '/'
    $env:AM_TEST_PORT = "$Port"
    $env:AM_TEST_WORK = $work
    # 无头跑批：关掉「独立材质 / 父材质实例」弹窗（模态框会卡住游戏线程）
    $env:AM_NO_DIALOG = "1"
    $runner = (Join-Path $root 'devtest\ue\runner.py') -replace '\\', '/'
    $log = Join-Path $work ("ue_editor_" + $Engine.Replace('.', '') + ".log")
    # 参数必须拼成一整条字符串：Start-Process 传数组时会把 "-ExecCmds=py D:/..." 里的空格拆开，
    # UE 只会看到 -ExecCmds=py，脚本根本不执行（踩过）。
    $argStr = '"{0}" -ExecCmds="py {1}" -nosplash -stdout -log -NoSound' -f $Project, $runner
    Write-Host "[test] 启动：$ue $argStr"
    # 用 Start-Process + 硬超时：UE 里万一弹出模态框（例如资产撞名），游戏线程会卡住、tick 不再跑，
    # 测试永远结束不了——超时直接杀掉，别让整条流水线挂死。
    $editor = Start-Process -FilePath $ue -ArgumentList $argStr -PassThru `
      -RedirectStandardOutput $log -RedirectStandardError ($log + ".err")
    $timeoutSec = 900
    try {
      Wait-Process -Id $editor.Id -Timeout $timeoutSec -ErrorAction Stop
      Write-Host "[test] 编辑器退出（$([int]((Get-Date) - $editor.StartTime).TotalSeconds)s），日志：$log"
    } catch {
      Stop-Process -Id $editor.Id -Force -ErrorAction SilentlyContinue
      Write-Host "[test] ✘ 编辑器超时 $timeoutSec 秒被强制结束（多半是弹了模态框卡住）日志：$log" -ForegroundColor Yellow
    }
  }
}
finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  Write-Host "[test] 服务已关闭"
}

$res = Join-Path $work "test_ue_result.json"
if (Test-Path $res) {
  $j = Get-Content $res -Raw | ConvertFrom-Json
  Write-Host ""
  Write-Host "================ UE 桥接测试（UE $Engine）================"
  Write-Host ("插件 {0} · 引擎 {1}" -f $j.plugin, $j.engine)
  Write-Host ("通过 {0} 项，失败 {1} 项" -f $j.ok.Count, $j.fails.Count)
  if ($j.fails.Count) { Write-Host ("失败： " + ($j.fails -join " / ")) }
  Write-Host "========================================================"
  exit ($(if ($j.fails.Count) { 1 } else { 0 }))
} else {
  Write-Host "[test] 没有结果文件：编辑器可能没跑起来（看 $work\ue_editor_*.log）"
  exit 2
}


/*
================================================================================
 AssetManager · 3ds Max 桥接插件
 版本：0.2.1        协议：1        目标：3ds Max 2018+（2026 / 2027 实测）
--------------------------------------------------------------------------------
 作用：
   1. 常驻轮询器：从 AssetManager 本地服务取任务，导入模型 / 创建材质 / 发送贴图，
      并把结果回报给 AssetManager；
   2. 专属工具栏（宏脚本 AssetManagerToolbar / 命令 AssetManagerBridge_Toolbar()）：
      把场景里的对象回写到素材源目录（覆盖 / 另存副本）或打包到新位置；
      也可以接收从 AssetManager 拖过来的素材（拖进工具栏的接收区即可）。


 安装：
   把本文件复制到 3ds Max 的 startup 目录，例如
     %LOCALAPPDATA%\Autodesk\3dsMax\2026 - 64bit\CHS\scripts\startup\
   重启 Max 即可（AssetManager 的「插件」面板可以一键安装）。
   也可以手动执行：  fileIn @"...\AssetManagerBridge.ms"

 需要手动控制的命令：
   AssetManagerBridge_Start()    启动轮询
   AssetManagerBridge_Stop()     停止轮询
   AssetManagerBridge_Poll()     立刻轮询一次（batch / 调试用）
   AssetManagerBridge_Status()   弹窗显示连接状态、端口、队列
   AssetManagerBridge_Heartbeat()立刻发一次心跳

 设计要点：
   - 只访问 127.0.0.1，端口从 %LOCALAPPDATA%\AssetManager\bridge.json 读取，
     读不到时扫描 8787-8799；
   - JSON 用自带的极小解析器（Max 的 .NET 里没有 System.Web.Extensions）；
   - 导入/建材质期间 AMB_BUSY = true，避免 timer 重入；
   - 所有动作只处理固定字段，不执行任何来自队列的代码。
================================================================================
*/


global AMB_SCRIPT_VERSION = "0.2.1"
global AMB_PROTOCOL = 1
global AMB_LOADED = undefined
global AMB_PORT = 0
global AMB_TIMER = undefined
global AMB_TICKS = 0
global AMB_BUSY = false
global AMB_ENABLED = false
global AMB_LAST_ERROR = ""
global AMB_LAST_JOB = ""
global AMB_LAST_RESULT = ""
global AMB_REQUEST_COUNT = 0
global AMB_AUTOSTART = true
global AMB_VERSION = ""
global AMB_NEXT_SCAN = 0
global AMB_TOOLBAR = undefined
global AMB_LAST_EXPORT = ""
global AMB_CURRENT_ASSET = undefined
-- 本次会话的资产注册表：每项 #(uuid, 名称, 源目录, 模型文件)；重启 Max 清空
global AMB_ASSET_REG = #()
global AMB_PENDING_IMPORT = undefined
global AMB_PENDING_SPEC = undefined
global AMB_PENDING_MODE = "editor"
global AMB_PLACE_POINT = undefined
global AMB_DROP_AUTOMAT = true
global AMB_TOOLBAR_AUTO = false
global AMB_PACK_PARENT = ""
global AMB_PACK_MAT = false
global AMB_PACK_MAPS = false

/* ------------------------------------------------------------------------
   MAXScript 不支持前向引用：函数必须在“定义之前”声明为全局，
   否则函数体里调用后面才定义的函数会报 “调用需要函数或类，得到的是: undefined”。
   另外注意：标识符不区分大小写，AMB_XXX 变量和 amb_xxx 函数不能同名。
   ------------------------------------------------------------------------ */
global amb_err, amb_join, amb_esc, amb_json_val
global amb_peek, amb_skip_ws, amb_parse_string, amb_parse_number
global amb_parse_array, amb_parse_object, amb_parse_value, amb_parse
global amb_jget, amb_jgets
global amb_request, amb_http_get, amb_http_post
global amb_localappdata, amb_config_port, amb_probe_port, amb_ensure_port, amb_url
global amb_heartbeat, amb_report, amb_max_version
global amb_bitmap_for, amb_uv_tiling, amb_build_material, amb_slot_empty, amb_free_slot
global amb_push_to_editor
global amb_info_from_payload, amb_do_import, amb_do_material, amb_exec_job, amb_process
global amb_poll_once, amb_tick, amb_has_ui
global amb_post_json, amb_resolve_file, amb_current_source, amb_sanitize_name
global amb_is_dir, amb_log, amb_ellipsis
global amb_pick_objects, amb_export_fbx, amb_bitmaps_of, amb_copy_maps, amb_map_file, amb_write_slots
global amb_pack_to, amb_export_pack, amb_pack_do
global amb_templates, amb_try_set_map, amb_try_set_val, amb_build_with_template, amb_choose_template
global amb_cursor_ground, amb_move_to_point, amb_move_to_center, amb_begin_import, amb_import_now
global amb_roots_of, amb_world_bounds, amb_shift_world
global amb_drop_material
global amb_asset_info, amb_info_direct, amb_drop_asset
global amb_obj_uuid, amb_obj_prop, amb_nodes_deep, amb_tag_asset, amb_reg_put, amb_reg_get, amb_asset_of_obj
global amb_collect_uuid, amb_export_any, amb_export_back, amb_maps_target, amb_notify_exported
global amb_toolbar_refresh, amb_toolbar_show, amb_toolbar_toggle, amb_install_menu
global AssetManagerBridge_Toolbar
global ambToolbar, ambTemplateDlg, ambImportDlg, ambPackDlg
/* ------------------------------------------------------------------ 工具 */

fn amb_err = (
  local e = undefined
  try (e = getCurrentException()) catch ()
  local m = ""
  if e != undefined do (
    try (m = e.Message as string) catch (try (m = e as string) catch ())
  )
  if m == "undefined" do m = ""
  m
)

fn amb_join arr sep = (
  local out = ""
  for i = 1 to arr.count do (
    out += arr[i] as string
    if i < arr.count do out += sep
  )
  out
)

fn amb_esc s = (
  local t = s as string
  t = substituteString t "\\" "\\\\"
  t = substituteString t "\"" "\\\""
  t = substituteString t "\r" "\\r"
  t = substituteString t "\n" "\\n"
  t = substituteString t "\t" "\\t"
  t
)

fn amb_json_val v = (
  if v == undefined then "null"
  else (
    local c = classof v
    if c == BooleanClass then (if v then "true" else "false")
    else if c == Integer or c == Float then (v as string)
    else ("\"" + (amb_esc (v as string)) + "\"")
  )
)

/* ------------------------------------------------------------- JSON 解析 */
/* 对象 -> #(#(键, 值), ...)；数组 -> #(值, ...)；null -> undefined */

fn amb_peek s p = (
  if p[1] > s.count then "" else (substring s p[1] 1)
)

fn amb_skip_ws s p = (
  local go = true
  while go do (
    if p[1] > s.count then go = false
    else (
      local c = substring s p[1] 1
      if c == " " or c == "\t" or c == "\r" or c == "\n" then (p[1] += 1) else go = false
    )
  )
  p[1]
)

fn amb_parse_string s p = (
  p[1] += 1
  local out = ""
  local go = true
  while go do (
    if p[1] > s.count then go = false
    else (
      local c = substring s p[1] 1
      if c == "\"" then (
        p[1] += 1
        go = false
      ) else if c == "\\" then (
        local e = substring s (p[1] + 1) 1
        p[1] += 2
        if e == "\"" then out += "\""
        else if e == "\\" then out += "\\"
        else if e == "/" then out += "/"
        else if e == "n" then out += "\n"
        else if e == "r" then out += "\r"
        else if e == "t" then out += "\t"
        else if e == "b" then out += "\b"
        else if e == "f" then out += "\f"
        else if e == "u" then (
          local hex = substring s p[1] 4
          p[1] += 4
          local code = 0
          for i = 1 to 4 do (
            local h = substring hex i 1
            local v = 0
            local hc = h[1]
            if hc >= "0" and hc <= "9" then v = (hc as integer) - 48
            else if hc >= "a" and hc <= "f" then v = (hc as integer) - 87
            else if hc >= "A" and hc <= "F" then v = (hc as integer) - 55
            code = code * 16 + v
          )
          -- 服务器只对控制字符做 \u 转义；中文路径是 UTF-8 原文
          if code > 0 and code < 128 then out += (bit.intAsChar code) else out += "?"
        )
        else out += e
      ) else (
        out += c
        p[1] += 1
      )
    )
  )
  out
)

fn amb_parse_number s p = (
  local start = p[1]
  local go = true
  while go do (
    if p[1] > s.count then go = false
    else (
      local c = substring s p[1] 1
      local isNum = (c >= "0" and c <= "9") or c == "-" or c == "+" or c == "." or c == "e" or c == "E"
      if isNum then (p[1] += 1) else go = false
    )
  )
  local txt = substring s start (p[1] - start)
  local n = 0
  try (n = txt as number) catch (n = 0)
  n
)

fn amb_parse_array s p = (
  local out = #()
  p[1] += 1
  amb_skip_ws s p
  if (amb_peek s p) == "]" then (
    p[1] += 1
  ) else (
    local go = true
    while go do (
      local v = amb_parse_value s p
      append out v
      amb_skip_ws s p
      local c = amb_peek s p
      if c == "," then (p[1] += 1)
      else (
        if c == "]" do p[1] += 1
        go = false
      )
    )
  )
  out
)

fn amb_parse_object s p = (
  local out = #()
  p[1] += 1
  amb_skip_ws s p
  if (amb_peek s p) == "}" then (
    p[1] += 1
  ) else (
    local go = true
    while go do (
      amb_skip_ws s p
      local k = ""
      if (amb_peek s p) == "\"" then (
        k = amb_parse_string s p
        amb_skip_ws s p
        if (amb_peek s p) == ":" do p[1] += 1
        local v = amb_parse_value s p
        append out #(k, v)
        amb_skip_ws s p
        local c = amb_peek s p
        if c == "," then (p[1] += 1)
        else (
          if c == "}" do p[1] += 1
          go = false
        )
      ) else (
        go = false
      )
    )
  )
  out
)

fn amb_parse_value s p = (
  amb_skip_ws s p
  local c = amb_peek s p
  if c == "{" then amb_parse_object s p
  else if c == "[" then amb_parse_array s p
  else if c == "\"" then amb_parse_string s p
  else if c == "t" then (
    if (substring s p[1] 4) == "true" then (p[1] += 4; true) else (p[1] += 1; undefined)
  )
  else if c == "f" then (
    if (substring s p[1] 5) == "false" then (p[1] += 5; false) else (p[1] += 1; undefined)
  )
  else if c == "n" then (p[1] += 4; undefined)
  else if c == "" then undefined
  else amb_parse_number s p
)

fn amb_parse txt = (
  if txt == undefined do return undefined
  local s = txt as string
  if s == "" do return undefined
  local p = #(1)
  amb_parse_value s p
)

fn amb_jget obj key = (
  local hit = undefined
  if obj != undefined and classof obj == Array do (
    for pair in obj while hit == undefined do (
      if classof pair == Array and pair.count == 2 and pair[1] == key do hit = pair[2]
    )
  )
  hit
)

fn amb_jgets obj key = (
  local v = amb_jget obj key
  if v == undefined then "" else (v as string)
)

/* ---------------------------------------------------------------- HTTP */
/* 用 HttpWebRequest 而不是 WebClient：WebClient 连不上时会把 Max 主线程卡 2 秒，
   13 个端口一扫描就是 26 秒。这里给每次请求设硬超时。 */

fn amb_request url method bodyText timeoutMs = (
  AMB_REQUEST_COUNT += 1
  local out = #(false, "")
  try (
    local req = (dotNetClass "System.Net.WebRequest").Create url
    req.Method = method
    req.Timeout = timeoutMs
    req.ReadWriteTimeout = timeoutMs + 700
    try (req.KeepAlive = false) catch ()
    -- 不走系统代理（本机回环，代理会让请求变慢甚至失败）
    try (req.Proxy = (dotNetObject "System.Net.WebProxy")) catch ()
    try (req.UserAgent = ("AssetManager-MaxBridge/" + AMB_SCRIPT_VERSION)) catch ()
    if method == "POST" do (
      req.ContentType = "application/json"
      -- 注意：GetBytes 返回的 byte[] 在 MAXScript 里是普通数组，.Length 不存在，要用 .count
      local bytes = (dotNetClass "System.Text.Encoding").UTF8.GetBytes bodyText
      req.ContentLength = bytes.count
      local st = req.GetRequestStream()
      st.Write bytes 0 bytes.count
      st.Close()
    )
    local resp = req.GetResponse()
    local sr = dotNetObject "System.IO.StreamReader" (resp.GetResponseStream())
    local txt = sr.ReadToEnd()
    sr.Close()
    try (resp.Close()) catch ()
    out = #(true, txt)
  ) catch (
    out = #(false, amb_err())
  )
  out
)

fn amb_http_get url = (
  amb_request url "GET" "" 1500
)

fn amb_http_post url body = (
  amb_request url "POST" body 4000
)

/* ------------------------------------------------------------ 端口发现 */

fn amb_localappdata = (
  -- MAXScript 没有 sysInfo.getEnvVariable，用 .NET 读环境变量
  local v = ""
  try (v = (dotNetClass "System.Environment").GetEnvironmentVariable "LOCALAPPDATA") catch ()
  if v == undefined or v == "" do (
    local up = ""
    try (up = (dotNetClass "System.Environment").GetEnvironmentVariable "USERPROFILE") catch ()
    v = (up as string) + "\\AppData\\Local"
  )
  v as string
)

fn amb_config_port = (
  local f = (amb_localappdata()) + "\\AssetManager\\bridge.json"
  if not (doesFileExist f) do return 0
  local txt = ""
  try (txt = (dotNetClass "System.IO.File").ReadAllText f) catch (return 0)
  local j = try (amb_parse txt) catch undefined
  local port = amb_jget j "port"
  if port == undefined then 0 else (port as integer)
)

fn amb_probe_port port = (
  if port == undefined or port <= 0 do return false
  local r = amb_request ("http://127.0.0.1:" + (port as string) + "/api/bridge/status") "GET" "" 300
  if not r[1] do return false
  (matchPattern (r[2] as string) pattern:"*AssetManager*")
)

fn amb_ensure_port = (
  if AMB_PORT > 0 and (amb_probe_port AMB_PORT) do return true
  local p = amb_config_port()
  if p > 0 and (amb_probe_port p) do (
    AMB_PORT = p
    return true
  )
  if (amb_probe_port 8787) do (
    AMB_PORT = 8787
    return true
  )
  AMB_PORT = 0
  false
)

fn amb_url path = (
  "http://127.0.0.1:" + (AMB_PORT as string) + path
)

/* -------------------------------------------------------------- 心跳/回报 */

fn amb_max_version = (
  -- maxVersion() = #(28000, 68, 0, 28, 3, 0, 30732, 2026, ".3")
  local build = 0
  local yr = 2000
  try (
    local mv = maxVersion()
    build = mv[1] as integer
    if mv.count >= 8 do yr = mv[8] as integer
    if yr < 2000 do yr = 2000 + (build / 1000) - 2
  ) catch ()
  #(yr, build)
)

fn amb_heartbeat = (
  if not (amb_ensure_port()) do return false
  local ver = amb_max_version()
  local body = "{\"version\":\"" + (ver[1] as string) + "\",\"host\":\"" \
    + (amb_esc (sysInfo.computername)) + "\",\"protocol\":" + (AMB_PROTOCOL as string) \
    + ",\"script\":\"" + AMB_SCRIPT_VERSION + "\",\"build\":" + (ver[2] as string) \
    + ",\"busy\":" + (if AMB_BUSY then "true" else "false") + "}"
  local r = amb_http_post (amb_url "/api/bridge/max/heartbeat") body
  if r[1] do AMB_VERSION = ver[1] as string
  r[1]
)

fn amb_report id ok msg detail = (
  if not (amb_ensure_port()) do return false
  local body = "{\"id\":" + (id as string) + ",\"ok\":" + (if ok then "true" else "false") \
    + ",\"message\":\"" + (amb_esc msg) + "\""
  if detail != undefined do (
    body += ",\"detail\":" + (amb_json_val detail)
  )
  body += "}"
  local r = amb_http_post (amb_url "/api/bridge/max/result") body
  if r[1] then (
    AMB_LAST_RESULT = (if ok then "成功：" else "失败：") + msg
    true
  ) else false
)

/* ------------------------------------------------------------ 材质构建 */

fn amb_bitmap_for path chan flipGreen = (
  if path == undefined or path == "" do return undefined
  if not (doesFileExist path) do return undefined
  local bt = undefined
  try (bt = bitmaptexture fileName:path) catch (return undefined)
  try (
    if chan == "r" then bt.monoOutput = 2
    else if chan == "g" then bt.monoOutput = 3
    else if chan == "b" then bt.monoOutput = 4
    else if chan == "a" then bt.monoOutput = 1
    else bt.monoOutput = 0
  ) catch ()
  bt
)

fn amb_uv_tiling bt spec = (
  if bt == undefined or spec == undefined do return false
  local uv = amb_jget spec "uv"
  if uv == undefined do return false
  local ru = amb_jget uv "repeatU"
  local rv = amb_jget uv "repeatV"
  if ru == undefined or ru == 0 do ru = 1
  if rv == undefined or rv == 0 do rv = 1
  if ru == 1 and rv == 1 do return false
  local ok = false
  try (
    bt.coords.U_Tiling = ru
    bt.coords.V_Tiling = rv
    ok = true
  ) catch (
    try (
      bt.coords.u_Tiling = ru
      bt.coords.v_Tiling = rv
      ok = true
    ) catch ()
  )
  ok
)

fn amb_build_material spec = (
  if spec == undefined do return undefined
  local name = amb_jgets spec "name"
  if name == "" do name = "AssetManager_Material"
  local m = PhysicalMaterial name:name
  local maps = amb_jget spec "maps"
  local applied = 0
  local ignored = #()
  local normalBump = undefined

  if maps != undefined do (
    for pair in maps do (
      local key = pair[1]
      local e = pair[2]
      local p = amb_jget e "path"
      local chan = amb_jgets e "channel"
      if chan == "" do chan = "rgb"
      local isDx = (amb_jgets e "normalSpace" == "dx")
      local bt = amb_bitmap_for p chan isDx
      if bt == undefined then (
        append ignored (key as string + "（文件缺失）")
      ) else (
        amb_uv_tiling bt spec
        local ok = false
        if key == "baseColor" then (try (m.base_color_map = bt; ok = true) catch ())
        else if key == "roughness" then (try (m.roughness_map = bt; ok = true) catch ())
        else if key == "metallic" then (try (m.metalness_map = bt; ok = true) catch ())
        else if key == "emissive" then (
          try (
            m.emit_color_map = bt
            m.emit_luminance = 1.0
            ok = true
          ) catch ()
        )
        else if key == "opacity" then (try (m.transparency_map = bt; ok = true) catch ())
        else if key == "normal" then (
          local nb = undefined
          try (nb = Normal_Bump()) catch (nb = undefined)
          if nb != undefined do (
            try (
              nb.normal_map = bt
              nb.map1on = true
              nb.method = 1
              if isDx do nb.flipgreen = true
              normalBump = nb
              ok = true
            ) catch ()
          )
        )
        else if key == "height" then (
          -- 高度图优先接置换通道；没有置换槽再退回凹凸
          ok = (try (m.displacement_map = bt; true) catch (false))
          if ok do (try (m.displacement_map_on = true) catch ())
          if not ok and normalBump == undefined do (
            local nb = undefined
            try (nb = Normal_Bump()) catch (nb = undefined)
            if nb != undefined do (
              try (
                nb.bump_map = bt
                nb.map2on = true
                nb.method = 2
                normalBump = nb
                ok = true
              ) catch ()
            )
          )
        )
        else if key == "ao" then (
          -- PhysicalMaterial 没有独立 AO 槽；AO 单独成图时忽略并说明
          append ignored "ao（Physical Material 无专用 AO 通道）"
        )
        else append ignored (key as string + "（未支持的通道）")
        if ok do applied += 1
      )
    )
  )
  if normalBump != undefined do (
    try (m.bump_map = normalBump) catch ()
  )
  #(m, applied, ignored)
)

/** 找一个空材质球（1..24）；全满就用 1 */
/** 空材质球判断：Max 2026 的空槽是 OpenPBR_Material，名字形如 “01 - Default” */
fn amb_slot_empty m = (
  local empty = true
  if m != undefined do (
    local nm = ""
    try (nm = m.name as string) catch (nm = "")
    empty = (matchPattern nm pattern:"* - Default") or (matchPattern nm pattern:"Material #*")
  )
  empty
)

/** 找空材质球（1..24）；全满就用当前激活槽，避免永远覆盖第一个 */
fn amb_free_slot = (
  local idx = 0
  for i = 1 to 24 while idx == 0 do (
    local m = undefined
    try (m = meditMaterials[i]) catch (m = undefined)
    if (amb_slot_empty m) do idx = i
  )
  if idx == 0 do (
    local act = 0
    try (act = medit.GetActiveMtlSlot()) catch (act = 0)
    if act < 1 or act > 24 do act = 1
    idx = act
  )
  idx
)

/** 放进精简材质编辑器：占空槽，不覆盖已有的 */
fn amb_push_to_editor m = (
  local slot = amb_free_slot()
  local ok = false
  try (medit.PutMtlToMtlEditor m slot; ok = true) catch ()
  if not ok do (
    try (meditMaterials[slot] = m; ok = true) catch ()
  )
  amb_log ("push to editor slot=" + (slot as string) + " ok=" + (ok as string))
  ok
)

/* --------------------------------------------------------------- 任务 */

/** 把任务载荷整理成「当前素材」，工具栏据此显示源目录 / 回写目标 */
fn amb_info_from_payload payload kind spec = (
  local info = #()
  local idv = amb_jget payload "assetId"
  if idv != undefined do append info #("assetId", idv)
  append info #("name", amb_jgets payload "name")
  append info #("type", kind)
  local src = amb_jgets payload "sourceDir"
  if src != "" do append info #("sourceDir", src)
  local mp = amb_jgets payload "modelPath"
  if mp != "" do append info #("modelPath", mp)
  local uv = amb_jgets payload "uuid"
  if uv != "" do append info #("uuid", uv)
  if spec != undefined do append info #("material", spec)
  AMB_CURRENT_ASSET = info
  try (amb_toolbar_refresh()) catch ()
  info
)

fn amb_do_import payload = (
  local mp = amb_jgets payload "modelPath"
  if mp == "" do return #(false, "任务缺少模型路径", undefined)
  if not (doesFileExist mp) do return #(false, "模型文件不存在：" + mp, undefined)

  local before = for o in objects collect o
  local ok = true
  local err = ""
  -- 同名对象也要新建一份：默认 Max 会把重名节点合并进已有对象，第二次发送时会“创建 0 个对象”
  local ext = toLower (getFilenameType mp)
  try (if ext == ".fbx" do FBXImporterSetParam "Mode" #create) catch ()
  try (importFile mp #noPrompt) catch (ok = false; err = amb_err())
  if not ok do return #(false, "导入失败：" + err, undefined)

  local created = for o in objects where (findItem before o == 0) collect o
  local uuid = amb_jgets payload "uuid"
  if uuid != "" and created.count > 0 do (
    amb_reg_put uuid #(uuid, amb_jgets payload "name", amb_jgets payload "sourceDir", amb_jgets payload "modelPath")
    local nTag = amb_tag_asset created uuid (amb_jgets payload "name") (amb_jgets payload "sourceDir") (amb_jgets payload "modelPath")
    amb_log ("uuid tag (queue) " + uuid + " objects=" + (nTag as string))
  )
  local applied = 0
  local matMsg = ""
  local spec = amb_jget payload "material"
  if created.count > 0 and spec != undefined do (
    local built = amb_build_material spec
    if built != undefined do (
      local m = built[1]
      for o in created do (
        local empty = false
        try (
          empty = (o.material == undefined) or (classof o.material == StandardMaterial and o.material.diffuseMap == undefined)
        ) catch (empty = false)
        if empty do (
          try (o.material = m; applied += 1) catch ()
        )
      )
      if applied > 0 do matMsg = "，贴图材质 " + (applied as string) + " 个"
    )
  )
  if created.count > 0 do (
    try (clearSelection(); select created) catch ()
    try (max zoomext sel all) catch ()
  )
  local msg = ""
  if created.count > 0 then msg = "已导入 " + (created.count as string) + " 个对象" + matMsg
  else msg = "已导入模型，但场景里已有同名对象（Max 合并了节点）"
  local inf = amb_info_from_payload payload "model" spec
  local detail = "{\"objects\":" + (created.count as string) + ",\"materialApplied\":" + (applied as string) + "}"
  #(true, msg, detail)
)

fn amb_do_material payload = (
  local built = amb_build_material payload
  if built == undefined do return #(false, "材质构建失败", undefined)
  local m = built[1]
  local applied = built[2]
  local ignored = built[3]
  local name = amb_jgets payload "name"

  local selCount = selection.count
  local assigned = 0
  if selCount > 0 do (
    for o in (selection as array) do (
      try (o.material = m; assigned += 1) catch ()
    )
  )
  local pushed = false
  if assigned == 0 do pushed = amb_push_to_editor m

  local msg = ""
  if assigned > 0 then msg = "已创建材质「" + name + "」并赋给 " + (assigned as string) + " 个选中对象"
  else if pushed then msg = "已创建材质「" + name + "」并放入材质编辑器（未选中对象）"
  else msg = "已创建材质「" + name + "」，但没有选中对象，也没能放入材质编辑器"

  if ignored.count > 0 do msg += "；忽略：" + (amb_join ignored "、")
  amb_info_from_payload payload "material" payload
  local detail = "{\"maps\":" + (applied as string) + ",\"assigned\":" + (assigned as string) \
    + ",\"toEditor\":" + (if pushed then "true" else "false") + "}"
  #(true, msg, detail)
)


fn amb_do_hdri payload = (
  local files = amb_jget payload "files"
  if files == undefined or files.count == 0 do return #(false, "载荷里没有 HDRI 文件", undefined)
  local path = files[1] as string
  if not (doesFileExist path) do return #(false, "HDRI 文件不存在：" + path, undefined)
  local apply = amb_jget payload "hdriApply"
  local useEnv = true
  local useVp = true
  if apply != undefined do (
    local e = amb_jget apply "env"
    local v = amb_jget apply "viewport"
    if e != undefined do useEnv = (e == true or e == 1 or e == "true")
    if v != undefined do useVp = (v == true or v == 1 or v == "true")
  )
  local msgs = ""
  local okAny = false
  -- 3ds Max 2026 没有 sceneEnvironment，环境贴图是全局 environmentMap / useEnvironmentMap
  if useEnv do (
    try (
      local bm = Bitmaptexture()
      bm.filename = path
      bm.name = filenameFromPath path
      environmentMap = bm
      useEnvironmentMap = true
      local ok = (environmentMap != undefined)
      msgs += (if ok then "环境贴图已设置；" else "环境贴图未生效；")
      okAny = ok
    ) catch ( msgs += ("环境贴图失败：" + (getCurrentException()) + "；") )
  )
  if useVp do (
    try (
      backgroundImageFileName = path
      -- 视口显示背景（Max 2026：DispBkgImage 而不是 viewport.setShowBackground）
      try (DispBkgImage = true) catch ()
      try (viewport.DispBkgImage = true) catch ()
      completeRedraw()
      redrawViews()
      msgs += "视口背景已设置；"
      okAny = true
    ) catch ( msgs += ("视口背景失败：" + (getCurrentException()) + "；") )
  )
  #(okAny, msgs, undefined)
)

fn amb_exec_job job = (
  local mode = amb_jgets job "mode"
  local payload = amb_jget job "payload"
  if payload == undefined do return #(false, "任务缺少载荷", undefined)
  if mode == "import" then amb_do_import payload
  else if mode == "material" then amb_do_material payload
  else if mode == "texture" then "贴图导入已移除（只支持模型与材质/HDRI）"
  else if mode == "hdri" then amb_do_hdri payload
  else #(false, "未知任务类型：" + mode, undefined)
)

fn amb_process job = (
  local id = amb_jget job "id"
  if id == undefined do return false
  id = id as integer
  local title = amb_jgets job "title"
  AMB_LAST_JOB = title
  local res = undefined
  try (
    res = amb_exec_job job
  ) catch (
    res = #(false, "插件执行异常：" + (amb_err()), undefined)
  )
  if res == undefined do res = #(false, "插件执行异常", undefined)
  amb_report id res[1] res[2] res[3]
  true
)

/* ---------------------------------------------------------------- 轮询 */

fn amb_poll_once = (
  if (AMB_BUSY) do return false
  -- 离线时不要每 700ms 去探端口（连不上要花几百毫秒），8 秒试一次
  if AMB_PORT <= 0 do (
    if AMB_NEXT_SCAN > 0 and (timestamp() < AMB_NEXT_SCAN) do return false
    AMB_NEXT_SCAN = timestamp() + 8000
  )
  if not (amb_ensure_port()) do return false
  AMB_NEXT_SCAN = 0
  AMB_TICKS += 1
  if (mod AMB_TICKS 3) == 0 do amb_heartbeat()

  local r = amb_http_get (amb_url "/api/bridge/max/next")
  if not r[1] do return false
  local txt = r[2] as string
  if txt == "" do return false

  local job = undefined
  try (job = amb_parse txt) catch (
    AMB_LAST_ERROR = "JSON 解析失败：" + (amb_err())
    return false
  )
  if job == undefined do return false

  AMB_BUSY = true
  try (amb_process job) catch (
    AMB_LAST_ERROR = amb_err()
    AMB_BUSY = false
  )
  AMB_BUSY = false
  true
)

fn amb_tick = (
  if not (AMB_ENABLED) do return false
  try (amb_poll_once()) catch (AMB_LAST_ERROR = amb_err())
  true
)

/* =======================================================================
   v0.3.0：素材解析 / 回写 / 打包 / 拖放 / 工具栏
   ======================================================================= */

/** batch（无界面）里不要弹任何对话框：3dsmaxbatch 的 MAX 窗口只有两三百像素 */
fn amb_has_ui = (
  local ok = true
  try (
    local s = getMAXWindowSize()
    if (s.x < 400) or (s.y < 300) do ok = false
  ) catch (ok = true)
  -- 工具栏能开出来就说明有界面
  if AMB_TOOLBAR != undefined do (
    try (if (AMB_TOOLBAR.open == true) do ok = true) catch ()
  )
  ok
)

fn amb_post_json url body = (
  local r = amb_http_post url body
  if not r[1] do return undefined
  local txt = r[2] as string
  if txt == "" do return undefined
  try (amb_parse txt) catch undefined
)

fn amb_resolve_file p = (
  if not (amb_ensure_port()) do return undefined
  amb_post_json (amb_url "/api/bridge/resolve") ("{\"path\":\"" + (amb_esc p) + "\"}")
)

/** 服务端记的「最近一次从 AssetManager 拖出」的素材（2 分钟内有效） */
fn amb_current_source = (
  amb_jgets AMB_CURRENT_ASSET "sourceDir"
)


fn amb_sanitize_name n = (
  local s = n as string
  s = substituteString s "\\" "_"
  s = substituteString s "/" "_"
  s = substituteString s ":" "_"
  s = substituteString s "*" "_"
  s = substituteString s "?" "_"
  s = substituteString s "\"" "_"
  s = substituteString s "<" "_"
  s = substituteString s ">" "_"
  s = substituteString s "|" "_"
  if s == "" do s = "Asset"
  s
)

/* ------------------------------------------------------------ 简单输入框 */

/* ------------------------------------------------------------ 打包导出 */

fn amb_pick_objects = (
  local sel = selection as array
  if sel.count == 0 do (
    sel = for o in objects where (superClassOf o == GeometryClass) collect o
  )
  sel
)

fn amb_export_fbx file objs withMat = (
  local ok = true
  local err = ""
  try (
    clearSelection()
    if objs.count > 0 do select objs
    try (FBXExporterSetParam "EmbedTextures" false) catch ()
    try (FBXExporterSetParam "Animation" false) catch ()
    try (FBXExporterSetParam "Materials" (if withMat then true else false)) catch ()
    exportFile file #noPrompt selectedOnly:true using:FBXEXP
  ) catch (ok = false; err = amb_err())
  if ok and not (doesFileExist file) do (
    ok = false
    err = "导出命令没有生成文件"
  )
  amb_log ("fbx export " + file + " ok=" + (ok as string) + " " + err)
  #(ok, err)
)

/** 这些对象自己用到的贴图（只看它们的材质） */
fn amb_bitmaps_of objs = (
  local out = #()
  for o in objs do (
    local m = undefined
    try (m = o.material) catch (m = undefined)
    if m != undefined do (
      local bts = #()
      try (bts = getClassInstances bitmaptexture target:m) catch (bts = #())
      for bt in bts do (
        local f = ""
        try (f = bt.filename as string) catch ()
        if f != "" and (findItem out f == 0) do append out f
      )
    )
  )
  out
)

fn amb_copy_maps destDir files overwrite = (
  local copied = #()
  local skipped = #()
  local failed = #()
  if not (amb_is_dir destDir) do (try (makeDir destDir) catch ())
  for f in files do (
    if (doesFileExist f) do (
      local name = filenameFromPath f
      local dst = destDir + "\\" + name
      if (toLower dst) == (toLower f) then (
        append skipped name
      ) else if (doesFileExist dst) and not overwrite then (
        append skipped name
      ) else (
        local ok = true
        try (copyFile f dst) catch (ok = false)
        if ok then append copied name else append failed name
      )
    )
  )
  #(copied, skipped, failed)
)

fn amb_map_file m props = (
  local out = ""
  local done = false
  for p in props while not done do (
    if (isProperty m p) do (
      try (
        local mp = getProperty m p
        local fname = mp.filename as string
        if fname != "" do (out = fname; done = true)
      ) catch ()
    )
  )
  out
)

/** 打包时顺手写槽位表，导入 AssetManager 后预览能准确接图 */
fn amb_write_slots dir objs = (
  local m = undefined
  for o in objs while m == undefined do (
    try (if o.material != undefined do m = o.material) catch ()
  )
  if m == undefined do return false
  local pairs = #()
  local bc = amb_map_file m #(#base_color_map, #diffuseMap)
  if bc != "" do append pairs #("baseColor", bc)
  local rg = amb_map_file m #(#roughness_map, #reflectionGlossinessMap)
  if rg != "" do append pairs #("roughness", rg)
  local mt = amb_map_file m #(#metalness_map, #metallic_map)
  if mt != "" do append pairs #("metallic", mt)
  local em = amb_map_file m #(#emit_color_map, #selfIllumMap)
  if em != "" do append pairs #("emissive", em)
  local dp = amb_map_file m #(#displacement_map, #texmap_displacement)
  if dp != "" do append pairs #("height", dp)
  local op = amb_map_file m #(#transparency_map, #opacityMap)
  if op != "" do append pairs #("opacity", op)
  try (
    local bm = m.bump_map
    if bm != undefined do (
      local nm = ""
      try (nm = bm.normal_map.filename as string) catch ()
      if nm != "" do append pairs #("normal", nm)
    )
  ) catch ()
  if pairs.count == 0 do return false
  local parts = #()
  for pr in pairs do (
    append parts ("\"" + (pr[1] as string) + "\":\"" + (amb_esc (filenameFromPath (pr[2] as string))) + "\"")
  )
  local js = "{" + (amb_join parts ",") + "}"
  local ok = true
  try (
    local enc = dotNetObject "System.Text.UTF8Encoding" false
    (dotNetClass "System.IO.File").WriteAllText (dir + "\\asset_maps.json") js enc
  ) catch (ok = false)
  ok
)

/** 打包核心：<parent>\<name>\ 里放 <name>.fbx + maps\ + pack_info.txt */
fn amb_pack_to parent name objs withMat withMaps = (
  if parent == undefined or parent == "" do return "没有保存位置"
  name = amb_sanitize_name name
  local target = parent + "\\" + name
  local n = 2
  while (amb_is_dir target) do (
    target = parent + "\\" + name + "_" + (n as string)
    n += 1
  )
  local folderName = filenameFromPath target
  -- 用 .NET 递归建目录（makeDir 不会自动建不存在的父级）
  local okDir = true
  try ((dotNetClass "System.IO.Directory").CreateDirectory target) catch (okDir = false)
  if not okDir do return ("无法创建目录：" + target)
  amb_log ("pack dir=" + target)
  local mapDir = target + "\\maps"
  try ((dotNetClass "System.IO.Directory").CreateDirectory mapDir) catch ()
  local r = amb_export_fbx (target + "\\" + folderName + ".fbx") objs withMat
  if not r[1] do return ("导出失败：" + r[2])

  local maps = #()
  local mc = #(#(), #(), #())
  if withMaps do (
    maps = amb_bitmaps_of objs
    mc = amb_copy_maps mapDir maps true
    try (amb_write_slots target objs) catch ()
  )

  local note = "AssetManager 打包\r\n名称：" + name + "\r\n时间：" + (localTime as string) \
    + "\r\n材质：" + (if withMat then "含" else "不含") + "\r\n贴图：" + ((mc[1].count) as string) + " 个\r\n"
  try (
    local enc = dotNetObject "System.Text.UTF8Encoding" false
    (dotNetClass "System.IO.File").WriteAllText (target + "\\pack_info.txt") note enc
  ) catch ()

  local msg = "已打包：" + target
  if withMaps do msg += "（贴图 " + ((mc[1].count) as string) + " 个）"
  if not withMat do msg += "（未含材质）"
  msg
)

/** 点「打包到指定位置」：选文件夹 → 弹名字输入框 → 在选中位置建文件夹并打包 */
fn amb_export_pack withMat:false withMaps:false = (
  local objs = amb_pick_objects()
  if objs.count == 0 do return "场景里没有可导出的几何体"
  if not (amb_has_ui()) do return "batch 模式下不支持打包"
  local parent = getSavePath caption:"选择打包位置（会在这里新建文件夹）"
  if parent == undefined or parent == "" do return "已取消"
  if not (amb_has_ui()) do return "batch 模式下不支持打包"
  AMB_PACK_PARENT = parent as string
  AMB_PACK_MAT = withMat
  AMB_PACK_MAPS = withMaps
  local defName = amb_jgets AMB_CURRENT_ASSET "name"
  if defName == "" do defName = "Asset_Export"
  amb_log ("pack step1 dir=" + AMB_PACK_PARENT + " mat=" + (withMat as string) + " maps=" + (withMaps as string))
  try (destroyDialog ambPackDlg) catch ()
  createDialog ambPackDlg width:330
  "在 " + (amb_ellipsis parent 30) + " 下新建文件夹"
)

/** 名字确认后真正打包 */
fn amb_pack_do nm = (
  local parent = AMB_PACK_PARENT
  if parent == undefined or parent == "" do return "没有保存位置"
  if nm == undefined or nm == "" do return "没有文件夹名"
  local objs = amb_pick_objects()
  if objs.count == 0 do return "场景里没有可导出的几何体"
  amb_log ("pack step2 name=" + (nm as string) + " parent=" + parent)
  local msg = amb_pack_to parent nm objs AMB_PACK_MAT AMB_PACK_MAPS
  AMB_LAST_EXPORT = msg
  amb_log msg
  amb_toolbar_refresh()
  msg
)

/* ------------------------------------------------------------ 设置读写 */

/* --------------------------------------------------------- 材质母版 / 构建 */

fn amb_templates = (
  local list = #()
  local cands = #(
    #("PhysicalMaterial", "物理材质 PhysicalMaterial"),
    #("Standard", "标准材质 Standard"),
    #("Arch__Design", "建筑材质 Arch & Design"),
    #("VRayMtl", "V-Ray 标准材质 VRayMtl"),
    #("ai_standard_surface", "Arnold standard_surface"),
    #("CoronaMtl", "Corona 材质"),
    #("RedshiftMaterial", "Redshift 材质"),
    #("MultiMaterial", "多维/子对象材质"),
    #("Blend", "混合材质 Blend"),
    #("Shell_Material", "壳材质 Shell")
  )
  for c in cands do (
    local ok = false
    try (local mm = execute ((c[1]) + "()"); ok = (mm != undefined)) catch (ok = false)
    if ok do append list c
  )
  list
)

fn amb_try_set_map mat props bt = (
  local done = false
  for p in props while not done do (
    if (isProperty mat p) do (
      try (setProperty mat p bt; done = true) catch ()
    )
  )
  done
)

fn amb_try_set_val mat props v = (
  local done = false
  for p in props while not done do (
    if (isProperty mat p) do (
      try (setProperty mat p v; done = true) catch ()
    )
  )
  done
)

/** 按母版类名建材质并尽量接贴图；返回 #(material, mappedKeys, missedKeys) */
fn amb_build_with_template className spec = (
  if spec == undefined do return undefined
  local mat = undefined
  try (mat = execute (className + "()")) catch (mat = undefined)
  if mat == undefined do return undefined
  local nm = amb_jgets spec "name"
  if nm != "" do (try (mat.name = nm) catch ())

  local maps = amb_jget spec "maps"
  local mappedKeys = #()
  local missedKeys = #()
  local normalBump = undefined

  if maps != undefined do (
    for pair in maps do (
      local key = pair[1]
      local e = pair[2]
      local p = amb_jget e "path"
      local chan = amb_jgets e "channel"
      if chan == "" do chan = "rgb"
      local isDx = (amb_jgets e "normalSpace" == "dx")
      local bt = amb_bitmap_for p chan isDx
      if bt == undefined then (
        append missedKeys (key as string + "(缺文件)")
      ) else (
        amb_uv_tiling bt spec
        local done = false
        if key == "baseColor" do done = amb_try_set_map mat #(#base_color_map, #diffuseMap, #diffuse_map, #baseColorMap) bt
        if key == "roughness" do done = amb_try_set_map mat #(#roughness_map, #roughnessMap, #reflectionGlossinessMap) bt
        if key == "metallic" do done = amb_try_set_map mat #(#metalness_map, #metalnessMap, #metallic_map) bt
        if key == "emissive" do done = amb_try_set_map mat #(#emit_color_map, #emission_map, #selfIllumMap) bt
        if key == "opacity" do done = amb_try_set_map mat #(#transparency_map, #opacityMap, #opacity_map) bt
        if key == "normal" do (
          local nb = undefined
          try (nb = Normal_Bump()) catch (nb = undefined)
          if nb != undefined do (
            try (
              nb.normal_map = bt
              nb.map1on = true
              nb.method = 1
              if isDx do nb.flipgreen = true
              normalBump = nb
              done = true
            ) catch ()
          )
        )
        if key == "height" do (
          -- 优先接置换通道；母版没有置换再退回凹凸
          done = amb_try_set_map mat #(#displacement_map, #texmap_displacement, #displacementMap, #displace) bt
          if done do (
            try (amb_try_set_val mat #(#displacement_map_on, #texmap_displacement_on) true) catch ()
          )
          if not done and normalBump == undefined do (
            local nb2 = undefined
            try (nb2 = Normal_Bump()) catch (nb2 = undefined)
            if nb2 != undefined do (
              try (
                nb2.bump_map = bt
                nb2.map2on = true
                nb2.method = 2
                normalBump = nb2
                done = true
              ) catch ()
            )
          )
        )
        if key == "ao" then (append missedKeys "ao(无独立通道)")
        else if not done do (append missedKeys (key as string + "(母版无对应通道)"))
        if done and key != "ao" do append mappedKeys key
      )
    )
  )
  if normalBump != undefined do (
    try (amb_try_set_map mat #(#bump_map, #bumpMap) normalBump) catch ()
  )
  #(mat, mappedKeys, missedKeys)
)

/** 打开母版选择框（选完在对话框里创建）；mode: "editor" / "selection" / "both" */
fn amb_choose_template spec mode = (
  if not (amb_has_ui()) do return "batch 模式下不弹母版选择框"
  local list = amb_templates()
  if list.count == 0 do return "没有可用的材质母版"
  local items = for c in list collect (c[2] as string)
  AMB_PENDING_SPEC = spec
  AMB_PENDING_MODE = mode as string
  if AMB_PENDING_MODE == "" do AMB_PENDING_MODE = "editor"
  try (destroyDialog ambTemplateDlg) catch ()
  createDialog ambTemplateDlg width:340 height:250
  try (
    ambTemplateDlg.lbTpl.items = items
    ambTemplateDlg.lbTpl.selection = 1
  ) catch ()
  "请选择材质母版"
)
/* ------------------------------------------------------------ 导入摆放 */

fn amb_is_dir p = (
  local ok = false
  try (ok = (dotNetClass "System.IO.Directory").Exists p) catch (ok = (doesFileExist (p + "\\")))
  ok
)

fn amb_log txt = (
  local tmp = (getDir #temp)
  try (tmp = (dotNetClass "System.IO.Path").GetTempPath()) catch ()
  local dir = tmp + "AssetManager"
  local file = dir + "\\bridge.log"
  try (if not (amb_is_dir dir) do makeDir dir) catch ()
  try (
    local enc = dotNetObject "System.Text.UTF8Encoding" false
    (dotNetClass "System.IO.File").AppendAllText file ((localTime as string) + "  " + (txt as string) + "\r\n") enc
  ) catch ()
  true
)

fn amb_ellipsis s maxLen = (
  local t = s as string
  if t.count <= maxLen then t else ((substring t 1 (maxLen - 1)) + "…")
)

/** 光标在视口地面（Z=0）上的落点 */
fn amb_cursor_ground = (
  local pt = undefined
  try (
    local sp = (dotNetClass "System.Windows.Forms.Cursor").Position
    pt = [sp.X as float, sp.Y as float]
  ) catch (pt = undefined)
  if pt == undefined do return undefined
  local r = undefined
  try (r = mapScreenToWorldRay pt) catch (r = undefined)
  if r == undefined do return undefined
  if (abs (r.dir.z)) < 0.0001 do return undefined
  local tt = -(r.pos.z) / r.dir.z
  if tt <= 0 do return undefined
  r.pos + r.dir * tt
)

/** 只取顶层对象（父级不在这批里），避免层级/组被重复位移 */
fn amb_roots_of objs = (
  local roots = #()
  for o in objs do (
    local p = undefined
    try (p = o.parent) catch (p = undefined)
    if p == undefined or (findItem objs p == 0) do append roots o
  )
  if roots.count == 0 do roots = objs
  roots
)

/** 这一批对象的世界包围盒 */
fn amb_world_bounds objs = (
  local mn = objs[1].min
  local mx = objs[1].max
  for o in objs do (
    local a = o.min
    local b = o.max
    mn = [amin mn.x a.x, amin mn.y a.y, amin mn.z a.z]
    mx = [amax mx.x b.x, amax mx.y b.y, amax mx.z b.z]
  )
  #(mn, mx)
)

fn amb_shift_world roots delta = (
  for o in roots do (try (in coordsys world o.pos += delta) catch ())
  true
)

fn amb_move_to_point objs pt = (
  if objs.count == 0 or pt == undefined do return false
  local bb = amb_world_bounds objs
  local mn = bb[1]
  local mx = bb[2]
  local delta = [pt.x - ((mn.x + mx.x) / 2.0), pt.y - ((mn.y + mx.y) / 2.0), -mn.z]
  amb_shift_world (amb_roots_of objs) delta
  amb_log ("move to point " + (pt as string) + " delta=" + (delta as string))
  true
)

fn amb_move_to_center objs = (
  if objs.count == 0 do return false
  local bb = amb_world_bounds objs
  local mn = bb[1]
  local mx = bb[2]
  local delta = [-((mn.x + mx.x) / 2.0), -((mn.y + mx.y) / 2.0), -mn.z]
  amb_shift_world (amb_roots_of objs) delta
  amb_log ("move to center delta=" + (delta as string))
  true
)

/** 真正导入：choice = "center" / "point" */
fn amb_import_now choice = (
  local pending = AMB_PENDING_IMPORT
  if pending == undefined do return "没有待导入的模型"
  local p = amb_jgets pending "path"
  local info = amb_jget pending "info"
  AMB_PENDING_IMPORT = undefined
  if not (doesFileExist p) do return ("模型文件不存在：" + p)

  local before = for o in objects collect o
  local ok = true
  local err = ""
  try (
    local ext = toLower (getFilenameType p)
    if ext == ".fbx" do FBXImporterSetParam "Mode" #create
    importFile p #noPrompt
  ) catch (ok = false; err = amb_err())
  if not ok do return ("导入失败：" + err)

  local created = for o in objects where (findItem before o == 0) collect o
  if created.count == 0 do return "导入完成，但没有新增对象"
  try (clearSelection(); select created) catch ()

  -- 资产归属：记住 UUID → 源目录/模型文件，并给对象打标（导回靠它认人）
  local uuid = amb_jgets info "uuid"
  if uuid != "" do (
    amb_reg_put uuid #(uuid, amb_jgets info "name", amb_jgets info "sourceDir", amb_jgets info "modelPath")
    local nTag = amb_tag_asset created uuid (amb_jgets info "name") (amb_jgets info "sourceDir") (amb_jgets info "modelPath")
    amb_log ("uuid tag " + uuid + " objects=" + (nTag as string))
  )

  -- 素材里有贴图配置就补上（模型自带材质时不动）
  local spec = amb_jget info "material"
  local autoMat = false
  if spec != undefined and (AMB_DROP_AUTOMAT) do (
    local built = amb_build_with_template "PhysicalMaterial" spec
    if built != undefined do (
      for o in created do (
        local empty = false
        try (empty = (o.material == undefined) or (classof o.material == StandardMaterial and o.material.diffuseMap == undefined)) catch (empty = false)
        if empty do (try (o.material = built[1]; autoMat = true) catch ())
      )
    )
  )

  -- 摆放：指定位置改成“点一下”最可靠（光标坐标在不同视口布局下会有偏移）
  if choice == "point" then (
    local pt = AMB_PLACE_POINT
    local picked = undefined
    try (picked = pickPoint prompt:"点击放置位置（可吸附到地面）" snap:#3D) catch (picked = undefined)
    if picked != undefined and picked != #failed do pt = picked
    if pt == undefined do pt = [0,0,0]
    amb_move_to_point created pt
  ) else (
    amb_move_to_center created
  )
  local bb = amb_world_bounds created
  amb_log ("import done choice=" + (choice as string) + " n=" + (created.count as string) + " center=" + (((bb[1] + bb[2]) / 2.0) as string))
  "已导入 " + (created.count as string) + " 个对象" + (if autoMat then "（已贴图）" else "")
)

/** 先问摆放方式，再导入 */
fn amb_begin_import p info = (
  AMB_PENDING_IMPORT = #(#("path", p), #("info", info))
  AMB_PLACE_POINT = undefined
  try (AMB_PLACE_POINT = amb_cursor_ground()) catch (AMB_PLACE_POINT = undefined)
  if not (amb_has_ui()) do return (amb_import_now "center")
  try (destroyDialog ambImportDlg) catch ()
  createDialog ambImportDlg width:330
  "请选择导入到世界中心还是拖放位置"
)

fn amb_drop_material info = (
  local spec = amb_jget info "material"
  if spec == undefined do return "这个素材没有材质数据"
  amb_choose_template spec "editor"
)

/* ------------------------------------------------------- .ms 拖放（主链路） */

fn amb_asset_info assetId = (
  if not (amb_ensure_port()) do return undefined
  local r = amb_http_get (amb_url ("/api/bridge/asset/" + (assetId as string)))
  if not r[1] do return undefined
  local txt = r[2] as string
  if txt == "" do return undefined
  try (amb_parse txt) catch undefined
)

fn amb_info_direct assetId kind sourceDir nm modelPath uuid = (
  local info = #()
  append info #("assetId", assetId)
  append info #("name", nm)
  append info #("type", kind)
  if sourceDir != "" do append info #("sourceDir", sourceDir)
  if modelPath != "" do append info #("modelPath", modelPath)
  if uuid != "" do append info #("uuid", uuid)
  info
)

/** AssetManager 拖过来的 .ms 调这里 */
fn amb_drop_asset assetId filePath kind sourceDir nm modelPath uuid:"" = (
  amb_log ("drop asset=" + (assetId as string) + " kind=" + (kind as string) + " file=" + (filePath as string))
  local info = amb_info_direct assetId (kind as string) (sourceDir as string) (nm as string) (modelPath as string) (uuid as string)
  local spec = undefined
  if filePath != "" do (
    local r = undefined
    try (r = amb_resolve_file filePath) catch (r = undefined)
    if r != undefined do (
      spec = amb_jget r "material"
      if spec != undefined do append info #("material", spec)
    )
  )
  AMB_CURRENT_ASSET = info
  try (amb_toolbar_refresh()) catch ()

  local k = toLower ((kind as string))
  if k == "" do k = "model"
  if k == "model" or k == "scene" then (
    amb_begin_import filePath info
  ) else if k == "material" then (
    if spec == undefined do return "这个素材没有材质数据"
    amb_choose_template spec "editor"
  ) else (
    "插件只支持模型和材质（收到：" + k + "）"
  )
)

/* ------------------------------------------------ 资产归属（UUID）/ 导回 */

/** 取对象的 UUID；没有就返回空串（注意：getUserProp 没有时返回 undefined，直接 as string 会得到 "undefined"） */
fn amb_obj_uuid o = (
  local raw = undefined
  try (raw = getUserProp o #ambUuid) catch (raw = undefined)
  if raw == undefined then return ""
  local s = raw as string
  if s == "undefined" do return ""
  s
)

/** 取对象的某个资产属性（同样处理 undefined） */
fn amb_obj_prop o key = (
  local raw = undefined
  try (raw = getUserProp o key) catch (raw = undefined)
  if raw == undefined then return ""
  local s = raw as string
  if s == "undefined" do return ""
  s
)
/** 递归展开（组头 Helper 也会返回，方便收集组内对象） */
fn amb_nodes_deep roots = (
  local out = #()
  local queue = #()
  local cur = undefined
  local ch = undefined
  local c = undefined
  local i = 1
  for o in roots do append queue o
  while i <= queue.count do (
    cur = queue[i]
    append out cur
    ch = undefined
    try (ch = cur.children) catch (ch = undefined)
    if ch != undefined do (for c in ch do append queue c)
    i += 1
  )
  out
)

/** 会话注册表：uuid → #(uuid, 名称, 源目录, 模型文件) */
fn amb_reg_put uuid rec = (
  local idx = 0
  local k = 1
  for r in AMB_ASSET_REG do (
    if (r[1] as string) == uuid do idx = k
    k += 1
  )
  if idx > 0 then AMB_ASSET_REG[idx] = rec else append AMB_ASSET_REG rec
  rec
)

fn amb_reg_get uuid = (
  local out = undefined
  for r in AMB_ASSET_REG do (
    if (r[1] as string) == uuid do out = r
  )
  out
)

/** 给对象（含组内）打资产标记；新增/附加/分离出来的对象由导出时提示补 */
fn amb_tag_asset objs uuid nm dir model = (
  if uuid == "" do return 0
  local all = amb_nodes_deep objs
  local n = 0
  for o in all where (superClassOf o == GeometryClass) do (
    try (
      setUserProp o #ambUuid uuid
      setUserProp o #ambName nm
      setUserProp o #ambDir dir
      setUserProp o #ambModel model
      n += 1
    ) catch ()
  )
  n
)

/** 从对象上取资产信息：#(uuid, 名称, 源目录, 模型文件)；注册表优先，其次对象属性 */
fn amb_asset_of_obj o = (
  local uuid = amb_obj_uuid o
  if uuid == "" do return #("", "", "", "")
  local r = amb_reg_get uuid
  if r != undefined do return r
  #(uuid, (amb_obj_prop o #ambName), (amb_obj_prop o #ambDir), (amb_obj_prop o #ambModel))
)

/** 场景里属于该 uuid 的所有几何体 */
fn amb_collect_uuid uuid = (
  local out = #()
  if uuid == "" do return out
  local all = amb_nodes_deep objects
  local u = ""
  for o in all where (superClassOf o == GeometryClass) do (
    u = amb_obj_uuid o
    if u == uuid do append out o
  )
  out
)

/** 贴图落点：资产里已有 maps 子目录就放那儿，否则放资产根目录 */
fn amb_maps_target dir = (
  local sub = dir + "\\maps"
  if (amb_is_dir sub) then sub else dir
)

/** 按扩展名导出（FBX / OBJ） */
fn amb_export_any file objs ext withMat = (
  local ok = true
  local err = ""
  try (
    clearSelection()
    if objs.count > 0 do select objs
    if ext == ".obj" then (
      exportFile file #noPrompt selectedOnly:true using:ObjExp
    ) else (
      try (FBXExporterSetParam "EmbedTextures" false) catch ()
      try (FBXExporterSetParam "Animation" false) catch ()
      try (FBXExporterSetParam "Materials" (if withMat then true else false)) catch ()
      exportFile file #noPrompt selectedOnly:true using:FBXEXP
    )
  ) catch (ok = false; err = amb_err())
  if ok and not (doesFileExist file) do (ok = false; err = "导出命令没有生成文件")
  amb_log ("export-back " + file + " ok=" + (ok as string) + " " + err)
  #(ok, err)
)

/** 通知 AssetManager 重扫该资产（UUID 认人） */
fn amb_notify_exported uuid dir = (
  if not (amb_ensure_port()) do return false
  local payload = "{\"uuid\":\"" + (amb_esc uuid) + "\",\"dir\":\"" + (amb_esc dir) + "\"}"
  local r = amb_post_json (amb_url "/api/bridge/max/exported") payload
  amb_log ("notify exported uuid=" + uuid + " ok=" + ((r != undefined) as string))
  (r != undefined)
)

/** 导回到源目录：按当前选中对象的 UUID 收集整个资产，写回原文件（.max/.glb 另存 FBX） */
fn amb_export_back = (
  local sel = selection as array
  if sel.count == 0 do return "先在视口里选中该资产的对象"
  local tagged = undefined
  local uuid = ""
  local u = ""
  for o in sel while tagged == undefined do (
    u = amb_obj_uuid o
    if u != "" do (tagged = o; uuid = u)
  )
  if tagged == undefined do return "选中对象没有素材来源（UUID），不做导回"

  local rec = amb_asset_of_obj tagged
  local nm = rec[2] as string
  local dir = rec[3] as string
  local model = rec[4] as string
  if dir == "" or dir == undefined do return "这个资产没有记录源目录：请重新从 AssetManager 发送一次再改"

  local mine = amb_collect_uuid uuid
  if mine.count == 0 do return "场景里找不到该资产的对象"

  -- 目标文件：Model 是 FBX/OBJ 就覆盖；.max/.glb 等另存 FBX（不覆盖原文件）
  local ext = toLower (getFilenameType model)
  local target = model
  local mode = "overwrite"
  if ext != ".fbx" and ext != ".obj" do (
    local baseName = nm
    if baseName == "" do baseName = getFilenameFile model
    if baseName == "" do baseName = "Asset_Export"
    target = dir + "\\" + baseName + "_fromMax.fbx"
    ext = ".fbx"
    mode = "copy"
  )
  if target == undefined or target == "" do return "没有可写回的目标文件"

  -- 覆盖前先备份到临时目录（FBX 导出会删同目录 .bak，所以不放旁边）
  local backup = ""
  if mode == "overwrite" and (doesFileExist target) do (
    local bdir = ((dotNetClass "System.IO.Path").GetTempPath()) + "AssetManager\\backup"
    try (if not (amb_is_dir bdir) do makeDir bdir) catch ()
    local stamp = ""
    try (stamp = (dotNetClass "System.DateTime").Now.ToString("yyyyMMdd-HHmmss")) catch (stamp = "bak")
    backup = bdir + "\\" + (getFilenameFile target) + "-" + stamp + (getFilenameType target)
    try (copyFile target backup) catch (backup = "")
  )

  local r = amb_export_any target mine ext true
  if not r[1] do return ("导出失败：" + (r[2] as string))

  -- 贴图：复制进资产目录（覆盖同名）+ 重写槽位表，让软件预览按槽位接图
  local maps = amb_bitmaps_of mine
  local mt = amb_maps_target dir
  local mc = amb_copy_maps mt maps true
  try (amb_write_slots dir mine) catch ()

  try (amb_notify_exported uuid dir) catch ()

  local msg = (if mode == "copy" then "已另存 FBX：" else "已覆盖导回：") + target
  if mc[1].count > 0 do msg += "；贴图 " + (mc[1].count as string) + " 个"
  if (mc[2].count + mc[3].count) > 0 do msg += "（跳过 " + (mc[2].count as string) + " / 失败 " + (mc[3].count as string) + "）"
  if backup != "" do msg += "；原文件备份 " + backup
  AMB_LAST_EXPORT = msg
  amb_log msg
  amb_toolbar_refresh()
  msg
)
/* ---------------------------------------------------------------- 工具栏 */

rollout ambToolbar "AssetManager" width:352
(
  label lblConn "连接中…" align:#left height:16
  label lblAsset "当前素材：—" align:#left height:16
  group "打包导出"
  (
    checkbox chkMaps "附带贴图（复制进包内 maps\\）" checked:false
    button btnPack "打包选中对象到指定位置…" width:322 height:24
    button btnBack "导回到源目录（覆盖模型 + 贴图）" width:322 height:24
  )
  label lblLast "—" align:#left height:16
  button btnRefresh "刷新" width:110 height:22 across:3
  button btnDetail "详情…" width:100 height:22
  button btnHide "隐藏" width:100 height:22

  on btnPack pressed do (
    lblLast.text = amb_ellipsis (amb_export_pack withMat:true withMaps:chkMaps.checked) 52
  )
  on btnBack pressed do (
    lblLast.text = amb_ellipsis (amb_export_back()) 52
  )
  on btnRefresh pressed do (
    try (amb_heartbeat()) catch ()
    amb_toolbar_refresh()
  )
  on btnDetail pressed do ( AssetManagerBridge_Status() )
  on btnHide pressed do (destroyDialog ambToolbar)

  on ambToolbar open do ( amb_toolbar_refresh() )
)

rollout ambImportDlg "导入模型" width:330
(
  label lblTip "选择模型的摆放方式：" align:#left
  button bCenter "导入到世界中心" width:290 height:26
  button bPoint "导入到指定位置（拖放点）" width:290 height:26
  button bCancel "取消" width:290 height:22

  on bCenter pressed do (
    local r = amb_import_now "center"
    try (destroyDialog ambImportDlg) catch ()
    AMB_LAST_EXPORT = r
    amb_toolbar_refresh()
  )
  on bPoint pressed do (
    local r = amb_import_now "point"
    try (destroyDialog ambImportDlg) catch ()
    AMB_LAST_EXPORT = r
    amb_toolbar_refresh()
  )
  on bCancel pressed do (
    AMB_PENDING_IMPORT = undefined
    try (destroyDialog ambImportDlg) catch ()
  )
)

rollout ambPackDlg "打包文件夹名" width:330
(
  label lblDir "位置：" align:#left height:16
  edittext edtName "" width:290 height:22
  label lblTip "会在上面选定的位置下新建这个文件夹" align:#left height:16
  button btnOk "开始打包" width:140 height:24 across:2
  button btnCancel "取消" width:140 height:24

  on ambPackDlg open do (
    local defName = amb_jgets AMB_CURRENT_ASSET "name"
    if defName == "" do defName = "Asset_Export"
    edtName.text = defName
    lblDir.text = "位置：" + (amb_ellipsis AMB_PACK_PARENT 38)
  )
  on btnOk pressed do (
    local nm = edtName.text
    try (destroyDialog ambPackDlg) catch ()
    local msg = amb_pack_do nm
    AMB_LAST_EXPORT = msg
    amb_toolbar_refresh()
  )
  on btnCancel pressed do (try (destroyDialog ambPackDlg) catch ())
)

rollout ambTemplateDlg "选择材质母版" width:340 height:250
(
  label lblTip "选择用哪种材质母版重建：" align:#left
  listbox lbTpl "母版" items:#() height:9 width:310
  label lblNote "贴图会按母版的通道名尽量接上" align:#left height:16
  button btnGo "创建" width:120 height:24 across:2
  button btnCancel "取消" width:120 height:24

  on btnGo pressed do (
    local idx = lbTpl.selection
    local list = amb_templates()
    if idx < 1 or idx > list.count then (
      messageBox "请选择一个母版" title:"AssetManager"
    ) else (
      local cls = list[idx][1]
      local built = amb_build_with_template cls AMB_PENDING_SPEC
      if built == undefined then (
        messageBox ("创建失败：" + cls) title:"AssetManager"
      ) else (
        local pushed = amb_push_to_editor built[1]
        local msg = "已创建 " + (built[1].name) + "（" + cls + "）"
        if pushed do msg += "，已放进材质编辑器"
        if not pushed do msg += "，但没能放进材质编辑器"
        if built[2].count > 0 do msg += "；接入：" + (amb_join built[2] "、")
        if built[3].count > 0 do msg += "；未用：" + (amb_join built[3] "、")
        AMB_LAST_EXPORT = msg
        amb_log msg
        try (destroyDialog ambTemplateDlg) catch ()
        amb_toolbar_refresh()
      )
    )
    true
  )
  on btnCancel pressed do (destroyDialog ambTemplateDlg)
)

fn amb_toolbar_refresh = (
  if AMB_TOOLBAR == undefined do return false
  try (
    local conn = "● 未连接"
    if AMB_PORT > 0 do conn = "● 已连接（端口 " + (AMB_PORT as string) + "）"
    AMB_TOOLBAR.lblConn.text = conn
    local an = amb_jgets AMB_CURRENT_ASSET "name"
    local atype = amb_jgets AMB_CURRENT_ASSET "type"
    local aTxt = "当前素材：—"
    if an != "" do aTxt = "当前素材：" + an + "（" + atype + "）"
    if AMB_ASSET_REG.count > 0 do aTxt += "  ·  本次会话 " + (AMB_ASSET_REG.count as string) + " 个资产"
    AMB_TOOLBAR.lblAsset.text = amb_ellipsis aTxt 44
    if AMB_LAST_EXPORT != "" do AMB_TOOLBAR.lblLast.text = amb_ellipsis AMB_LAST_EXPORT 52
  ) catch ()
  true
)

fn amb_toolbar_show = (
  if not (amb_has_ui()) do return "batch 模式下没有工具栏"
  try (destroyDialog ambToolbar) catch ()
  createDialog ambToolbar style:#(#style_titlebar, #style_sysmenu, #style_toolwindow)
  AMB_TOOLBAR = ambToolbar
  amb_toolbar_refresh()
  "AssetManager 工具栏已打开"
)

fn amb_toolbar_toggle = (
  local isOpen = false
  try (isOpen = (ambToolbar.open == true)) catch (isOpen = false)
  if isOpen then (
    try (destroyDialog ambToolbar) catch ()
    "AssetManager 工具栏已关闭"
  ) else amb_toolbar_show()
)

fn AssetManagerBridge_Toolbar = (
  amb_toolbar_toggle()
)

macroScript AssetManagerToolbar
  category:"AssetManager"
  buttonText:"AssetManager"
  tooltip:"打开 AssetManager 桥接工具栏"
(
  -- 插件被卸载/未加载时这里会变成 undefined：只提示，不抛脚本错误。
  -- （Max 会把这段宏持久化到 usermacros\AssetManager-AssetManagerToolbar.mcr，卸载后仍会被加载）
  on execute do (
    if (classOf AssetManagerBridge_Toolbar) == MAXScriptFunction then (
      try ( AssetManagerBridge_Toolbar() )
      catch ( format "[AssetManager] 工具栏打开失败: %\n" (getCurrentException()) )
    ) else (
      format "[AssetManager] 3ds Max 插件未安装或已卸载；请在 AssetManager 的「插件」面板里勾选安装后重启 Max。\n"
    )
  )
)

/** 在主菜单栏加一个 AssetManager 菜单（只加一次） */
fn amb_install_menu = (
  local done = false
  try (
    local main = menuMan.findMenu "Main Menu Bar"
    if main != undefined do (
      if (menuMan.findMenu "AssetManager") == undefined do (
        local amMenu = menuMan.createMenu "AssetManager"
        local it1 = menuMan.createActionItem "AssetManagerToolbar" "AssetManager"
        try (it1.setUseCustomTitle true; it1.setTitle "打开桥接工具栏") catch ()
        amMenu.addItem it1 -1
        local sub = menuMan.createSubMenuItem "AssetManager" amMenu
        main.addItem sub -1
        menuMan.updateMenuBar()
        done = true
      )
    )
  ) catch (done = false)
  done
)

/* ------------------------------------------------------------ 生命周期 */

fn AssetManagerBridge_Stop = (
  AMB_ENABLED = false
  if AMB_TIMER != undefined do (
    try (AMB_TIMER.Stop()) catch ()
    try (dotNet.removeEventHandler AMB_TIMER "Tick" amb_tick) catch ()
    try (AMB_TIMER.Dispose()) catch ()
  )
  AMB_TIMER = undefined
  "AssetManager 桥接已停止"
)

fn AssetManagerBridge_Start interval:700 = (
  AssetManagerBridge_Stop()
  local t = undefined
  try (
    t = dotNetObject "System.Windows.Forms.Timer"
    t.Interval = interval
    dotNet.addEventHandler t "Tick" amb_tick
    t.Start()
  ) catch (
    t = undefined
    AMB_LAST_ERROR = "启动定时器失败：" + (amb_err())
  )
  AMB_TIMER = t
  AMB_ENABLED = (t != undefined)
  AMB_TICKS = 0
  if t != undefined then "AssetManager 桥接已启动（端口 " + (AMB_PORT as string) + "）"
  else "AssetManager 桥接启动失败：" + AMB_LAST_ERROR
)

fn AssetManagerBridge_Poll = (
  local r = amb_poll_once()
  ("轮询完成：" + (if r then "处理了 1 个任务" else "无任务 / 未连接") \
    + "；端口 " + (AMB_PORT as string) \
    + (if AMB_LAST_RESULT != "" then "；最近结果：" + AMB_LAST_RESULT else "") \
    + (if AMB_LAST_ERROR != "" then "；错误：" + AMB_LAST_ERROR else ""))
)

fn AssetManagerBridge_Heartbeat = (
  local ok = amb_heartbeat()
  if ok then ("心跳已发送，端口 " + (AMB_PORT as string)) else ("心跳失败：" + AMB_LAST_ERROR)
)

fn AssetManagerBridge_Status title:"AssetManager 桥接" = (
  local connected = amb_ensure_port()
  local lines = #()
  append lines ("插件版本：" + AMB_SCRIPT_VERSION + "（协议 " + (AMB_PROTOCOL as string) + "）")
  append lines ("状态：" + (if connected then "已连接" else "未连接（AssetManager 未启动？）"))
  append lines ("端口：" + (AMB_PORT as string))
  append lines ("轮询：" + (if AMB_ENABLED then "运行中" else "已停止") + "，请求数 " + (AMB_REQUEST_COUNT as string))
  append lines ("3ds Max：" + ((maxVersion() as string)))
  append lines ("当前素材：" + (amb_jgets AMB_CURRENT_ASSET "name"))
  append lines ("源目录：" + (amb_current_source()))
  append lines ("选中对象：" + (selection.count as string) + "，场景对象：" + (objects.count as string))
  append lines ("界面：" + ((amb_has_ui()) as string) + "  窗口：" + ((try (getMAXWindowSize() as string) catch "?")))
  append lines ("材质球空位：" + (amb_free_slot() as string))
  if AMB_LAST_JOB != "" do append lines ("最近任务：" + AMB_LAST_JOB)
  if AMB_LAST_RESULT != "" do append lines ("最近结果：" + AMB_LAST_RESULT)
  if AMB_LAST_EXPORT != "" do append lines ("最近导出：" + AMB_LAST_EXPORT)
  if AMB_LAST_ERROR != "" do append lines ("最近错误：" + AMB_LAST_ERROR)
  append lines ("日志：" + (try ((dotNetClass "System.IO.Path").GetTempPath()) catch ((getDir #temp))) + "AssetManager\\bridge.log")
  theText = amb_join lines "\n"
  if (amb_has_ui()) do messageBox theText title:title
  theText
)

/* ---------------------------------------------------------------- 启动 */

AMB_LOADED = true
if (AMB_AUTOSTART) do (
  try (AssetManagerBridge_Start()) catch (AMB_LAST_ERROR = amb_err())
)
try (amb_install_menu()) catch ()
if (AMB_TOOLBAR_AUTO) do (
  try (amb_toolbar_show()) catch (AMB_LAST_ERROR = amb_err())
)
format "AssetManager 桥接 v% 已载入（端口 %）\n" AMB_SCRIPT_VERSION AMB_PORT
/*
 AssetManager · 3ds Max 环境探针（排查用，不做任何修改）
 用法：3dsmaxbatch.exe "…\tools\probe_env.ms"
 输出：%TEMP%\AssetManager\max_env.txt
*/
(
  local out = ""
  out += "maxVersion=" + ((maxVersion()) as string) + "\r\n"
  out += "maxYear=" + (((maxVersion())[8]) as string) + "\r\n"
  out += "pluginLoaded=" + (if AMB_SCRIPT_VERSION == undefined then "no" else "yes") + "\r\n"
  out += "pluginVersion=" + (if AMB_SCRIPT_VERSION == undefined then "-" else AMB_SCRIPT_VERSION) + "\r\n"
  local p = (if (AMB_SCRIPT_VERSION != undefined) then (try (amb_config_port()) catch (0)) else 0)
  out += "port=" + (p as string) + "\r\n"
  out += "bridgeJson=" + (AMB_SCRIPT_VERSION != undefined and (amb_localappdata() as string).count > 0) as string + "\r\n"
  local startup = (getDir #startupScripts)
  out += "startupDir=" + startup + "\r\n"
  out += "pluginInStartup=" + ((doesFileExist (startup + "AssetManagerBridge.ms")) as string) + "\r\n"
  makeDir (sysInfo.tempdir + "\\AssetManager") all:true
  try ( (dotNetClass "System.IO.File").WriteAllText (sysInfo.tempdir + "\\AssetManager\\max_env.txt") out (dotNetObject "System.Text.UTF8Encoding" false) ) catch ()
  format "%\n" out
)

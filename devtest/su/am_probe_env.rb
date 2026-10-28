# encoding: utf-8
# 探针：environments#add 的参数形式（2025 需要 2 个参数，2026 只要 1 个）
require 'json'

OUT = File.join(ENV['TEMP'] || '.', "am-env-probe-#{Sketchup.version.split('.')[0]}.json")
EXR = 'F:/02AssetLibrary/Asset/04_HDRI/Outdoor/Outdoor_Day_4k_002/Outdoor_Day_4k_002_Environment.exr'

UI.start_timer(3.0, false) do
  r = { 'sketchup' => Sketchup.version }
  begin
    m = Sketchup.active_model
    envs = m.environments
    r['add_arity'] = (envs.method(:add).arity rescue 'err')
    r['add_params'] = (envs.method(:add).parameters.inspect rescue 'err')
    r['exr_exists'] = File.exist?(EXR)

    # 1 个参数
    begin
      e = envs.add(EXR)
      r['one_arg'] = { 'ok' => true, 'name' => (e.name rescue '?'), 'path' => (e.path rescue '?') }
      envs.remove(e) rescue nil
    rescue Exception => ex
      r['one_arg'] = "ERR #{ex.class}: #{ex.message.to_s[0, 100]}"
    end

    # (path, name)
    begin
      e = envs.add(EXR, 'AM_P1')
      r['path_name'] = { 'ok' => true, 'name' => (e.name rescue '?'), 'path' => (e.path rescue '?') }
      envs.remove(e) rescue nil
    rescue Exception => ex
      r['path_name'] = "ERR #{ex.class}: #{ex.message.to_s[0, 100]}"
    end

    # (name, path)
    begin
      e = envs.add('AM_P2', EXR)
      r['name_path'] = { 'ok' => true, 'name' => (e.name rescue '?'), 'path' => (e.path rescue '?') }
      envs.remove(e) rescue nil
    rescue Exception => ex
      r['name_path'] = "ERR #{ex.class}: #{ex.message.to_s[0, 100]}"
    end
  rescue Exception => e
    r['fatal'] = "#{e.class}: #{e.message}"
  end
  begin
    File.open(OUT, 'w') { |f| f.write(JSON.pretty_generate(r)) }
  rescue StandardError
    nil
  end
end

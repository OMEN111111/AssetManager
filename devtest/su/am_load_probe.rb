# encoding: utf-8
# 探针：加载本项目的 SketchUp 插件，把加载/初始化阶段的异常写出来
require 'json'

VER = "20#{Sketchup.version.split('.')[0]}"   # 2022 的 Sketchup.version 是 "22.0.316"
OUT = File.join(ENV['TEMP'] || '.', "am-load-probe-#{VER}.json")
LOADER = "D:/Program/AssetManager/app/bridge/su/#{VER}/assetmanager_su.rb"
TESTER = 'D:/Program/AssetManager/app/bridge/su/tools/test_su.rb'

def capture
  yield
rescue Exception => e
  "ERR #{e.class}: #{e.message}\n  " + Array(e.backtrace).first(6).join("\n  ")
end

UI.start_timer(3.0, false) do
  r = { 'sketchup' => Sketchup.version, 'ruby' => RUBY_VERSION, 'loader' => LOADER }

  r['loader_exists'] = File.exist?(LOADER)
  r['tester_exists'] = File.exist?(TESTER)
  r['tester_parse'] = capture { RubyVM::InstructionSequence.compile(File.read(TESTER)); 'ok' }

  r['load_loader'] = capture do
    load LOADER
    'ok'
  end

  r['bridge_defined'] = defined?(AssetManager::Bridge) ? 'yes' : 'no'
  r['plugin_version'] = (AssetManager::AM_PLUGIN_VERSION rescue 'n/a')
  r['series'] = (AssetManager::AM_SERIES rescue 'n/a')

  if defined?(AssetManager::Bridge)
    r['pbr?'] = capture { AssetManager::Bridge.pbr?.to_s }
    r['env?'] = capture { AssetManager::Bridge.env?.to_s }
    r['importers_dir'] = capture { AssetManager::Bridge.importers_dir.to_s }
    r['imports'] = capture { AssetManager::Bridge.supported_import_exts.join(' ') }
    r['status_keys'] = capture { AssetManager::Bridge.status_payload.keys.join(',') }
    r['capability'] = capture { AssetManager::Bridge.capability_summary }
    r['dialog_html_len'] = capture { AssetManager::Bridge.dialog_html.to_s.length.to_s }
    r['build_menu'] = capture do
      AssetManager::Bridge.build_menu
      'ok'
    end
  end

  # 直接跑测试脚本看看能不能起来
  r['run_tests'] = capture do
    load TESTER
    res = AMSuTest.results
    "#{res.count { |x| x[:ok] }}/#{res.length}"
  end

  begin
    File.open(OUT, 'w') { |f| f.write(JSON.pretty_generate(r)) }
  rescue StandardError
    nil
  end
end

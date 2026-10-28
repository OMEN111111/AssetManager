# encoding: utf-8
# 临时自测包装：作为插件放进 Plugins，启动后自动跑 tools/test_su.rb 并把结果写到
# %TEMP%\am-su-selftest-<主版本>.json（跑完不退出，由外部脚本收尾）
require 'json'

module AMSelfTest
  REPO = 'D:/Program/AssetManager'
  # 注意：Sketchup.version 对 2022 是 "22.0.316"，首段只有 "22"；结果文件名要用完整年份
  SERIES = (defined?(AssetManager::AM_SERIES) ? AssetManager::AM_SERIES : "20#{Sketchup.version.split('.')[0]}")
  OUT = File.join(ENV['TEMP'] || '.', "am-su-selftest-#{SERIES}.json")

  def self.write(data)
    File.open(OUT, 'w') { |f| f.write(JSON.pretty_generate(data)) }
  rescue StandardError
    nil
  end

  def self.run
    begin
      load File.join(REPO, 'app/bridge/su/tools/test_su.rb')
      r = AMSuTest.results
      write('sketchup' => Sketchup.version,
            'ruby' => RUBY_VERSION,
            'series' => (defined?(AssetManager::AM_SERIES) ? AssetManager::AM_SERIES : '?'),
            'plugin' => (defined?(AssetManager::AM_PLUGIN_VERSION) ? AssetManager::AM_PLUGIN_VERSION : '?'),
            'pass' => r.count { |x| x[:ok] },
            'total' => r.length,
            'failed' => r.reject { |x| x[:ok] }.map { |x| "#{x[:name]} — #{x[:detail]}" })
    rescue Exception => e
      write('sketchup' => Sketchup.version,
            'fatal' => "#{e.class}: #{e.message}",
            'bt' => Array(e.backtrace).first(8))
    end
  end
end

# 插件加载后再等一会儿（等 SketchUp 主线程稳定）
UI.start_timer(4.0, false) { AMSelfTest.run }

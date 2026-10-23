# -*- coding: utf-8 -*-
"""UE 测试跑批：GUI 编辑器里等 Slate 就绪后执行目标脚本，然后退出编辑器。

用法（devtest/ue/run-test.ps1 会自动设好环境变量）：
  $env:AM_TEST_SCRIPT = "D:/.../bridge/ue/tools/test_ue.py"
  UnrealEditor.exe <project> -ExecCmds="py D:/.../devtest/ue/runner.py" -nosplash -log

为什么不用 -run=pythonscript：那是个 commandlet，没有 Slate 应用，
Interchange 导入 FBX 时会断言 CurrentApplication.IsValid() 直接崩。
"""
import os
import traceback

import unreal

TARGET = os.environ.get("AM_TEST_SCRIPT", "")
READY_TICKS = int(os.environ.get("AM_TEST_READY_TICKS", "5"))

_state = {"ticks": 0, "done": False}


def _tick(_dt):
    if _state["done"]:
        return
    _state["ticks"] += 1
    if _state["ticks"] < READY_TICKS:
        return
    _state["done"] = True
    unreal.log("[AMRUN] 开始执行测试脚本：%s" % TARGET)
    try:
        if TARGET and os.path.exists(TARGET):
            with open(TARGET, "r", encoding="utf-8") as f:
                src = f.read()
            g = {"__name__": "__main__", "__file__": TARGET}
            exec(compile(src, TARGET, "exec"), g)
        else:
            unreal.log_error("[AMRUN] 测试脚本不存在：%s" % TARGET)
    except SystemExit:
        pass
    except Exception:
        unreal.log_error("[AMRUN] 测试脚本异常：\n" + traceback.format_exc())
    finally:
        unreal.log("[AMRUN] 结束，退出编辑器")
        try:
            unreal.SystemLibrary.quit_editor()
        except Exception:
            pass


unreal.register_slate_post_tick_callback(_tick)
unreal.log("[AMRUN] runner 已就绪，等待 Slate tick…")

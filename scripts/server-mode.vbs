' Runs server-mode.ps1 with no window, and — the reason this file exists at all —
' out of reach of the host that asks for it. Node kills any child it did not spawn
' detached when it dies, and server-mode.ps1 is the thing that kills the host, so a
' plain child would be killed by its own first action. Spawning it detached instead
' does not work either: DETACHED_PROCESS leaves powershell.exe without a console and
' it exits silently, having done nothing. wscript is a GUI program, so detaching it
' costs it nothing, and the shell it starts gets a console of its own.
Set sh = CreateObject("WScript.Shell")
ps1 = Replace(WScript.ScriptFullName, ".vbs", ".ps1")
WScript.Quit sh.Run("powershell -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """", 0, True)

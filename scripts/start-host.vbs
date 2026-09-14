' Runs start-host.ps1 -Direct with no window at all. powershell.exe -WindowStyle Hidden
' still flashes a console for a moment before hiding it, and the watchdog would do
' that every minute. wscript runs the same thing invisibly.
Set sh = CreateObject("WScript.Shell")
ps1 = Replace(WScript.ScriptFullName, ".vbs", ".ps1")
WScript.Quit sh.Run("powershell -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """ -Direct", 0, True)

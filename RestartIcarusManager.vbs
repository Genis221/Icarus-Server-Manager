' Fully detaches RestartIcarusManager.cmd so it survives when the node process exits.
Option Explicit
Dim sh, fso, scriptDir, helper, port, host, cmd, logFile, ts
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
helper = scriptDir & "\RestartIcarusManager.cmd"
If WScript.Arguments.Count >= 1 Then port = WScript.Arguments(0) Else port = "3230"
If WScript.Arguments.Count >= 2 Then host = WScript.Arguments(1) Else host = "0.0.0.0"
logFile = scriptDir & "\data\restart.log"
On Error Resume Next
If Not fso.FolderExists(scriptDir & "\data") Then fso.CreateFolder scriptDir & "\data"
ts = Now
Dim stream
Set stream = fso.OpenTextFile(logFile, 8, True)
stream.WriteLine ts & " vbs launched helper port=" & port & " host=" & host
stream.Close
On Error GoTo 0
' 1 = normal window so update progress is visible; False = do not wait.
cmd = """" & helper & """ " & port & " " & host
sh.Run cmd, 1, False

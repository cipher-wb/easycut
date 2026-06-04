' ============================================================
'  QingJian EasyCut - Desktop launcher (silent, no console)
'  Double-click to start the editor as a desktop app window.
'  (All text here is English on purpose to avoid codepage issues.)
'
'  It runs server.py with the windowless Python launcher (pyw),
'  which opens an Edge/Chrome "app window" (no address bar/tabs).
'  Close that window to quit -- the server stops automatically.
'  If you need to see logs / errors, run "启动.bat" instead.
' ============================================================
Option Explicit
Dim sh, fso, here, server, ok
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
server = here & "\server.py"
sh.CurrentDirectory = here

If Not fso.FileExists(server) Then
  MsgBox "server.py not found next to this launcher:" & vbCrLf & server, _
         vbCritical, "QingJian EasyCut"
  WScript.Quit 1
End If

' Try the windowless launcher "pyw" first, then "pythonw", then "python".
' Run mode 0 = hidden window, False = do not wait.
ok = False
On Error Resume Next
sh.Run "pyw -3 """ & server & """", 0, False
If Err.Number = 0 Then ok = True
Err.Clear
If Not ok Then
  sh.Run "pythonw """ & server & """", 0, False
  If Err.Number = 0 Then ok = True
  Err.Clear
End If
If Not ok Then
  sh.Run "python """ & server & """", 0, False
  If Err.Number = 0 Then ok = True
  Err.Clear
End If
On Error Goto 0

If Not ok Then
  MsgBox "Python 3 was not found. Please install Python 3 from" & vbCrLf & _
         "https://www.python.org/downloads/ and try again.", _
         vbCritical, "QingJian EasyCut"
  WScript.Quit 1
End If

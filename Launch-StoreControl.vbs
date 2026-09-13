Option Explicit
Dim WshShell, fso, edgePath, serverUrl, appUrl, i

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

WshShell.CurrentDirectory = "C:\Users\esadb\Desktop\La Strada\laden-umsatz-manager"

serverUrl = "http://127.0.0.1:3000/api/network-info"
appUrl = "http://localhost:3000"
edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

Function IsServerRunning()
    On Error Resume Next
    Dim req
    Set req = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    req.open "GET", serverUrl, False
    req.setTimeouts 500, 500, 500, 500
    req.send
    If Err.Number = 0 Then
        If req.status = 200 Then
            IsServerRunning = True
            Exit Function
        End If
    End If
    IsServerRunning = False
    On Error GoTo 0
End Function

If Not IsServerRunning() Then
    WshShell.Run "cmd.exe /c node server\index.js", 0, False
    For i = 1 To 12
        WScript.Sleep 500
        If IsServerRunning() Then Exit For
    Next
End If

If fso.FileExists(edgePath) Then
    WshShell.Run """" & edgePath & """ --app=" & appUrl, 1, False
Else
    WshShell.Run appUrl, 1, False
End If
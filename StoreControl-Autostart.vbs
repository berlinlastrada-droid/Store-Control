Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\esadb\Desktop\La Strada\laden-umsatz-manager"
WshShell.Run "cmd.exe /c node server\index.js", 0, False

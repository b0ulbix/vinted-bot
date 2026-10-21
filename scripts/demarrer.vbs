' Démarre le bot et le tunnel en arrière-plan, sans fenêtre (lancé au démarrage de Windows)
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c """ & dir & "\lancer-bot.cmd""", 0, False
sh.Run "cmd /c """ & dir & "\lancer-tunnel.cmd""", 0, False

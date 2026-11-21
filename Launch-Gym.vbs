Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

strDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = strDir

' 1. فحص هل السيرفر يعمل بالفعل على المنفذ 3000
isRunning = False
On Error Resume Next
Set oHTTP = CreateObject("MSXML2.ServerXMLHTTP.6.0")
oHTTP.setTimeouts 800, 800, 800, 800
oHTTP.open "GET", "http://localhost:3000/login.html", False
oHTTP.send ""
If Err.Number = 0 Then
    If oHTTP.status >= 200 And oHTTP.status < 500 Then
        isRunning = True
    End If
End If
On Error Goto 0

' 2. إذا لم يكن السيرفر يعمل، نقوم بتشغيله في الخلفية بدون شاشة سوداء
If Not isRunning Then
    WshShell.Run "node --disable-warning=ExperimentalWarning server.js", 0, False
    ' ننتظر حتى يبدأ السيرفر في الاستجابة (فحص حتى 12 ثانية كحد أقصى للعمل بعد بدء الويندوز مباشرة)
    For i = 1 To 30
        WScript.Sleep 400
        On Error Resume Next
        oHTTP.open "GET", "http://localhost:3000/login.html", False
        oHTTP.send ""
        If Err.Number = 0 And oHTTP.status >= 200 And oHTTP.status < 500 Then
            isRunning = True
            Exit For
        End If
        On Error Goto 0
    Next
End If

' 3. ضمان تسجيل التشغيل التلقائي مع فتح الويندوز (Startup Folder + Registry Run Key)
On Error Resume Next
startupDir = WshShell.SpecialFolders("Startup")
If fso.FolderExists(startupDir) Then
    startupLnk = startupDir & "\X GYM.lnk"
    Set scStartup = WshShell.CreateShortcut(startupLnk)
    scStartup.TargetPath = "wscript.exe"
    scStartup.Arguments = """" & WScript.ScriptFullName & """"
    scStartup.WorkingDirectory = strDir
    iconPath = strDir & "\icon.ico"
    If fso.FileExists(iconPath) Then scStartup.IconLocation = iconPath
    scStartup.Description = "X GYM - تشغيل تلقائي"
    scStartup.Save
End If
WshShell.RegWrite "HKCU\Software\Microsoft\Windows\CurrentVersion\Run\XGYM", "wscript.exe """ & WScript.ScriptFullName & """", "REG_SZ"
On Error Goto 0

' 4. فتح التطبيق كنافذة مستقلة احترافية (Desktop App Mode)
appOpened = False
localAppData = WshShell.ExpandEnvironmentStrings("%LocalAppData%")

browserPaths = Array( _
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", _
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe", _
    "C:\Program Files\Google\Chrome\Application\chrome.exe", _
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe", _
    localAppData & "\Google\Chrome\Application\chrome.exe", _
    "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" _
)

For Each p In browserPaths
    If fso.FileExists(p) Then
        WshShell.Run """" & p & """ --app=http://localhost:3000 --window-size=1300,850", 1, False
        appOpened = True
        Exit For
    End If
Next

' في حال عدم وجود أي من المتصفحات في المسارات المحددة، نفتح الرابط في المتصفح الافتراضي للجهاز
If Not appOpened Then
    WshShell.Run "http://localhost:3000", 1, False
End If

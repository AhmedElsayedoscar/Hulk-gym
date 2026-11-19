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
    ' ننتظر حتى يبدأ السيرفر في الاستجابة (فحص كل 400 مللي ثانية حتى 6 ثوانٍ كحد أقصى)
    For i = 1 To 15
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

' 3. فتح التطبيق كنافذة مستقلة احترافية (Desktop App Mode)
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

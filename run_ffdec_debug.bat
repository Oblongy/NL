@echo off
set "PATH=C:\Program Files\Java\jre1.8.0_481\bin;%PATH%"
echo PATH_OK
where java
java -version
dir C:\Users\Dilldo\Music\Library\1320L\3.swf
dir C:\Users\Dilldo\Music\Library\1320L\tmp_ffdec_3_export\scripts
call C:\Users\Dilldo\Desktop\1320Legends0431\FFDec\ffdec.bat -dumpAS2 -exportNames C:\Users\Dilldo\Music\Library\1320L\3.swf

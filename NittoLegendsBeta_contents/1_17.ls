global gSimInet

on lingoXtraNoDebug
  the debugPlaybackEnabled = 0
  myFile = new(xtra("fileio"))
  openFile(myFile, "l" & "i" & "n" & "g" & "o" & "." & "i" & "n" & "i", 1)
  if status(myFile) = 0 then
    quit()
  end if
  myFile = 0
end

on lingoXtraInit
  the debugPlaybackEnabled = 1
  caluMD5_register("I", "agree with the usage terms")
  set the timeoutLength to 216000
  set the timeoutScript to "setInactive"
  gSimInet = xtra("simInet").new()
end

on getPCInfo
  bdi = string(baDiskInfo(baSysFolder("windows"), "number"))
  if offset(".", bdi) > 0 then
    bdi = bdi.char[1]
  end if
  qs = "mid=" & bdi & baCpuInfo("vendor") & baCpuInfo("type") & baCpuInfo("model")
  qs = qs & "&nid=" & To3GetMacAddress().char[1]
  qs = qs & "&prid=" & baReadRegString("SOFTWARE\\Microsoft\\Windows\\CurrentVersion", "ProductId", "NoProductId", "HKEY_LOCAL_MACHINE")
  qs = qs & "&cna=" & baComputerName()
  return qs
end

on baLingoFolderExists param1
  return baFolderExists(param1)
end

on baLingoCreateFolder param1
  return baCreateFolder(param1)
end

on baLingoFileList param1, param2
  return baFileList(param1, param2)
end

on baLingoFileExists param1
  return baFileExists(param1)
end

on baLingoTempFileName param1
  return baTempFileName(param1)
end

on baLingoFileAge param1
  return baFileAge(param1)
end

on baLingoDeleteFile param1
  return baDeleteFile(param1)
end

on baLingoFileDateEx param1, param2, param3, param4
  return baFileDateEx(param1, param2, param3, param4)
end

on baLingoSetFileDate param1, param2, param3, param4, param5, param6, param7
  return baSetFileDate(param1, param2, param3, param4, param5, param6, param7)
end

on baLingoSysFolder param1
  return baSysFolder(param1)
end

on baLingoRunProgram param1, param2, param3
  return baRunProgram(param1, param2, param3)
end

on isCheatEngineRunning
  ceHandle = baWindowList("", "ch" & "eat" & " en" & "gine", 0)
  if ceHandle.count > 0 then
    return 1
  else
    return 0
  end if
end

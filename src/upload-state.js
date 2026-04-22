const RECENT_DECAL_UPLOAD_MAX_AGE_MS = 5 * 60 * 1000;

const PANEL_FIELD_TO_SLOT = Object.freeze({
  hoodImage: "160",
  sideImage: "161",
  frontImage: "162",
  rearImage: "163",
  backImage: "163",
});

const recentDecalUploadsByRemote = new Map();

function isFreshUpload(upload) {
  return !!upload?.timestamp && Date.now() - upload.timestamp <= RECENT_DECAL_UPLOAD_MAX_AGE_MS;
}

function getFreshUploads(remoteAddress) {
  const uploads = recentDecalUploadsByRemote.get(remoteAddress) || [];
  const freshUploads = uploads.filter(isFreshUpload);
  if (freshUploads.length > 0) {
    recentDecalUploadsByRemote.set(remoteAddress, freshUploads);
  } else {
    recentDecalUploadsByRemote.delete(remoteAddress);
  }
  return freshUploads;
}

export function getCustomGraphicSlotIdForField(fieldName) {
  return PANEL_FIELD_TO_SLOT[String(fieldName || "")] || "";
}

export function rememberRecentDecalUpload({ remoteAddress, fieldName, targetPath }) {
  if (!remoteAddress || !targetPath) {
    return;
  }

  const upload = {
    fieldName: String(fieldName || ""),
    slotId: getCustomGraphicSlotIdForField(fieldName),
    targetPath: String(targetPath),
    timestamp: Date.now(),
  };

  const uploads = getFreshUploads(remoteAddress);
  uploads.push(upload);
  recentDecalUploadsByRemote.set(remoteAddress, uploads);
}

export function consumeRecentDecalUpload({ remoteAddress, slotId }) {
  if (!remoteAddress) {
    return null;
  }

  const uploads = getFreshUploads(remoteAddress);
  if (uploads.length === 0) {
    return null;
  }

  const desiredSlotId = String(slotId || "");
  let chosenIndex = uploads.length - 1;

  if (desiredSlotId) {
    let matchingIndex = -1;
    for (let index = uploads.length - 1; index >= 0; index -= 1) {
      if (uploads[index]?.slotId === desiredSlotId) {
        matchingIndex = index;
        break;
      }
    }
    if (matchingIndex >= 0) {
      chosenIndex = matchingIndex;
    }
  }

  const [chosenUpload] = uploads.splice(chosenIndex, 1);
  if (uploads.length > 0) {
    recentDecalUploadsByRemote.set(remoteAddress, uploads);
  } else {
    recentDecalUploadsByRemote.delete(remoteAddress);
  }

  return chosenUpload || null;
}

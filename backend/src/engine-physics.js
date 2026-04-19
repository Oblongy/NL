/**
 * engine-physics.js
 *
 * Server-side race engine simulation ported from RaceManager.cs (desktop project).
 * Used to generate the timing array (t=[...]) sent in practice/getonecarengine responses.
 *
 * The timing array is consumed by the Flash client as a delta-encoded position array
 * for computer tournament opponents (ppArr). Each entry is the distance delta (feet)
 * per ~33ms frame. The client accumulates them to get absolute position.
 *
 * Source: C:\Users\Dilldo\Desktop\1320Legends0431\Nitto1320Server\RaceManager.cs
 * (StepEngine, BuildCarRaceSpecs, SelectGearboxProfile, SelectRedLine)
 */

// ── Drivetrain layouts ────────────────────────────────────────────────────────

const DriveLayout = Object.freeze({ FWD: "FWD", RWD: "RWD", AWD: "AWD" });

// ── Gearbox profiles (from RaceManager.cs) ───────────────────────────────────
// GearboxProfile: { layout, tireDiameterInches, finalDrive, forwardRatios }

const Rwd5Profile = { layout: DriveLayout.RWD, tireDiameterInches: 26.0, finalDrive: 3.73, forwardRatios: [3.587, 2.022, 1.384, 1.000, 0.861] };
const Rwd6Profile = { layout: DriveLayout.RWD, tireDiameterInches: 26.0, finalDrive: 3.55, forwardRatios: [3.587, 2.022, 1.384, 1.000, 0.861, 0.730] };
const Fwd5Profile = { layout: DriveLayout.FWD, tireDiameterInches: 25.0, finalDrive: 4.10, forwardRatios: [3.462, 1.947, 1.286, 0.972, 0.780] };
const Fwd6Profile = { layout: DriveLayout.FWD, tireDiameterInches: 25.0, finalDrive: 4.06, forwardRatios: [3.462, 1.947, 1.286, 0.972, 0.780, 0.650] };
const Awd5Profile = { layout: DriveLayout.AWD, tireDiameterInches: 25.5, finalDrive: 3.90, forwardRatios: [3.454, 1.947, 1.296, 0.972, 0.738] };
const Awd6Profile = { layout: DriveLayout.AWD, tireDiameterInches: 25.5, finalDrive: 3.70, forwardRatios: [3.454, 1.947, 1.296, 0.972, 0.738, 0.615] };
const Auto4Profile = { layout: DriveLayout.RWD, tireDiameterInches: 26.5, finalDrive: 3.08, forwardRatios: [2.480, 1.480, 1.000, 0.720] };
const Auto5Profile = { layout: DriveLayout.RWD, tireDiameterInches: 26.5, finalDrive: 3.23, forwardRatios: [2.480, 1.480, 1.000, 0.720, 0.580] };
const Muscle4Profile = { layout: DriveLayout.RWD, tireDiameterInches: 27.0, finalDrive: 3.55, forwardRatios: [2.660, 1.780, 1.300, 1.000] };
const Truck6Profile = { layout: DriveLayout.RWD, tireDiameterInches: 28.0, finalDrive: 3.73, forwardRatios: [3.587, 2.022, 1.384, 1.000, 0.861, 0.730] };

// ── Redline selection (from RaceManager.SelectRedLine) ───────────────────────

function selectRedLine(engineStr, transmissionStr) {
  const engine = (engineStr || "").toLowerCase();
  const transmission = (transmissionStr || "").toLowerCase();
  const isAutomatic = transmission.includes("automatic");

  if (engine.includes("rotary"))                    return 9000;
  if (engine.includes("hemi"))                      return 5600;
  if (engine.includes("v10"))                       return 6200;
  if (engine.includes("supercharged v8"))           return 6500;
  if (engine.includes("v8"))                        return isAutomatic ? 5800 : 6500;
  if (engine.includes("v6"))                        return isAutomatic ? 6200 : 6600;
  if (engine.includes("turbo")) {
    const is6speed = transmission.includes("6-speed");
    return is6speed ? 7000 : 6800;
  }
  if (engine.includes("2.2l"))                      return 7400;
  if (engine.includes("1.6l"))                      return 7800;
  if (engine.includes("1.8l"))                      return transmission.includes("6-speed") ? 7800 : 7600;
  return isAutomatic ? 6200 : 6800;
}

// ── Gearbox profile selection (from RaceManager.SelectGearboxProfile) ────────

function parseGearCount(transmissionStr, fallback) {
  const tokens = (transmissionStr || "").split(/[\s-]+/);
  for (const token of tokens) {
    const n = parseInt(token, 10);
    if (!isNaN(n) && n >= 3 && n <= 8) return n;
  }
  return fallback;
}

function selectGearboxProfile(drivetrainStr, transmissionStr, bodyTypeStr, weightLbs) {
  const drivetrain = (drivetrainStr || "").trim().toUpperCase();
  const transmission = (transmissionStr || "").trim().toLowerCase();
  const isAutomatic = transmission.includes("automatic");
  const gearCount = parseGearCount(transmission, isAutomatic ? 4 : 5);
  const isTruck = (bodyTypeStr || "").toLowerCase() === "truck" || weightLbs >= 4800;

  if (drivetrain === "FWD") return gearCount >= 6 ? Fwd6Profile : Fwd5Profile;
  if (drivetrain === "AWD") return gearCount >= 6 ? Awd6Profile : Awd5Profile;
  if (isTruck && gearCount >= 6) return Truck6Profile;
  if (isAutomatic && gearCount >= 5) return Auto5Profile;
  if (isAutomatic) return Auto4Profile;
  if (gearCount <= 4) return Muscle4Profile;
  if (gearCount >= 6) return Rwd6Profile;
  return Rwd5Profile;
}

// ── Engine state ──────────────────────────────────────────────────────────────

function makeEngineState() {
  return {
    rpm: 950,
    fps: 0,
    distance: -13,
    mph: 0,
    gear: 0,
    clutchSlip: 0,
    brakeOn: false,
    nosOn: false,
    nosPercent: 0,
    boostPsi: 0,
  };
}

// ── Physics helpers (from RaceManager.cs) ────────────────────────────────────

function getGearRatio(spec, gear) {
  if (gear < 0) return -3.20;
  if (gear === 0) return 0.0;
  const idx = gear - 1;
  const ratios = spec.gearbox.forwardRatios;
  return idx < ratios.length ? ratios[idx] : ratios[ratios.length - 1];
}

function getClutchGrip(e) {
  const pedal = Math.max(0, Math.min(1, e.clutchSlip));
  return Math.pow(1.0 - pedal, 1.15);
}

function getTractionLimit(spec, speedMph) {
  let launchBase;
  switch (spec.gearbox.layout) {
    case DriveLayout.FWD: launchBase = 15.5; break;
    case DriveLayout.RWD: launchBase = 18.5; break;
    default:              launchBase = 21.0; break;
  }
  launchBase += Math.min(spec.horsepower / 85.0, 8.0);
  if (speedMph <= 60.0) return launchBase;
  const taper = Math.max(0.72, 1.0 - (speedMph - 60.0) / 220.0);
  return launchBase * taper;
}

function getGearMaxFps(spec, gear, maxRpm) {
  const gearRatio = Math.abs(getGearRatio(spec, gear));
  if (gearRatio <= 0) return Infinity;
  const totalRatio = gearRatio * spec.gearbox.finalDrive;
  const wheelRpm = maxRpm / totalRatio;
  const tireCircumferenceFt = Math.PI * spec.gearbox.tireDiameterInches / 12.0;
  return wheelRpm * tireCircumferenceFt / 60.0;
}

// ── Single physics step (ported from RaceManager.StepEngine) ─────────────────

function stepEngine(e, spec, throttle, dt, limitStagingSpeed) {
  throttle = Math.max(0, Math.min(1, throttle));
  const isPrelaunch = limitStagingSpeed && e.distance < 0;
  const maxRpm = spec.redLine;
  const idleRpm = 950.0;
  const fpsToMph = 0.681818;

  const clutchPedal = Math.max(0, Math.min(1, e.clutchSlip));
  const clutchGrip = getClutchGrip(e);
  const gearRatio = getGearRatio(spec, e.gear);
  const totalRatio = Math.abs(gearRatio) * spec.gearbox.finalDrive;
  const speedFps = Math.abs(e.fps);
  const speedMph = speedFps * fpsToMph;
  const tireCircumferenceFt = Math.PI * spec.gearbox.tireDiameterInches / 12.0;
  const wheelRpm = tireCircumferenceFt > 0.01 ? speedFps / tireCircumferenceFt * 60.0 : 0.0;
  const freeRevRpm = idleRpm + throttle * (maxRpm - idleRpm);
  const drivetrainRpm = Math.max(idleRpm, wheelRpm * Math.max(totalRatio, 0.35));
  const rpmBlend = e.gear === 0 ? 0.0 : Math.max(0, Math.min(1, clutchGrip * 1.08));
  let targetRpm = (isPrelaunch || e.gear === 0)
    ? freeRevRpm
    : freeRevRpm + (drivetrainRpm - freeRevRpm) * rpmBlend;
  targetRpm = Math.max(idleRpm, Math.min(maxRpm, targetRpm));
  e.rpm += (targetRpm - e.rpm) * (isPrelaunch ? 0.42 : 0.30);
  e.rpm = Math.max(idleRpm, Math.min(maxRpm, e.rpm));

  const rpmNorm = Math.max(0, Math.min(1, (e.rpm - idleRpm) / Math.max(1, maxRpm - idleRpm)));
  let torqueBand = 0.60 + 0.50 * Math.sin(rpmNorm * Math.PI * 0.95);
  torqueBand = Math.max(0.55, Math.min(1.0, torqueBand));

  const hpPerLb = spec.horsepower / spec.weightLbs;
  const targetEt = spec.estimatedEt > 0
    ? spec.estimatedEt
    : Math.pow(spec.weightLbs / spec.horsepower, 1.0 / 3.0) * 5.825;
  const targetAverageAccel = 2640.0 / Math.pow(targetEt, 2.0);
  // Multiplier accounts for the fact that real drag acceleration is front-loaded
  // (high at launch, tapering off). Tuned so that estimatedEt ≈ simulated ET.
  // Value 1.55 calibrated against known ETs (Integra 14.5s, Corvette 12.5s, GT-R 11.8s).
  const accelMultiplier = spec.estimatedEt > 0 ? 1.55 : (2.30 + Math.min(hpPerLb * 4.0, 0.40));
  const baseDriveAccel = targetAverageAccel * accelMultiplier;

  let accel = 0.0;

  if (e.gear > 0 && totalRatio > 0.0) {
    const firstTotalRatio = spec.gearbox.forwardRatios[0] * spec.gearbox.finalDrive;
    let ratioPull = 0.35 + 0.65 * (totalRatio / firstTotalRatio);
    ratioPull = Math.max(0.35, Math.min(1.0, ratioPull));
    let driveAccel = throttle * baseDriveAccel * ratioPull * torqueBand * clutchGrip;
    const tractionLimit = getTractionLimit(spec, speedMph);
    driveAccel = Math.min(driveAccel, isPrelaunch ? Math.max(2.5, tractionLimit * 0.18) : tractionLimit);
    accel += driveAccel;
  } else if (e.gear < 0) {
    const reverseRatio = Math.max(Math.abs(gearRatio) * spec.gearbox.finalDrive, 1.0);
    accel -= throttle * 2.4 * (0.25 + reverseRatio / 12.0) * clutchGrip;
  }

  if (speedFps > 0.05) {
    const rolling = 0.35 + spec.weightLbs / 16000.0;
    const aero = 0.00009 * speedFps * speedFps * Math.max(0.85, spec.weightLbs / 3200.0);
    const engineBrake = (e.gear !== 0 && throttle < 0.05)
      ? 0.55 * clutchGrip * Math.max(0, Math.min(1, e.rpm / maxRpm))
      : 0.0;
    accel -= Math.sign(e.fps) * (rolling + aero + engineBrake);
  }

  if (e.brakeOn) {
    const brakeDecel = speedMph > 40.0 ? 18.0 : 14.0;
    if (e.fps > 0) accel -= brakeDecel;
    else if (e.fps < 0) accel += brakeDecel;
  }

  if (e.nosOn && e.nosPercent > 0 && !isPrelaunch) {
    accel += 2.0 + spec.horsepower / 175.0;
  }

  // Rev limiter
  if (e.rpm >= maxRpm * 0.995 && throttle > 0.97 && clutchGrip > 0.90 && e.gear > 0) {
    accel *= 0.25;
  }

  let nextFps = e.fps + accel * dt;

  if (limitStagingSpeed && e.distance < 0 && e.gear > 0) {
    const maxStagingFps = e.distance <= -2.0 ? 5.0 : 1.6;
    nextFps = Math.max(0, Math.min(nextFps, maxStagingFps));
  }

  if (e.gear > 0 && clutchGrip > 0.72) {
    const gearMaxFps = getGearMaxFps(spec, e.gear, maxRpm);
    const clutchOverrunFps = 2.0 + clutchPedal * 10.0;
    nextFps = Math.min(nextFps, gearMaxFps + clutchOverrunFps);
  } else if (e.gear < 0 && clutchGrip > 0.72) {
    const reverseMaxFps = getGearMaxFps(spec, e.gear, maxRpm);
    const clutchOverrunFps = 2.0 + clutchPedal * 8.0;
    nextFps = Math.max(nextFps, -(reverseMaxFps + clutchOverrunFps));
  }

  if (e.brakeOn && e.fps !== 0 && Math.sign(nextFps) !== Math.sign(e.fps)) nextFps = 0;
  if (e.gear === 0 && throttle < 0.05) nextFps *= 0.95;
  if (Math.abs(nextFps) < 0.05) nextFps = 0;

  e.fps = nextFps;
  e.distance += e.fps * dt;
  e.mph = Math.abs(e.fps) * fpsToMph;
  e.boostPsi = (e.nosOn && e.nosPercent > 0) ? 14.7 : 0.0;
}

// ── Auto-shift logic ──────────────────────────────────────────────────────────

function autoShift(e, spec) {
  const maxRpm = spec.redLine;
  const maxGear = spec.gearbox.forwardRatios.length;

  if (e.gear === 0) {
    // Engage first gear once staged
    if (e.distance >= -2.0) {
      e.gear = 1;
      e.clutchSlip = 0;
    }
    return;
  }

  // Shift up near redline
  if (e.gear < maxGear && e.rpm >= maxRpm * 0.96) {
    e.gear = Math.min(e.gear + 1, maxGear);
    return;
  }

  // Shift down if rpm drops too low in current gear
  if (e.gear > 1 && e.rpm < maxRpm * 0.35) {
    e.gear = Math.max(e.gear - 1, 1);
  }
}

// ── Build a CarRaceSpec from showroom spec data ───────────────────────────────

/**
 * @param {object} opts
 * @param {number} opts.horsepower
 * @param {number} opts.weightLbs
 * @param {string} opts.engineStr   e.g. "1.8L I4 VTEC"
 * @param {string} opts.drivetrainStr e.g. "FWD"
 * @param {string} opts.transmissionStr e.g. "5-speed manual"
 * @param {string} [opts.bodyTypeStr]
 * @param {number} [opts.estimatedEt]  optional override for target ET
 */
export function buildCarRaceSpec(opts) {
  const {
    horsepower = 170,
    weightLbs = 2800,
    engineStr = "",
    drivetrainStr = "FWD",
    transmissionStr = "5-speed manual",
    bodyTypeStr = "Coupe",
    estimatedEt = 0,
  } = opts;

  const redLine = selectRedLine(engineStr, transmissionStr);
  const gearbox = selectGearboxProfile(drivetrainStr, transmissionStr, bodyTypeStr, weightLbs);

  return {
    horsepower,
    weightLbs,
    redLine,
    gearbox,
    estimatedEt,
  };
}

// ── Simulate a full quarter-mile run and return the timing array ──────────────

/**
 * Simulates a full 1320-foot run and returns a delta-encoded position array
 * suitable for the Flash client's ppArr (computer tournament opponent).
 *
 * The array has one entry per ~33ms frame. Each value is the distance delta
 * in feet from the previous frame. The client accumulates them to get absolute
 * position. The run starts from the staged position (-13 ft) and ends at 1320 ft.
 *
 * @param {object} spec  CarRaceSpec from buildCarRaceSpec()
 * @returns {string[]}   Array of delta strings (3 decimal places)
 */
export function simulateRun(spec) {
  const FRAME_MS = 33.333;
  const dt = FRAME_MS / 1000;
  const FINISH_LINE = 1320.0;
  const MAX_FRAMES = 2000; // ~66 seconds max

  const e = makeEngineState();
  e.distance = -13.0;
  // Start in first gear with partial clutch slip for the staging creep
  e.gear = 1;
  e.clutchSlip = 0.8; // heavy slip during staging
  e.rpm = spec.redLine * 0.25; // launch RPM

  const positions = [];
  let prevDistance = 0.0;
  let raceStarted = false;

  for (let frame = 0; frame < MAX_FRAMES; frame++) {
    const limitStaging = !raceStarted;

    // Release clutch progressively during staging
    if (limitStaging && e.clutchSlip > 0) {
      e.clutchSlip = Math.max(0, e.clutchSlip - 0.02);
    }

    autoShift(e, spec);
    stepEngine(e, spec, 1.0, dt, limitStaging);

    // Race starts when car crosses 0 (launch point)
    if (!raceStarted && e.distance >= 0) {
      raceStarted = true;
      prevDistance = 0.0;
    }

    if (raceStarted) {
      const delta = Math.max(0, e.distance - prevDistance);
      positions.push(delta.toFixed(3));
      prevDistance = e.distance;

      if (e.distance >= FINISH_LINE) break;
    }
  }

  return positions;
}

/**
 * Compute the estimated ET (elapsed time in seconds) for a given spec.
 * Runs a full simulation and measures time from launch to finish.
 *
 * @param {object} spec  CarRaceSpec from buildCarRaceSpec()
 * @returns {number}     ET in seconds
 */
export function estimateEt(spec) {
  const FRAME_MS = 33.333;
  const dt = FRAME_MS / 1000;
  const FINISH_LINE = 1320.0;
  const MAX_FRAMES = 2000;

  const e = makeEngineState();
  e.distance = -13.0;
  e.gear = 1;
  e.clutchSlip = 0.8;
  e.rpm = spec.redLine * 0.25;

  let raceStarted = false;
  let raceStartFrame = -1;

  for (let frame = 0; frame < MAX_FRAMES; frame++) {
    const limitStaging = !raceStarted;
    if (limitStaging && e.clutchSlip > 0) {
      e.clutchSlip = Math.max(0, e.clutchSlip - 0.02);
    }
    autoShift(e, spec);
    stepEngine(e, spec, 1.0, dt, limitStaging);

    if (!raceStarted && e.distance >= 0) {
      raceStarted = true;
      raceStartFrame = frame;
    }

    if (raceStarted && e.distance >= FINISH_LINE) {
      return (frame - raceStartFrame) * dt;
    }
  }

  return 15.0; // fallback
}

/**
 * Select redline for a car given its engine string.
 * Exported for use in getonecarengine response (sl attribute).
 */
export function getRedLine(engineStr, transmissionStr) {
  return selectRedLine(engineStr, transmissionStr);
}

/**
 * Drag Racing Physics Engine
 * 
 * Simulates realistic quarter-mile (402.336m) drag racing physics including:
 * - Power-to-weight calculations
 * - Gear shifts and transmission losses
 * - Tire grip and traction
 * - Aerodynamic drag
 * - Rolling resistance
 * - Launch control and wheelspin
 */

// Physical constants
const GRAVITY = 9.81; // m/s²
const AIR_DENSITY = 1.225; // kg/m³ at sea level
const QUARTER_MILE_METERS = 402.336;

// Base car specifications database (stock values)
const BASE_CAR_SPECS = {
  // Default/fallback values
  default: {
    weight: 1400, // kg
    hp: 170,
    torque: 220, // Nm
    redline: 7000,
    shiftPoint: 6800,
    dragCoefficient: 0.32,
    frontalArea: 2.2, // m²
    driveType: 'FWD',
    finalDrive: 4.058,
    gearRatios: [3.587, 2.022, 1.384, 1.0, 0.861, 0.7]
  },
  
  // Acura Integra GSR (ID: 1) - Default starter
  1: {
    weight: 1180,
    hp: 170,
    torque: 175,
    redline: 8000,
    shiftPoint: 7800,
    dragCoefficient: 0.32,
    frontalArea: 2.1,
    driveType: 'FWD',
    finalDrive: 4.4,
    gearRatios: [3.23, 1.9, 1.269, 0.967, 0.738]
  },
  
  // Mitsubishi Lancer Evo VIII (ID: 2)
  2: {
    weight: 1520,
    hp: 271,
    torque: 366,
    redline: 7000,
    shiftPoint: 6800,
    dragCoefficient: 0.35,
    frontalArea: 2.3,
    driveType: 'AWD',
    finalDrive: 4.529,
    gearRatios: [3.214, 1.925, 1.333, 1.03, 0.815, 0.65]
  },
  
  // Nissan GT-R (ID: 21)
  21: {
    weight: 1740,
    hp: 485,
    torque: 588,
    redline: 7000,
    shiftPoint: 6800,
    dragCoefficient: 0.27,
    frontalArea: 2.47,
    driveType: 'AWD',
    finalDrive: 3.7,
    gearRatios: [4.056, 2.301, 1.595, 1.248, 1.001, 0.796]
  },
  
  // Honda S2000 (ID: 9)
  9: {
    weight: 1260,
    hp: 240,
    torque: 218,
    redline: 9000,
    shiftPoint: 8800,
    dragCoefficient: 0.33,
    frontalArea: 2.0,
    driveType: 'RWD',
    finalDrive: 4.1,
    gearRatios: [3.133, 2.045, 1.481, 1.161, 0.971, 0.811]
  },
  
  // Toyota Supra (ID: 14)
  14: {
    weight: 1570,
    hp: 320,
    torque: 441,
    redline: 6800,
    shiftPoint: 6500,
    dragCoefficient: 0.31,
    frontalArea: 2.25,
    driveType: 'RWD',
    finalDrive: 3.133,
    gearRatios: [3.827, 2.36, 1.685, 1.312, 1.0, 0.793]
  },
  
  // Ford Mustang GT (ID: 3)
  3: {
    weight: 1650,
    hp: 300,
    torque: 407,
    redline: 6500,
    shiftPoint: 6300,
    dragCoefficient: 0.36,
    frontalArea: 2.4,
    driveType: 'RWD',
    finalDrive: 3.55,
    gearRatios: [3.66, 2.43, 1.69, 1.29, 1.0, 0.68]
  },
  
  // Dodge Viper SRT-10 (ID: 10)
  10: {
    weight: 1560,
    hp: 600,
    torque: 760,
    redline: 6200,
    shiftPoint: 6000,
    dragCoefficient: 0.36,
    frontalArea: 2.5,
    driveType: 'RWD',
    finalDrive: 3.07,
    gearRatios: [2.66, 1.78, 1.3, 1.0, 0.74, 0.5]
  }
};

/**
 * Get base car specifications by catalog ID
 */
function getBaseCarSpecs(catalogCarId) {
  return BASE_CAR_SPECS[catalogCarId] || BASE_CAR_SPECS.default;
}

/**
 * Parse installed parts from XML format
 * Example: <ps><p t="1" pi="100" hp="50"/><p t="2" pi="200" hp="30"/></ps>
 */
function parseCarParts(partsXml) {
  if (!partsXml) return [];
  
  const parts = [];
  const partMatches = partsXml.matchAll(/<p\s+([^>]+)\/>/g);
  
  for (const match of partMatches) {
    const attrs = match[1];
    const part = {};
    
    // Extract attributes
    const typeMatch = attrs.match(/t=['"](\d+)['"]/);
    const hpMatch = attrs.match(/hp=['"]([^'"]+)['"]/);
    const torqueMatch = attrs.match(/tq=['"]([^'"]+)['"]/);
    const weightMatch = attrs.match(/wt=['"]([^'"]+)['"]/);
    
    if (typeMatch) part.type = parseInt(typeMatch[1]);
    if (hpMatch) part.hp = parseFloat(hpMatch[1]);
    if (torqueMatch) part.torque = parseFloat(torqueMatch[1]);
    if (weightMatch) part.weight = parseFloat(weightMatch[1]);
    
    parts.push(part);
  }
  
  return parts;
}

/**
 * Calculate modified car performance based on installed parts
 */
function calculateCarPerformance(baseSpecs, parts) {
  let hp = baseSpecs.hp;
  let torque = baseSpecs.torque;
  let weight = baseSpecs.weight;
  let redline = baseSpecs.redline;
  
  // Apply part modifications
  for (const part of parts) {
    if (part.hp) hp += part.hp;
    if (part.torque) torque += part.torque;
    if (part.weight) weight += part.weight; // Negative for weight reduction
  }
  
  // Calculate power-to-weight ratio (hp per kg)
  const powerToWeight = hp / weight;
  
  // Calculate wheel horsepower (account for drivetrain loss)
  let drivetrainLoss = 0.15; // 15% for FWD/RWD
  if (baseSpecs.driveType === 'AWD') drivetrainLoss = 0.25; // 25% for AWD
  const wheelHp = hp * (1 - drivetrainLoss);
  
  return {
    hp,
    torque,
    weight,
    wheelHp,
    powerToWeight,
    redline,
    driveType: baseSpecs.driveType,
    dragCoefficient: baseSpecs.dragCoefficient,
    frontalArea: baseSpecs.frontalArea,
    finalDrive: baseSpecs.finalDrive,
    gearRatios: baseSpecs.gearRatios
  };
}

/**
 * Calculate traction multiplier based on drive type and launch
 */
function getTractionMultiplier(driveType, speed) {
  // Launch traction (0-30 mph)
  if (speed < 13.4) { // 30 mph in m/s
    switch (driveType) {
      case 'AWD': return 0.95; // Best launch
      case 'RWD': return 0.75; // Wheelspin
      case 'FWD': return 0.80; // Moderate wheelspin
      default: return 0.75;
    }
  }
  
  // Rolling traction (30+ mph)
  switch (driveType) {
    case 'AWD': return 1.0;
    case 'RWD': return 0.98;
    case 'FWD': return 0.95;
    default: return 0.95;
  }
}

/**
 * Calculate optimal shift point RPM
 */
function getShiftPoint(performance, currentGear) {
  // Shift when power in next gear exceeds current gear
  // Simplified: shift at 95% of redline
  return performance.redline * 0.95;
}

/**
 * Calculate current gear based on speed and RPM
 */
function getCurrentGear(speed, rpm, performance) {
  const { gearRatios, finalDrive } = performance;
  
  // Wheel speed (rad/s) - assuming 0.32m tire radius
  const wheelSpeed = speed / 0.32;
  
  // Find best gear for current speed
  for (let i = 0; i < gearRatios.length; i++) {
    const gearRpm = (wheelSpeed * gearRatios[i] * finalDrive * 60) / (2 * Math.PI);
    
    if (gearRpm <= performance.redline) {
      return i + 1; // Gears are 1-indexed
    }
  }
  
  return gearRatios.length; // Top gear
}

/**
 * Simulate quarter-mile drag race
 * Returns timing array (100 data points) and race statistics
 */
export function simulateQuarterMile(catalogCarId, partsXml = '') {
  const baseSpecs = getBaseCarSpecs(catalogCarId);
  const parts = parseCarParts(partsXml);
  const performance = calculateCarPerformance(baseSpecs, parts);
  
  // Simulation parameters
  const timeStep = 0.05; // 50ms time steps
  const maxTime = 30; // Maximum 30 seconds
  const numDataPoints = 100;
  
  // State variables
  let distance = 0;
  let speed = 0; // m/s
  let time = 0;
  let currentGear = 1;
  let rpm = 2000;
  
  // Data collection
  const speedData = [];
  const timeData = [];
  
  // Simulation loop
  while (distance < QUARTER_MILE_METERS && time < maxTime) {
    // Calculate engine power at current RPM (simplified power curve)
    const rpmRatio = rpm / performance.redline;
    let powerMultiplier = 1.0;
    
    if (rpmRatio < 0.3) {
      powerMultiplier = 0.5 + (rpmRatio / 0.3) * 0.5; // Low RPM: 50-100%
    } else if (rpmRatio > 0.95) {
      powerMultiplier = 1.0 - ((rpmRatio - 0.95) / 0.05) * 0.2; // Over-rev: 100-80%
    }
    
    const currentPower = performance.wheelHp * 745.7 * powerMultiplier; // Convert to watts
    
    // Calculate forces
    const tractionMultiplier = getTractionMultiplier(performance.driveType, speed);
    const drivingForce = (currentPower / Math.max(speed, 1)) * tractionMultiplier;
    
    // Aerodynamic drag: F = 0.5 * ρ * Cd * A * v²
    const dragForce = 0.5 * AIR_DENSITY * performance.dragCoefficient * 
                      performance.frontalArea * speed * speed;
    
    // Rolling resistance: F = Crr * m * g (Crr ≈ 0.015 for racing tires)
    const rollingResistance = 0.015 * performance.weight * GRAVITY;
    
    // Net force
    const netForce = drivingForce - dragForce - rollingResistance;
    
    // Acceleration: a = F / m
    const acceleration = netForce / performance.weight;
    
    // Update velocity and position
    speed += acceleration * timeStep;
    distance += speed * timeStep;
    time += timeStep;
    
    // Update RPM based on speed and gear
    const wheelSpeed = speed / 0.32; // rad/s
    const gearRatio = performance.gearRatios[currentGear - 1] || 1.0;
    rpm = (wheelSpeed * gearRatio * performance.finalDrive * 60) / (2 * Math.PI);
    
    // Check for gear shift
    const shiftPoint = getShiftPoint(performance, currentGear);
    if (rpm >= shiftPoint && currentGear < performance.gearRatios.length) {
      currentGear++;
      // Shift time penalty (100ms)
      time += 0.1;
      speed *= 0.98; // Small speed loss during shift
    }
    
    // Record data
    speedData.push(speed);
    timeData.push(time);
  }
  
  // Calculate final statistics
  const elapsedTime = time;
  const trapSpeed = speed; // m/s
  const trapSpeedMph = trapSpeed * 2.237; // Convert to mph
  
  // Resample to 100 data points for game format
  const timingArray = resampleSpeedData(speedData, numDataPoints);
  
  return {
    elapsedTime: elapsedTime.toFixed(3),
    trapSpeed: trapSpeedMph.toFixed(2),
    timingArray,
    performance: {
      hp: Math.round(performance.hp),
      torque: Math.round(performance.torque),
      weight: Math.round(performance.weight),
      powerToWeight: performance.powerToWeight.toFixed(3)
    }
  };
}

/**
 * Resample speed data to exactly N points using linear interpolation
 */
function resampleSpeedData(speedData, targetPoints) {
  if (speedData.length === 0) {
    return new Array(targetPoints).fill(266); // Default stopped value
  }
  
  const result = [];
  const step = (speedData.length - 1) / (targetPoints - 1);
  
  for (let i = 0; i < targetPoints; i++) {
    const index = i * step;
    const lowerIndex = Math.floor(index);
    const upperIndex = Math.ceil(index);
    const fraction = index - lowerIndex;
    
    if (lowerIndex === upperIndex) {
      result.push(speedData[lowerIndex]);
    } else {
      const interpolated = speedData[lowerIndex] * (1 - fraction) + 
                          speedData[upperIndex] * fraction;
      result.push(interpolated);
    }
  }
  
  // Convert m/s to game units (appears to be roughly 10x mph)
  // Game uses values like 266 (stopped) to 660 (fast)
  return result.map(speed => {
    const mph = speed * 2.237;
    return Math.round(266 + mph * 3.5); // Scale to game range
  });
}

/**
 * Generate car stats XML for practice response
 */
export function generateCarStatsXml(catalogCarId, partsXml = '', carId = '0') {
  const baseSpecs = getBaseCarSpecs(catalogCarId);
  const parts = parseCarParts(partsXml);
  const performance = calculateCarPerformance(baseSpecs, parts);
  const simulation = simulateQuarterMile(catalogCarId, partsXml);
  
  // Format gear ratios for XML
  const gearRatios = performance.gearRatios.slice(0, 6).map((ratio, i) => 
    `g${i + 1}='${ratio.toFixed(3)}'`
  ).join(' ');
  
  // Build n2 element with car stats
  const n2Attrs = [
    "es='1'", // Engine start
    `sl='${performance.redline}'`, // Speed limit (redline)
    "sg='0'", // Speed governor
    "rc='0'", // Race complete
    "tmp='0'", // Temperature
    `r='${performance.redline}'`, // Redline
    `v='${simulation.elapsedTime}'`, // ET (elapsed time)
    `a='${Math.round(performance.redline * 0.85)}'`, // Shift warning RPM
    `n='${performance.redline}'`, // Neutral RPM
    `o='${Math.round(performance.redline * 1.05)}'`, // Over-rev limit
    `s='1.208'`, // Speedometer scale
    "b='0'", // Boost
    "p='0.15'", // Unknown
    "c='11'", // Unknown
    "e='0'", // Unknown
    "d='T'", // Unknown
    ...performance.gearRatios.slice(0, 6).map((ratio, i) => 
      `${String.fromCharCode(102 + i)}='${ratio.toFixed(3)}'` // f, g, h, i, j, k
    ),
    `l='${performance.finalDrive.toFixed(3)}'`, // Final drive
    `q='${Math.round(performance.hp)}'`, // Horsepower
    `m='${simulation.trapSpeed}'`, // Trap speed (mph)
    "t='100'", // Traction
    "u='28'", // Unknown
    `w='${performance.powerToWeight.toFixed(4)}'`, // Power to weight
    `x='65.43'`, // Unknown
    `y='${Math.round(performance.torque)}'`, // Torque
    `z='${Math.round(performance.weight)}'`, // Weight (kg * 0.1?)
    "aa='4'", // Unknown
    `ab='${carId}'`, // Car ID
    "ac='9'", // Unknown
    "ad='0'", // Unknown
    "ae='100'", "af='100'", "ag='100'", "ah='100'", "ai='100'",
    "aj='0'", "ak='0'", "al='0'", "am='0'", "an='0'",
    "ao='100'", "ap='0'", "aq='0'", "ar='1'", "as='0'",
    "at='100'", "au='100'", "av='0'", "aw='100'", "ax='0'"
  ].join(' ');
  
  return `<n2 ${n2Attrs}><r ${gearRatios}/></n2>`;
}

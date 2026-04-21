import {
  getStaticCarsCatalogEntries,
  getStaticShowroomCarSpecs,
  getStaticShowroomSpecAliases,
} from "./catalog-data-source.js";

export function buildShowroomSpecCoverageReport() {
  const cars = getStaticCarsCatalogEntries();
  const specs = getStaticShowroomCarSpecs();
  const aliases = getStaticShowroomSpecAliases();
  const unresolvedCars = [];
  const invalidAliases = [];
  let directCoverage = 0;
  let aliasCoverage = 0;

  for (const car of cars) {
    const carId = String(car?.id || "");
    const aliasSpecId = String(aliases[carId] || "");

    if (Object.hasOwn(specs, carId)) {
      directCoverage += 1;
      continue;
    }

    if (aliasSpecId && Object.hasOwn(specs, aliasSpecId)) {
      aliasCoverage += 1;
      continue;
    }

    if (aliasSpecId) {
      invalidAliases.push({
        carId,
        name: car?.name || "",
        aliasSpecId,
      });
    }

    unresolvedCars.push({
      carId,
      name: car?.name || "",
    });
  }

  return {
    totalCars: cars.length,
    directCoverage,
    aliasCoverage,
    coveredCars: directCoverage + aliasCoverage,
    unresolvedCars,
    invalidAliases,
  };
}

export function logShowroomSpecCoverage(logger) {
  const report = buildShowroomSpecCoverageReport();

  if (report.unresolvedCars.length === 0 && report.invalidAliases.length === 0) {
    logger.info("Showroom spec coverage verified", {
      totalCars: report.totalCars,
      directCoverage: report.directCoverage,
      aliasCoverage: report.aliasCoverage,
      coveredCars: report.coveredCars,
    });
    return report;
  }

  logger.error("Showroom spec coverage incomplete", {
    totalCars: report.totalCars,
    directCoverage: report.directCoverage,
    aliasCoverage: report.aliasCoverage,
    coveredCars: report.coveredCars,
    unresolvedCars: report.unresolvedCars,
    invalidAliases: report.invalidAliases,
  });

  return report;
}

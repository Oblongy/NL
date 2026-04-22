import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CATALOG_DIR = ROOT / "src" / "catalog-data"
CARS_PATH = CATALOG_DIR / "cars-catalog.json"
SPECS_PATH = CATALOG_DIR / "showroom-car-specs.json"
ALIASES_PATH = CATALOG_DIR / "showroom-spec-aliases.json"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    cars = load_json(CARS_PATH)
    specs = load_json(SPECS_PATH)
    aliases = load_json(ALIASES_PATH)
    unresolved = []
    invalid_aliases = []
    direct_coverage = 0
    alias_coverage = 0

    for car in cars:
        car_id = str(car.get("id", ""))
        alias_id = str(aliases.get(car_id, ""))

        if car_id in specs:
            direct_coverage += 1
            continue

        if alias_id and alias_id in specs:
            alias_coverage += 1
            continue

        if alias_id:
            invalid_aliases.append(
                {
                    "carId": car_id,
                    "name": car.get("name", ""),
                    "aliasSpecId": alias_id,
                }
            )

        unresolved.append({"carId": car_id, "name": car.get("name", "")})

    report = {
        "totalCars": len(cars),
        "directCoverage": direct_coverage,
        "aliasCoverage": alias_coverage,
        "coveredCars": direct_coverage + alias_coverage,
        "unresolvedCars": unresolved,
        "invalidAliases": invalid_aliases,
    }

    print(json.dumps(report, indent=2))
    return 1 if unresolved or invalid_aliases else 0


if __name__ == "__main__":
    raise SystemExit(main())

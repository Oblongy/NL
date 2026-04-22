const DEFAULT_ENGINE_CONDITION_PERCENT = 100;
const LEGACY_ENGINE_CONDITION_SEQUENCE = [100, 90.69, 80.24, 70.57];
const engineConditionByCarId = new Map();

function normalizeCarId(carId) {
  const numericCarId = Number(carId || 0);
  return Number.isFinite(numericCarId) && numericCarId > 0 ? numericCarId : 0;
}

function getSequenceIndex(conditionPercent) {
  return LEGACY_ENGINE_CONDITION_SEQUENCE.findIndex(
    (value) => Math.abs(value - Number(conditionPercent || 0)) < 0.005,
  );
}

function getNextLegacyCondition(conditionPercent) {
  const sequenceIndex = getSequenceIndex(conditionPercent);
  if (sequenceIndex >= 0 && sequenceIndex < LEGACY_ENGINE_CONDITION_SEQUENCE.length - 1) {
    return LEGACY_ENGINE_CONDITION_SEQUENCE[sequenceIndex + 1];
  }

  const normalizedPercent = Number(conditionPercent || DEFAULT_ENGINE_CONDITION_PERCENT);
  return Math.max(0, Number((normalizedPercent - 9.75).toFixed(2)));
}

export function getEngineConditionPercent(carId) {
  const numericCarId = normalizeCarId(carId);
  if (!numericCarId) {
    return DEFAULT_ENGINE_CONDITION_PERCENT;
  }

  return engineConditionByCarId.get(numericCarId) ?? DEFAULT_ENGINE_CONDITION_PERCENT;
}

export function setEngineConditionPercent(carId, conditionPercent) {
  const numericCarId = normalizeCarId(carId);
  if (!numericCarId) {
    return DEFAULT_ENGINE_CONDITION_PERCENT;
  }

  const normalizedPercent = Number(conditionPercent);
  const nextValue = Number.isFinite(normalizedPercent)
    ? Math.max(0, Number(normalizedPercent.toFixed(2)))
    : DEFAULT_ENGINE_CONDITION_PERCENT;

  engineConditionByCarId.set(numericCarId, nextValue);
  return nextValue;
}

export function advanceEngineConditionForCars(carIds = []) {
  for (const carId of carIds) {
    const numericCarId = normalizeCarId(carId);
    if (!numericCarId) {
      continue;
    }

    setEngineConditionPercent(
      numericCarId,
      getNextLegacyCondition(getEngineConditionPercent(numericCarId)),
    );
  }
}

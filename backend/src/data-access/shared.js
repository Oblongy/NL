export async function maybeSingle(query, parser = (value) => value) {
  const { data, error } = await query.maybeSingle();
  if (error) {
    throw error;
  }
  return data ? parser(data) : null;
}

export async function singleResult(query, parser = (value) => value) {
  const { data, error } = await query.single();
  if (error) {
    throw error;
  }
  return parser(data);
}

export async function manyResult(query, parser = (value) => value) {
  const { data, error } = await query;
  if (error) {
    throw error;
  }
  return (data || []).map((record) => parser(record));
}

export function isMissingGameCarIdError(error) {
  const message = String(error?.message || error || "");
  return /game_car_id/i.test(message) && /not-null|null value|required/i.test(message);
}

export function isMissingTestDriveColumnError(error) {
  const message = String(error?.message || error || "");
  return /test_drive_/i.test(message) && /does not exist|unknown column|column/i.test(message);
}

export function isMissingPartsInventoryTableError(error) {
  const message = String(error?.message || error || "");
  return /game_parts_inventory/i.test(message) && /does not exist|unknown table|relation|column/i.test(message);
}

export function isMissingGameTeamMembersRelationError(error) {
  const message = String(error?.message || error || "");
  return (
    (/relation|table/i.test(message) && /does not exist/i.test(message) && /game_team_members/i.test(message))
    || (/game_team_members/i.test(message) && /does not exist/i.test(message))
  );
}

export function isMissingTableError(error, tableName) {
  const message = String(error?.message || error || "");
  return new RegExp(`\\b${tableName}\\b`, "i").test(message)
    && /(does not exist|relation|schema cache|could not find the table|unknown table)/i.test(message);
}

export function isMissingWinsLossesColumnError(error) {
  const message = String(error?.message || error || "");
  return /wins|losses/i.test(message) && /does not exist|unknown column|column/i.test(message);
}

export function toNumericIds(values = []) {
  return [...new Set(values.map((value) => Number(value)).filter((value) => value > 0))];
}

export function sortByRequestedOrder(records, ids, getRecordId) {
  const ordering = new Map(ids.map((value, index) => [value, index]));
  return [...records].sort((left, right) => {
    const leftIndex = ordering.has(getRecordId(left)) ? ordering.get(getRecordId(left)) : Number.MAX_SAFE_INTEGER;
    const rightIndex = ordering.has(getRecordId(right)) ? ordering.get(getRecordId(right)) : Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

export async function safeSelectRows(queryFactory, parser = (value) => value, missingTableNames = []) {
  try {
    return await manyResult(queryFactory(), parser);
  } catch (error) {
    if (missingTableNames.some((tableName) => isMissingTableError(error, tableName))) {
      return null;
    }
    throw error;
  }
}

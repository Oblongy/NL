import {
  buildPartsInventoryInsert,
  buildPartsInventoryPatch,
  parsePartsInventoryRecord,
} from "../db-models.js";
import {
  isMissingPartsInventoryTableError,
  manyResult,
  maybeSingle,
  singleResult,
} from "./shared.js";

export async function listPartsInventoryForPlayer(supabase, playerId) {
  if (!supabase || !playerId) {
    return [];
  }

  try {
    return await manyResult(
      supabase
        .from("game_parts_inventory")
        .select("*")
        .eq("player_id", Number(playerId))
        .order("id", { ascending: true }),
      parsePartsInventoryRecord,
    );
  } catch (error) {
    if (isMissingPartsInventoryTableError(error)) {
      return [];
    }
    throw error;
  }
}

export async function getPartInventoryItemById(supabase, inventoryId, playerId) {
  if (!supabase || !inventoryId || !playerId) {
    return null;
  }

  try {
    return await maybeSingle(
      supabase
        .from("game_parts_inventory")
        .select("*")
        .eq("id", Number(inventoryId))
        .eq("player_id", Number(playerId)),
      parsePartsInventoryRecord,
    );
  } catch (error) {
    if (isMissingPartsInventoryTableError(error)) {
      return null;
    }
    throw error;
  }
}

export async function addPartInventoryItem(supabase, playerId, partCatalogId, quantityDelta = 1) {
  if (!supabase || !playerId || !partCatalogId || quantityDelta <= 0) {
    return null;
  }

  try {
    const existing = await maybeSingle(
      supabase
        .from("game_parts_inventory")
        .select("*")
        .eq("player_id", Number(playerId))
        .eq("part_catalog_id", Number(partCatalogId)),
      parsePartsInventoryRecord,
    );

    if (existing) {
      return singleResult(
        supabase
          .from("game_parts_inventory")
          .update(buildPartsInventoryPatch({ quantity: Number(existing.quantity || 0) + Number(quantityDelta || 0) }))
          .eq("id", Number(existing.id))
          .select("*"),
        parsePartsInventoryRecord,
      );
    }

    return singleResult(
      supabase
        .from("game_parts_inventory")
        .insert(buildPartsInventoryInsert({
          playerId,
          partCatalogId,
          quantity: Number(quantityDelta || 0),
        }))
        .select("*"),
      parsePartsInventoryRecord,
    );
  } catch (error) {
    if (isMissingPartsInventoryTableError(error)) {
      return null;
    }
    throw error;
  }
}

export async function consumePartInventoryItem(supabase, inventoryId, playerId) {
  if (!supabase || !inventoryId || !playerId) {
    return null;
  }

  const item = await getPartInventoryItemById(supabase, inventoryId, playerId);
  if (!item) {
    return null;
  }

  const quantity = Number(item.quantity || 0);
  if (quantity > 1) {
    await singleResult(
      supabase
        .from("game_parts_inventory")
        .update(buildPartsInventoryPatch({ quantity: quantity - 1 }))
        .eq("id", Number(item.id))
        .select("*"),
      parsePartsInventoryRecord,
    );
  } else {
    const { error } = await supabase
      .from("game_parts_inventory")
      .delete()
      .eq("id", Number(item.id))
      .eq("player_id", Number(playerId));

    if (error) {
      throw error;
    }
  }

  return item;
}

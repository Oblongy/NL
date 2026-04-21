import {
  buildPlayerPatch,
  buildTeamInsert,
  buildTeamMemberInsert,
  buildTeamPatch,
  parseTeamMemberRecord,
  parseTeamRecord,
} from "../db-models.js";
import {
  isMissingGameTeamMembersRelationError,
  manyResult,
  maybeSingle,
  singleResult,
  sortByRequestedOrder,
  toNumericIds,
} from "./shared.js";

export async function findTeamByName(supabase, teamName) {
  if (!supabase || !teamName) {
    return null;
  }

  return maybeSingle(
    supabase
      .from("game_teams")
      .select("*")
      .ilike("name", String(teamName))
      .limit(1),
    parseTeamRecord,
  );
}

export async function createTeam(supabase, input = {}) {
  if (!supabase) {
    return null;
  }

  const insert = buildTeamInsert(input);
  if (!insert) {
    return null;
  }

  let team;
  try {
    team = await singleResult(
      supabase.from("game_teams").insert(insert).select("*"),
      parseTeamRecord,
    );
  } catch (error) {
    const message = String(error?.message || error || "");
    if (!/team_fund|column/i.test(message) || !/does not exist|unknown column/i.test(message)) {
      throw error;
    }

    const { team_fund: _ignored, ...withoutTeamFund } = insert;
    team = await singleResult(
      supabase.from("game_teams").insert(withoutTeamFund).select("*"),
      parseTeamRecord,
    );
  }

  const ownerPlayerId = Number(input.ownerPlayerId ?? input.owner_player_id || 0);
  if (team && ownerPlayerId > 0) {
    try {
      team = await updateTeamRecord(supabase, team.id, { ownerPlayerId });
    } catch (error) {
      const message = String(error?.message || error || "");
      if (!/owner_player_id/i.test(message) || !/does not exist|unknown column/i.test(message)) {
        throw error;
      }
    }
  }

  return team;
}

export async function updateTeamRecord(supabase, teamId, patchInput = {}) {
  if (!supabase || !teamId) {
    return null;
  }

  const patch = buildTeamPatch(patchInput);
  if (Object.keys(patch).length === 0) {
    return null;
  }

  try {
    return await singleResult(
      supabase
        .from("game_teams")
        .update(patch)
        .eq("id", Number(teamId))
        .select("*"),
      parseTeamRecord,
    );
  } catch (error) {
    const message = String(error?.message || error || "");
    if (/owner_player_id/i.test(message) && /does not exist|unknown column/i.test(message) && "owner_player_id" in patch) {
      const { owner_player_id: _ignored, ...withoutOwner } = patch;
      if (Object.keys(withoutOwner).length === 0) {
        return maybeSingle(
          supabase
            .from("game_teams")
            .select("*")
            .eq("id", Number(teamId)),
          parseTeamRecord,
        );
      }

      return singleResult(
        supabase
          .from("game_teams")
          .update(withoutOwner)
          .eq("id", Number(teamId))
          .select("*"),
        parseTeamRecord,
      );
    }

    throw error;
  }
}

export async function deleteTeam(supabase, teamId) {
  if (!supabase || !teamId) {
    return false;
  }

  const { error } = await supabase
    .from("game_teams")
    .delete()
    .eq("id", Number(teamId));

  if (error) {
    throw error;
  }

  return true;
}

export async function listTeamsByIds(supabase, teamIds = []) {
  if (!supabase || teamIds.length === 0) {
    return [];
  }

  const ids = toNumericIds(teamIds);
  if (ids.length === 0) {
    return [];
  }

  const teams = await manyResult(
    supabase
      .from("game_teams")
      .select("*")
      .in("id", ids),
    parseTeamRecord,
  );
  return sortByRequestedOrder(teams, ids, (team) => team.id);
}

export async function listTeamMembersForTeams(supabase, teamIds = []) {
  if (!supabase || teamIds.length === 0) {
    return [];
  }

  const ids = toNumericIds(teamIds);
  if (ids.length === 0) {
    return [];
  }

  return manyResult(
    supabase
      .from("game_team_members")
      .select("*")
      .in("team_id", ids)
      .order("team_id", { ascending: true })
      .order("contribution_score", { ascending: false })
      .order("joined_at", { ascending: true }),
    parseTeamMemberRecord,
  );
}

export async function getTeamMembershipByPlayerId(supabase, playerId) {
  if (!supabase || !playerId) {
    return null;
  }

  try {
    return await maybeSingle(
      supabase
        .from("game_team_members")
        .select("*")
        .eq("player_id", Number(playerId)),
      parseTeamMemberRecord,
    );
  } catch (error) {
    if (isMissingGameTeamMembersRelationError(error)) {
      return null;
    }

    const message = String(error?.message || error || "");
    if (/role/i.test(message) && /does not exist|unknown column|column/i.test(message)) {
      try {
        return await maybeSingle(
          supabase
            .from("game_team_members")
            .select("id, team_id, player_id, contribution_score, joined_at, updated_at")
            .eq("player_id", Number(playerId)),
          parseTeamMemberRecord,
        );
      } catch (compatError) {
        if (isMissingGameTeamMembersRelationError(compatError)) {
          return null;
        }
        throw compatError;
      }
    }

    throw error;
  }
}

export async function syncGameTeamMemberRow(supabase, playerId, teamId, options = {}) {
  if (!supabase || !playerId) {
    return false;
  }

  try {
    const { error: deleteError } = await supabase
      .from("game_team_members")
      .delete()
      .eq("player_id", Number(playerId));

    if (deleteError) {
      throw deleteError;
    }
  } catch (error) {
    if (isMissingGameTeamMembersRelationError(error)) {
      return false;
    }
    throw error;
  }

  const numericTeamId = Number(teamId || 0);
  if (numericTeamId <= 0) {
    return true;
  }

  const insert = buildTeamMemberInsert({
    teamId: numericTeamId,
    playerId,
    role: options.dbMemberRole || options.role,
  });

  let insertError = null;
  try {
    ({ error: insertError } = await supabase
      .from("game_team_members")
      .insert(insert));
  } catch (error) {
    insertError = error;
  }

  const insertMessage = String(insertError?.message || insertError || "");
  if (insertError && /role/i.test(insertMessage) && /does not exist|unknown column|column/i.test(insertMessage)) {
    const { role: _ignored, ...withoutRole } = insert;
    ({ error: insertError } = await supabase
      .from("game_team_members")
      .insert(withoutRole));
  }

  if (insertError) {
    if (isMissingGameTeamMembersRelationError(insertError)) {
      return false;
    }
    throw insertError;
  }

  return true;
}

export async function setPlayerTeamMembership(supabase, playerId, team, membershipOptions = {}) {
  if (!supabase || !playerId) {
    return false;
  }

  const patch = buildPlayerPatch({
    teamId: team ? Number(team.id) : null,
    teamName: team ? String(team.name || "") : "",
  });

  const { error } = await supabase
    .from("game_players")
    .update(patch)
    .eq("id", Number(playerId));

  if (error) {
    throw error;
  }

  await syncGameTeamMemberRow(supabase, playerId, team ? Number(team.id) : 0, membershipOptions);
  return true;
}

export async function listLeaderboardTeams(supabase) {
  if (!supabase) {
    return [];
  }

  return manyResult(
    supabase
      .from("game_teams")
      .select("*"),
    parseTeamRecord,
  );
}

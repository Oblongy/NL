#!/usr/bin/env node

/**
 * Check team data in the database
 */

import { createGameSupabase } from '../src/supabase-client.js';
import { config } from '../src/config.js';

const logger = {
  info: console.log,
  warn: console.warn,
  error: console.error
};

async function checkTeams() {
  console.log('Checking teams...\n');
  
  const supabase = await createGameSupabase(config, logger);
  
  if (!supabase) {
    console.error('Error: Could not connect to Supabase. Check your .env configuration.');
    process.exit(1);
  }
  
  try {
    // Get all teams
    const { data: teams, error: teamsError } = await supabase
      .from('game_teams')
      .select('*')
      .order('id');
    
    if (teamsError) {
      console.error('Error fetching teams:', teamsError);
      process.exit(1);
    }
    
    console.log(`Found ${teams.length} team(s):\n`);
    teams.forEach(team => {
      console.log(`Team ID: ${team.id}`);
      console.log(`  Name: "${team.name}" ${team.name === '' ? '(EMPTY!)' : ''}`);
      console.log(`  Score: ${team.score}`);
      console.log(`  Team Fund: ${team.team_fund}`);
      console.log(`  Wins/Losses: ${team.wins}/${team.losses}`);
      console.log(`  Created: ${team.created_at}`);
      console.log('');
    });
    
    // Get all team members
    const { data: members, error: membersError } = await supabase
      .from('game_team_members')
      .select('*')
      .order('team_id');
    
    if (membersError) {
      console.error('Error fetching members:', membersError);
      process.exit(1);
    }
    
    console.log(`\nFound ${members.length} team member(s):\n`);
    members.forEach(member => {
      console.log(`Member ID: ${member.id}`);
      console.log(`  Team ID: ${member.team_id}`);
      console.log(`  Player ID: ${member.player_id}`);
      console.log(`  Contribution: ${member.contribution_score}`);
      console.log(`  Joined: ${member.joined_at}`);
      console.log('');
    });
    
    // Get players with team assignments
    const { data: players, error: playersError } = await supabase
      .from('game_players')
      .select('id, username, team_id, team_name')
      .not('team_id', 'is', null);
    
    if (playersError) {
      console.error('Error fetching players:', playersError);
    } else {
      console.log(`\nFound ${players.length} player(s) with team assignments:\n`);
      players.forEach(player => {
        console.log(`Player: ${player.username} (ID: ${player.id})`);
        console.log(`  Team ID: ${player.team_id}`);
        console.log(`  Team Name: "${player.team_name}" ${player.team_name === '' ? '(EMPTY!)' : ''}`);
        console.log('');
      });
    }
    
  } catch (err) {
    console.error('Unexpected error:', err);
    process.exit(1);
  }
}

checkTeams();

#!/usr/bin/env node

/**
 * Race Flow Diagnostic Tool
 * 
 * This script helps diagnose multiplayer racing issues by simulating
 * the complete race flow and validating server responses.
 */

import { createConnection } from 'node:net';
import { decodePayload, encryptPayload } from './src/nitto-cipher.js';

const MESSAGE_DELIMITER = '\x04';
const FIELD_DELIMITER = '\x1e';

class RaceFlowTester {
  constructor({ host = '127.0.0.1', port = 3724, sessionKey1, sessionKey2 }) {
    this.host = host;
    this.port = port;
    this.sessionKey1 = sessionKey1;
    this.sessionKey2 = sessionKey2;
    this.connections = new Map();
    this.raceGuid = null;
  }

  async connect(name, sessionKey) {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port }, () => {
        console.log(`[${name}] Connected to ${this.host}:${this.port}`);
        
        const conn = {
          name,
          socket,
          buffer: '',
          sessionKey,
          messages: [],
        };

        socket.on('data', (data) => {
          conn.buffer += data.toString('latin1');
          const messages = conn.buffer.split(MESSAGE_DELIMITER);
          conn.buffer = messages.pop() || '';
          
          for (const msg of messages) {
            if (msg.length > 0) {
              this.handleMessage(conn, msg);
            }
          }
        });

        socket.on('error', (error) => {
          console.error(`[${name}] Socket error:`, error.message);
          reject(error);
        });

        socket.on('close', () => {
          console.log(`[${name}] Connection closed`);
        });

        this.connections.set(name, conn);
        resolve(conn);
      });
    });
  }

  handleMessage(conn, rawMessage) {
    try {
      let decoded = rawMessage;
      try {
        const result = decodePayload(rawMessage);
        decoded = result.decoded;
      } catch {
        // Plain text message
      }

      const parts = decoded.split(FIELD_DELIMITER);
      const messageType = parts[0];

      console.log(`[${conn.name}] ← ${messageType}`, parts.slice(1, 5).join(' | '));
      conn.messages.push({ type: messageType, parts, raw: rawMessage, decoded });

      // Auto-extract race GUID from RCLG
      if (messageType === 'ac' && parts[1] === 'RCLG') {
        const xml = parts[3] || '';
        const match = xml.match(/r='([0-9a-f-]+)'/i);
        if (match) {
          this.raceGuid = match[1];
          console.log(`[${conn.name}] 🏁 Race GUID extracted: ${this.raceGuid}`);
        }
      }
    } catch (error) {
      console.error(`[${conn.name}] Message parse error:`, error.message);
    }
  }

  sendMessage(conn, message) {
    const seed = Math.floor(Math.random() * 90) + 10;
    const encrypted = encryptPayload(message, seed);
    conn.socket.write(Buffer.from(encrypted + MESSAGE_DELIMITER, 'latin1'));
    
    const parts = message.split(FIELD_DELIMITER);
    console.log(`[${conn.name}] → ${parts[0]}`, parts.slice(1, 5).join(' | '));
  }

  async wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async runTest() {
    console.log('\n=== Race Flow Test Starting ===\n');

    try {
      // Phase 1: Connect both players
      console.log('Phase 1: Connecting players...');
      const player1 = await this.connect('Player1', this.sessionKey1);
      const player2 = await this.connect('Player2', this.sessionKey2);
      await this.wait(500);

      // Phase 2: Login
      console.log('\nPhase 2: Logging in...');
      this.sendMessage(player1, `L${FIELD_DELIMITER}${this.sessionKey1}`);
      this.sendMessage(player2, `L${FIELD_DELIMITER}${this.sessionKey2}`);
      await this.wait(1000);

      // Phase 3: Get room list
      console.log('\nPhase 3: Getting room list...');
      this.sendMessage(player1, 'LRCR2');
      this.sendMessage(player2, 'LRCR2');
      await this.wait(500);

      // Phase 4: Join room
      console.log('\nPhase 4: Joining room...');
      this.sendMessage(player1, `JRC${FIELD_DELIMITER}1${FIELD_DELIMITER}1`);
      this.sendMessage(player2, `JRC${FIELD_DELIMITER}1${FIELD_DELIMITER}1`);
      await this.wait(1000);

      // Phase 5: Get race
      console.log('\nPhase 5: Getting race...');
      this.sendMessage(player1, 'GR');
      this.sendMessage(player2, 'GR');
      await this.wait(500);

      // Phase 6: Player 1 challenges Player 2
      console.log('\nPhase 6: Player 1 challenges Player 2...');
      // RRQ format: RRQ <requesterCarId> <targetPlayerId> <targetCarId> <lane> <bracketTime>
      this.sendMessage(player1, `RRQ${FIELD_DELIMITER}1${FIELD_DELIMITER}2${FIELD_DELIMITER}1${FIELD_DELIMITER}1${FIELD_DELIMITER}-1`);
      await this.wait(1000);

      if (!this.raceGuid) {
        console.error('❌ FAILED: No race GUID received in RCLG');
        return false;
      }

      // Phase 7: Player 2 accepts challenge
      console.log('\nPhase 7: Player 2 accepts challenge...');
      this.sendMessage(player2, `RRS${FIELD_DELIMITER}${this.raceGuid}`);
      await this.wait(500);

      // Phase 8: Player 1 confirms ready
      console.log('\nPhase 8: Player 1 confirms ready...');
      this.sendMessage(player1, `RRS${FIELD_DELIMITER}${this.raceGuid}`);
      await this.wait(1000);

      // Phase 9: Open race channels (SRC)
      console.log('\nPhase 9: Opening race channels...');
      const raceChannel1 = await this.connect('Player1-Race', this.sessionKey1);
      const raceChannel2 = await this.connect('Player2-Race', this.sessionKey2);
      await this.wait(500);

      this.sendMessage(raceChannel1, `SRC${FIELD_DELIMITER}${this.sessionKey1}${FIELD_DELIMITER}${this.raceGuid}`);
      this.sendMessage(raceChannel2, `SRC${FIELD_DELIMITER}${this.sessionKey2}${FIELD_DELIMITER}${this.raceGuid}`);
      await this.wait(1000);

      // Phase 10: Send test I packets
      console.log('\nPhase 10: Sending test I packets...');
      for (let i = 0; i < 5; i++) {
        const distance = -13 + i * 10;
        const velocity = i * 50;
        const acceleration = 30;
        const frame = i * 100;
        
        this.sendMessage(raceChannel1, `I${FIELD_DELIMITER}${distance}${FIELD_DELIMITER}${velocity}${FIELD_DELIMITER}${acceleration}${FIELD_DELIMITER}${frame}`);
        this.sendMessage(raceChannel2, `I${FIELD_DELIMITER}${distance}${FIELD_DELIMITER}${velocity}${FIELD_DELIMITER}${acceleration}${FIELD_DELIMITER}${frame}`);
        await this.wait(100);
      }

      console.log('\n=== Race Flow Test Complete ===\n');
      
      // Validate results
      const player1IPackets = player1.messages.filter(m => m.type === 'I').length;
      const player2IPackets = player2.messages.filter(m => m.type === 'I').length;
      const race1IPackets = raceChannel1.messages.filter(m => m.type === 'I').length;
      const race2IPackets = raceChannel2.messages.filter(m => m.type === 'I').length;

      console.log('Results:');
      console.log(`  Player1 lobby received I packets: ${player1IPackets}`);
      console.log(`  Player2 lobby received I packets: ${player2IPackets}`);
      console.log(`  Player1 race channel received I packets: ${race1IPackets}`);
      console.log(`  Player2 race channel received I packets: ${race2IPackets}`);

      if (race1IPackets >= 4 && race2IPackets >= 4) {
        console.log('\n✅ SUCCESS: I packets are being forwarded correctly!');
        return true;
      } else {
        console.log('\n❌ FAILED: I packets not forwarded correctly');
        return false;
      }

    } catch (error) {
      console.error('\n❌ Test failed with error:', error.message);
      return false;
    } finally {
      // Cleanup
      await this.wait(1000);
      for (const [name, conn] of this.connections) {
        try {
          conn.socket.end();
        } catch {}
      }
    }
  }
}

// Run test if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const sessionKey1 = process.env.TEST_SESSION_KEY_1 || 'test-session-1';
  const sessionKey2 = process.env.TEST_SESSION_KEY_2 || 'test-session-2';
  const host = process.env.TCP_HOST || '127.0.0.1';
  const port = parseInt(process.env.TCP_PORT || '3724', 10);

  console.log('Configuration:');
  console.log(`  Host: ${host}`);
  console.log(`  Port: ${port}`);
  console.log(`  Session Key 1: ${sessionKey1}`);
  console.log(`  Session Key 2: ${sessionKey2}`);
  console.log('');

  const tester = new RaceFlowTester({ host, port, sessionKey1, sessionKey2 });
  tester.runTest().then(success => {
    process.exit(success ? 0 : 1);
  });
}

export { RaceFlowTester };

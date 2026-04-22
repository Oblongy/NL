# Multiplayer Racing Fix - Deployment Checklist

## Pre-Deployment

### Code Review
- [x] All changes reviewed and tested locally
- [x] No syntax errors (`node --check src/tcp-server.js`)
- [x] No ESLint/TypeScript diagnostics
- [x] Code follows existing patterns and conventions

### Documentation
- [x] Technical documentation created (MULTIPLAYER_RACE_FIXES.md)
- [x] Summary document created (RACE_FIX_SUMMARY.md)
- [x] Protocol reference created (RACE_PROTOCOL_QUICK_REF.md)
- [x] Test tool created (test-race-flow.js)

### Testing Preparation
- [ ] Test environment configured
- [ ] Test session keys generated
- [ ] Test Flash clients available
- [ ] Monitoring tools ready

## Deployment Steps

### 1. Backup Current Version
```bash
# Backup the current tcp-server.js
cp backend/src/tcp-server.js backend/src/tcp-server.js.backup.$(date +%Y%m%d_%H%M%S)

# Backup logs
cp backend/live.log backend/live.log.backup.$(date +%Y%m%d_%H%M%S)
```

### 2. Deploy Changes
```bash
# Pull latest changes
git pull origin main

# Install dependencies (if needed)
cd backend
npm install

# Verify syntax
node --check src/tcp-server.js
```

### 3. Restart Server
```bash
# Stop current server
pm2 stop backend

# Start with new code
pm2 start ecosystem.config.cjs

# Verify it's running
pm2 status
pm2 logs backend --lines 50
```

### 4. Verify Deployment
```bash
# Check server is listening
netstat -an | grep 3724

# Check logs for startup messages
tail -f backend/live.log | grep "TCP server listening"
```

## Post-Deployment Testing

### Automated Tests
```bash
# Set test credentials
export TEST_SESSION_KEY_1="your-test-session-1"
export TEST_SESSION_KEY_2="your-test-session-2"

# Run race flow test
node backend/test-race-flow.js

# Expected output: ✅ SUCCESS: I packets are being forwarded correctly!
```

### Manual Testing - Basic Flow
1. [ ] Connect two Flash clients
2. [ ] Both players login successfully
3. [ ] Both players see room list (LRCR2)
4. [ ] Both players join same room (JRC)
5. [ ] Both players appear in room user list
6. [ ] Chat messages work between players

### Manual Testing - Race Flow
1. [ ] Player 1 challenges Player 2 (RRQ)
2. [ ] Player 2 receives challenge notification (RCLG)
3. [ ] Player 2 accepts challenge (RRS)
4. [ ] Both players receive race setup (RN, RRA)
5. [ ] Race channels open successfully (SRC)
6. [ ] Countdown/staging works
7. [ ] Both cars move during race
8. [ ] Position sync is smooth (no stuttering)
9. [ ] Race completes successfully
10. [ ] Results displayed correctly
11. [ ] Both players return to room

### Manual Testing - Edge Cases
1. [ ] Player disconnects during challenge
2. [ ] Player disconnects during race
3. [ ] Multiple concurrent races in different rooms
4. [ ] Rapid challenge/cancel cycles
5. [ ] Race with high latency connection

## Monitoring

### Key Metrics to Watch
```bash
# Monitor I/S packet forwarding
tail -f backend/live.log | grep "TCP forwarded I/S packet"

# Monitor race creation
tail -f backend/live.log | grep "TCP race"

# Monitor errors
tail -f backend/live.log | grep -i error

# Monitor connection count
tail -f backend/live.log | grep "TCP connection"
```

### Success Indicators
- [ ] No "I/S packet received without active race" warnings
- [ ] No "RRS received from unknown race player" warnings
- [ ] No "TCP I/S forward error" messages
- [ ] I/S packets being forwarded at ~30 Hz during races
- [ ] Race cleanup happening after both RD messages

### Failure Indicators
- [ ] Repeated connection errors
- [ ] I/S packets not being forwarded
- [ ] Race objects not being cleaned up
- [ ] Memory usage increasing over time
- [ ] Players stuck in race state

## Performance Monitoring

### Resource Usage
```bash
# CPU usage
pm2 monit

# Memory usage
pm2 show backend

# Connection count
netstat -an | grep 3724 | wc -l
```

### Expected Performance
- CPU: < 10% per active race
- Memory: < 100MB base + ~1MB per active race
- Connections: 2 per player (lobby + race channel during race)
- I/S packet latency: < 50ms

## Rollback Plan

### If Issues Detected
```bash
# Stop current server
pm2 stop backend

# Restore backup
cp backend/src/tcp-server.js.backup.YYYYMMDD_HHMMSS backend/src/tcp-server.js

# Restart with old code
pm2 start ecosystem.config.cjs

# Verify rollback
pm2 logs backend --lines 50
```

### Rollback Verification
- [ ] Server starts successfully
- [ ] Players can connect
- [ ] Basic functionality works
- [ ] No new errors in logs

## Troubleshooting

### Issue: Server won't start
**Check:**
- Syntax errors: `node --check src/tcp-server.js`
- Port already in use: `netstat -an | grep 3724`
- Dependencies installed: `npm install`
- Logs: `pm2 logs backend`

### Issue: Players can't connect
**Check:**
- Server listening: `netstat -an | grep 3724`
- Firewall rules
- Client configuration (host/port)
- Logs: `tail -f backend/live.log | grep "TCP connection"`

### Issue: Races not starting
**Check:**
- Challenge flow: `tail -f backend/live.log | grep "RRQ\|RCLG\|RRS"`
- Race creation: `tail -f backend/live.log | grep "TCP race"`
- Connection count per player (should be 2 during race)

### Issue: Cars not moving
**Check:**
- I/S forwarding: `tail -f backend/live.log | grep "TCP forwarded I/S"`
- Race channel connections: `tail -f backend/live.log | grep "SRC"`
- Race object state in memory (use debugger)

## Sign-Off

### Deployment Completed By
- Name: ________________
- Date: ________________
- Time: ________________

### Testing Completed By
- Name: ________________
- Date: ________________
- Time: ________________

### Issues Found
- [ ] None
- [ ] Minor (documented below)
- [ ] Major (rollback initiated)

### Notes
```
[Add any deployment notes, issues, or observations here]
```

## Next Steps

### Short Term (1-7 days)
- [ ] Monitor logs daily for errors
- [ ] Collect player feedback
- [ ] Track race completion rate
- [ ] Measure performance metrics

### Medium Term (1-4 weeks)
- [ ] Implement spectator mode
- [ ] Add tournament support
- [ ] Improve error handling
- [ ] Add reconnection support

### Long Term (1-3 months)
- [ ] Add race replay recording
- [ ] Implement anti-cheat validation
- [ ] Optimize I/S packet handling
- [ ] Add race analytics

## Contact Information

### Support Channels
- GitHub Issues: [repository URL]
- Discord: [server invite]
- Email: [support email]

### On-Call
- Primary: [name/contact]
- Secondary: [name/contact]
- Escalation: [name/contact]

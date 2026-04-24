# TCP Port Configuration

## Issue
The Nitto Legends client is hardcoded to connect to TCP port **3724** for real-time features (buddies list, notifications, race invites).

However, port 3724 is commonly used by Blizzard services (World of Warcraft, Battle.net Agent), which may conflict with the backend TCP server.

## Current Configuration
The backend TCP server is currently configured to use port **7724** (see `backend/.env`).

## Solutions

### Option 1: Stop Blizzard Services (Temporary)
If you have Blizzard games installed, you can temporarily stop the Blizzard Agent service:

1. Open Services (Win+R, type `services.msc`)
2. Find "Blizzard Update Agent" or similar
3. Right-click → Stop
4. Update `backend/.env`: `TCP_PORT=3724`
5. Restart the backend server

**Note:** This will prevent Blizzard games from updating while the service is stopped.

### Option 2: Port Forwarding (Recommended)
Use Windows port forwarding to redirect port 3724 to 7724:

```powershell
# Run as Administrator
netsh interface portproxy add v4tov4 listenport=3724 listenaddress=127.0.0.1 connectport=7724 connectaddress=127.0.0.1
```

To remove the port forwarding later:
```powershell
netsh interface portproxy delete v4tov4 listenport=3724 listenaddress=127.0.0.1
```

To view current port forwarding rules:
```powershell
netsh interface portproxy show all
```

### Option 3: Modify Client Configuration
If the client has a configuration file that specifies the TCP port, you can change it to 7724.

## Current Status
- HTTP Server: `127.0.0.1:8082` ✅ Working
- TCP Server: `127.0.0.1:7724` ✅ Listening
- Client expects: `127.0.0.1:3724` ⚠️ Port mismatch

## Testing TCP Connection
Once port forwarding is configured, you can test the TCP connection:

```powershell
# Test if port 3724 is accessible
Test-NetConnection -ComputerName 127.0.0.1 -Port 3724
```

The backend will log TCP connections in `backend/live.log`:
- `TCP connection opened` - Client connected
- `TCP message received` - Client sent a message
- `TCP login complete` - Client authenticated via TCP

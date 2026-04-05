# TCP Port Configuration

## Recommended Binding Split

For a Linux VPS deployment:

- `HTTP_HOST=127.0.0.1`
- `PORT=8082`
- `TCP_HOST=0.0.0.0`
- `TCP_PORT=3724`

This keeps the HTTP backend private behind `nginx` while allowing the game client to reach the TCP listener directly.

## Why This Split

The Nitto Legends client expects direct TCP access for real-time features such as buddies, notifications, and race invites. `nginx` should proxy the HTTP backend, but it should not sit in front of the game TCP port unless you explicitly build that path.

## Firewall Expectations

Open only the ports you need:

- `80/tcp` for HTTP
- `443/tcp` for HTTPS if enabled
- `3724/tcp` for the game TCP connection

Keep port `8082` closed to the public internet when `nginx` is proxying to `127.0.0.1:8082`.

## Verification

```bash
curl http://127.0.0.1:8082/healthz
sudo ss -tulpn | grep -E '8082|3724|80|443'
sudo ufw status
sudo nginx -t
```

Expected result:

- HTTP server listening on `127.0.0.1:8082`
- TCP server listening on `0.0.0.0:3724`
- `nginx` listening on `80` or `443`

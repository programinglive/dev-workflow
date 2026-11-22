# Troubleshooting Optional Authentication (Zettly & Companion)

> **Reminder:** DevWorkflow works 100% locally without Zettly or any external account. Authentication troubleshooting only applies if you opted into an integration.

## Zettly Connection Fails (HTTP 401 / 403 / Network Timeout)
1. Check your current status without exposing tokens:
   ```bash
   devwf zettly status
   devwf zettly doctor
   ```
2. Verify your instance URL uses HTTPS (`https://your-zettly-instance.example`).
3. Reconnect using a fresh personal access token via interactive hidden prompt or `--token-stdin`:
   ```bash
   devwf zettly switch --url https://your-zettly-instance.example --confirm
   ```
4. To return to offline local-first mode at any time (preserving all local history):
   ```bash
   devwf zettly disconnect --confirm
   ```

## Android Companion Pairing Rejected
- Ensure the pairing QR challenge has not expired and your Android device can reach your workstation/monitor over your trusted LAN or VPN. Never expose unauthenticated development services directly to the public internet.

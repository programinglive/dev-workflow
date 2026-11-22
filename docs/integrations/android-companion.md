# DevWorkflow Android Companion

**Optional remote engineering cockpit for supported Android devices.**

The DevWorkflow Android Companion (`mobile-app/`) is an **optional** mobile client for monitoring live agent sessions, inspecting task contracts, and approving governance gates away from your keyboard. **You do not need an Android device or a specific tablet to use DevWorkflow.**

## Compatibility & Tested Devices
- **Device-Agnostic Design:** Supports adaptive layouts for compact phones, medium tablets, and large landscape tablets.
- **Tested Reference Layout:** Landscape desk cockpit verified on Xiaomi Pad 6 (`2880×1800`). Other Android devices adapt automatically based on viewport breakpoints.
- **Requirements:** Android device with network reachability to your DevWorkflow monitor over your trusted LAN or private VPN.

## Connecting Safely
1. Start your local or LAN DevWorkflow monitor service.
2. Generate an ephemeral cryptographic pairing challenge on your workstation:
   ```bash
   devwf pair --url http://<your-lan-host>:3100
   ```
3. Scan the QR code from the DevWorkflow Android Companion app to complete the device-key handshake.
4. Monitor live SSE session streams, review diffs, approve gates, or trigger Emergency Stop.
5. Unpair and revoke device access anytime from your monitor settings.

> **Security Note:** Never expose unauthenticated development monitor endpoints directly to the public internet. Use trusted LAN or authenticated private VPN tunnels.

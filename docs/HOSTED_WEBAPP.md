# Hosted Webapp Deployment

`voxhf-hosted-webapp` contains static browser files only. It does not contain a
relay, database, local agent, or IVAO-facing proxy and cannot operate by itself.

Serve the `webapp` directory from an HTTPS origin allowed by the target VoxHF
relay. The supplied Docker/Caddy deployment in the Server package already does
this. Other static hosts must preserve normal HTML, JavaScript, CSS, JSON, and
image content types, serve `manifest.webmanifest` with a manifest/JSON content
type, and avoid long-lived caching for `release.json`, `sw.js`, and
`manifest.webmanifest`.

The browser connects to the relay with WSS. Never expose local ports `4827`,
`6809`, `8767`, or `3000` through the hosted webapp deployment.

The hosted page does not own chat history or normal Push delivery. After each refresh
or reconnect it requests the current session history from the selected local
agent, independently of notification permission. Push subscriptions are
transported live through the relay and stored by that local agent. A device may
separately opt into the remote PC/proxy offline alert; its confirmation explains
that the local proxy then places a short-lived, already encrypted and signed
Push request in relay memory for one-time delivery if the agent disappears.

After deployment follow the [User Guide](USER_GUIDE.md) from login through the
multi-device, voice, command, weather, and notification checks. At minimum,
verify two simultaneous browsers and a real incoming private Push notification
on one supported locked phone or tablet.

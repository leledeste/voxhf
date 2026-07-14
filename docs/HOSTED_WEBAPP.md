# Hosted Webapp Deployment

`voxhf-hosted-webapp` contains static browser files only. It does not contain a
relay, database, local agent, or IVAO-facing proxy and cannot operate by itself.

Serve the `webapp` directory from an HTTPS origin allowed by the target VoxHF
relay. The supplied Docker/Caddy deployment in the Server package already does
this. Other static hosts must preserve normal HTML, JavaScript, CSS, JSON, and
image content types and must not cache `release.json` permanently.

The directory page calls `/directory/api/servers` on the public site origin.
Static-only deployments may omit that route; the page then shows the directory
as unavailable without affecting login or the operational workspace.

The browser connects to the relay with WSS. Never expose local ports `4827`,
`6809`, `8767`, or `3000` through the hosted webapp deployment.

After deployment verify login, refresh persistence, two simultaneous browsers,
COM/XPDR/chat commands, RX audio, and microphone TX with a connected local
agent.

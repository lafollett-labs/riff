/*
 * Standalone usage poller — Riff's window feed without a Claude session.
 *
 * The MCP server embeds this same poll (see server.ts), but that only runs
 * while a session holds the MCP. Riff's core runs on its own; the one thing
 * that needs the host's interactive login is the rate-limit window read, and
 * this daemon is how it keeps flowing 24/7 with no session up — run it from a
 * launchd user-agent (scripts/usage-poller.sh) so the throttle never goes
 * blind. Same credential path and cadence as the MCP; see usagePoll.ts.
 */
import { RiffClient, normalizeBase } from './client.ts';
import { startUsagePolling } from './usagePoll.ts';

const client = new RiffClient(normalizeBase(process.env['RIFF_API']));
startUsagePolling(client, process.env['RIFF_USAGE_POLL_MS']
  ? { intervalMs: Number(process.env['RIFF_USAGE_POLL_MS']) } : {});
process.stderr.write('[usage-daemon] polling started\n');

// The poll interval is unref'd so it cannot hold the loop by itself; this is
// what keeps the daemon alive. SIGTERM (launchd stop, or a kill) ends it.
const keepAlive = setInterval(() => {}, 1 << 30);
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { clearInterval(keepAlive); process.exit(0); });
}

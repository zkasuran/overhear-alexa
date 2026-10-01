// Poll a URL until it returns 2xx or the timeout elapses. Used by verify.sh to wait for the server.
// Usage: node scripts/wait-for.mjs <url> [timeoutSeconds]
const url = process.argv[2];
const timeoutS = Number(process.argv[3] ?? "30");
if (!url) {
  console.error("usage: wait-for.mjs <url> [timeoutSeconds]");
  process.exit(2);
}
const deadline = Date.now() + timeoutS * 1000;
let lastErr = "";
while (Date.now() < deadline) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      console.log(`up: ${url} (${res.status})`);
      process.exit(0);
    }
    lastErr = `status ${res.status}`;
  } catch (e) {
    lastErr = e instanceof Error ? e.message : String(e);
  }
  await new Promise((r) => setTimeout(r, 400));
}
console.error(`timed out waiting for ${url} after ${timeoutS}s: ${lastErr}`);
process.exit(1);

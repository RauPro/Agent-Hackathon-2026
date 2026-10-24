export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.VERCEL !== "1") {
    const { startNetworkWorker } = await import("./lib/server/network-worker");
    startNetworkWorker();
  }
}

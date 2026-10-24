export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startNetworkWorker } = await import("./lib/server/network-worker");
    startNetworkWorker();
  }
}

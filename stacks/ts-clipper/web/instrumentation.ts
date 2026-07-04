export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { sweepScratchDir } = await import('./lib/sweep');
    const removed = await sweepScratchDir();
    if (removed.length > 0) {
      console.log(`[startup sweep] removed ${removed.length} stale scratch file(s):`, removed);
    }
  }
}

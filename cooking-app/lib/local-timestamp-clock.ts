export function createLocalTimestampClock(
  monotonicClock: Pick<Performance, "now" | "timeOrigin"> = performance,
  wallClock: () => number = () => Date.now(),
) {
  let epochOrigin = monotonicClock.timeOrigin;
  let lastTimestamp = Math.floor(epochOrigin + monotonicClock.now());

  const now = () => {
    lastTimestamp = Math.max(lastTimestamp, Math.floor(epochOrigin + monotonicClock.now()));
    return lastTimestamp;
  };

  const resume = () => {
    const monotonicNow = monotonicClock.now();
    // Some mobile browsers pause the monotonic clock during device sleep.
    // Reconcile forward on resume while never allowing wall-clock rollback.
    epochOrigin = Math.max(epochOrigin, wallClock() - monotonicNow);
    return now();
  };

  return { now, resume };
}

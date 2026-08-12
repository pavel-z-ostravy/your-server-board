const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatUptime(seconds) {
  if (seconds >= DAY) {
    const days = Math.floor(seconds / DAY);
    const hours = Math.floor((seconds % DAY) / HOUR);
    return `${days}d ${hours}h`;
  }
  if (seconds >= HOUR) {
    const hours = Math.floor(seconds / HOUR);
    const minutes = Math.floor((seconds % HOUR) / MINUTE);
    return `${hours}h ${minutes}m`;
  }
  if (seconds >= MINUTE) {
    const minutes = Math.floor(seconds / MINUTE);
    return `${minutes}m`;
  }
  if (seconds === 0) {
    return "0m";
  }
  return `${seconds}s`;
}

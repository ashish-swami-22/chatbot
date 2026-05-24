export function recordMetric(name: string, value: number, tags: Record<string, string> = {}) {
  console.log(JSON.stringify({ metric: name, value, tags, ts: new Date().toISOString() }));
}

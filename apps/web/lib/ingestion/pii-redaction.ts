export function redactPii(value: unknown) {
  const input = typeof value === "string" ? value : JSON.stringify(value);
  return input
    .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, "[redacted-email]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[redacted-phone]");
}

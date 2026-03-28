/** E2E multi-file test: string utilities */
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function reverse(s: string): string {
  return s.split("").reverse().join("");
}

export function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}

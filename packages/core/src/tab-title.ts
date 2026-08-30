export function titleForUrl(u: string): string {
  try {
    return new URL(u).hostname || u;
  } catch {
    return u;
  }
}

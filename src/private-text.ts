export function containsPrivateMetadata(value: string): boolean {
  return /(?:password|passwd|token|secret|api[_-]?key|authorization|credential|login|private[_-]?key)\s*[:=]/iu.test(value)
    || /\bbearer\s+\S+/iu.test(value)
    || /\/(?:home|Users|root)\//u.test(value)
    || /^(?:[$#>]\s*)?(?:sudo\b|command\s*:)/iu.test(value)
    || /^[$#>]\s*\S+/u.test(value)
    || /[$#>]\s*(?:cat|ssh|tail|less|rm|bash|sh|zsh|fish|curl|wget)\b/iu.test(value)
    || value.includes(`${String.fromCharCode(27)}[`)
    || /(?:last login:|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----)/iu.test(value);
}

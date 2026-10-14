/**
 * Passphrase strength (PRD-encryption §5): the same rules as minotes-core
 * `crypto::passphrase_strength`, which is what the backend enforces. 0 weak … 4
 * strong; the minimum accepted is "fair" (2). Not zxcvbn — a small estimate that
 * refuses trivially guessable choices and rewards length.
 */

const COMMON = [
  "password", "passw0rd", "123456", "12345678", "123456789", "qwerty", "qwertyuiop", "letmein",
  "iloveyou", "admin", "welcome", "monkey", "dragon", "football", "baseball", "abc123", "111111",
  "sunshine", "princess", "trustno1", "secret", "minotes", "changeme", "000000",
];

export const MIN_STRENGTH = 2;
export const STRENGTH_LABELS = ["Very weak", "Weak", "Fair", "Good", "Strong"] as const;

export function passphraseStrength(pass: string): number {
  const lower = pass.toLowerCase();
  if (!lower.trim() || COMMON.some(c => lower === c || lower.replace(/[0-9!]+$/, "") === c)) return 0;
  const chars = Array.from(pass);
  const distinct = new Set(chars).size;
  const classes = [
    chars.some(c => c !== c.toUpperCase()),
    chars.some(c => c !== c.toLowerCase()),
    chars.some(c => /[0-9]/.test(c)),
    chars.some(c => !/[\p{L}\p{N}\s]/u.test(c)),
    chars.some(c => /\s/.test(c)),
  ].filter(Boolean).length;
  const pool = classes <= 1 ? 26 : classes === 2 ? 36 : classes === 3 ? 62 : 80;
  const effLen = Math.min(chars.length, distinct * 3);
  const bits = effLen * Math.log2(pool);
  if (bits < 28) return 0;
  if (bits < 40) return 1;
  if (bits < 60) return 2;
  if (bits < 80) return 3;
  return 4;
}

/** Why a passphrase can't be used, or null when it's fine. */
export function passphraseProblem(pass: string, confirm?: string): string | null {
  if (!pass) return "Choose a passphrase.";
  if (passphraseStrength(pass) < MIN_STRENGTH) return "Too easy to guess — use a longer one (several words work well).";
  if (confirm !== undefined && pass !== confirm) return "The two passphrases don't match.";
  return null;
}

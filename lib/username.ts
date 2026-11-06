// Shared by the browser and the API. Usernames can mix any letters, numbers,
// symbols, or emoji; none are required. They are unique regardless of case.
export const USERNAME_MIN = 2;
export const USERNAME_MAX = 24;
export const USERNAME_RULES = `${USERNAME_MIN}–${USERNAME_MAX} characters. Letters, numbers, symbols — anything but spaces.`;

/** Trims, drops a leading "@", and applies Unicode normalization. Keeps the user's casing. */
export function cleanUsername(value: string) {
  return value.normalize("NFKC").trim().replace(/^@+/, "");
}
/** Comparison key: two usernames with the same key are the same name. */
export function usernameKey(value: string) {
  return cleanUsername(value).toLowerCase();
}
/** Returns an error message, or "" when the username is acceptable. */
export function usernameProblem(username: string) {
  const length = Array.from(username).length;
  if (length < USERNAME_MIN || length > USERNAME_MAX) return `Usernames are ${USERNAME_MIN}–${USERNAME_MAX} characters.`;
  if (/[\s\p{C}]/u.test(username)) return "Usernames can’t contain spaces or invisible characters.";
  if (/^0x[0-9a-f]{40}$/i.test(username)) return "That looks like a wallet address. Choose something else.";
  return "";
}

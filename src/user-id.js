/** X's numeric IDs are strings so they retain precision. */
export function isUserId(value) {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

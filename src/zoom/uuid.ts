/**
 * Encodes a meeting instance UUID for use in a Zoom API path.
 * Zoom requires double URL-encoding when the UUID starts with "/" or contains "//".
 * Other UUIDs are encoded once, since they can still contain "+" or "=".
 */
export function encodeMeetingUuid(uuid: string): string {
  const once = encodeURIComponent(uuid);
  return uuid.startsWith("/") || uuid.includes("//") ? encodeURIComponent(once) : once;
}

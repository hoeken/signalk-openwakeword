/**
 * Copy text to the clipboard, with a fallback for plain HTTP.
 *
 * `navigator.clipboard` only exists in a *secure context* — HTTPS, or
 * localhost opened as literally "localhost". A boat's Signal K server is
 * typically reached over plain HTTP at a LAN address (http://10.0.0.10), where
 * the whole API is `undefined` and a naive `navigator.clipboard.writeText()`
 * throws. That is the common case here, not the edge case.
 *
 * The fallback is the pre-clipboard-API technique: put the text in an
 * off-screen textarea, select it, and let `document.execCommand("copy")` lift
 * the selection. It is deprecated but still implemented everywhere, and it is
 * the only thing that works on insecure origins.
 *
 * Returns true when the text was copied, false when the caller should tell the
 * user to select and copy it by hand.
 */
export async function copyText(text: string): Promise<boolean> {
  // Preferred path: real clipboard API, HTTPS or localhost only.
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied, or a non-secure context that still exposes a stub.
      // Fall through rather than giving up.
    }
  }

  if (typeof document === "undefined" || !document.body) return false;

  const area = document.createElement("textarea");
  area.value = text;
  // Off-screen but still focusable: `display: none` or `hidden` cannot be
  // selected, and a visible element would make the page jump.
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.left = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);

  // Preserve where the user was, so copying doesn't steal focus from the form.
  const previous = document.activeElement as HTMLElement | null;
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
    if (previous && typeof previous.focus === "function") previous.focus();
  }
}

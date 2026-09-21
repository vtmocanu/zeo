/**
 * A tab/archived-row favicon slot. Renders the `<img className="tab-item__favicon">`
 * when `url` is a non-empty string, else the `tab-item__favicon--fallback` span.
 * This is the exact markup `TabRow` and `ArchivedRow` render inline today; both
 * now delegate to this component so the favicon block lives in one place.
 *
 * `title` is part of the row's descriptor the callers pass through; the fallback
 * markup is a fixed decorative glyph (`aria-hidden`), so the title is not shown
 * here — kept in the prop contract for parity with the row data.
 */
export function Favicon({ url }: { url: string | null; title: string }) {
  const hasFavicon = typeof url === "string" && url.length > 0;
  return hasFavicon ? (
    <img className="tab-item__favicon" src={url ?? ""} alt="" />
  ) : (
    <span
      className="tab-item__favicon tab-item__favicon--fallback"
      aria-hidden="true"
    >
      ◦
    </span>
  );
}

/**
 * The first letter of `title`, upper-cased, for the 24px letter fallback; the
 * neutral glyph when the title has no visible character.
 */
export function faviconLetter(title: string): string {
  const first = Array.from(title.trim())[0];
  return first === undefined ? "◦" : first.toLocaleUpperCase();
}

/**
 * A favicon slot. At the default 16px it is the tab/archived-row favicon: the
 * `<img className="tab-item__favicon">` when `url` is a non-empty string, else
 * the `tab-item__favicon--fallback` span with a fixed decorative glyph.
 *
 * At 24px (favorite tiles) it renders `favicon--lg`; the fallback is a rounded
 * letter plate holding the first letter of `title`, upper-cased, so a tile is
 * recognisable before its icon has ever loaded. Always decorative: the owning
 * control carries the accessible name.
 */
export function Favicon({
  url,
  title,
  size = 16,
}: {
  url: string | null;
  title: string;
  size?: 16 | 24;
}) {
  const hasFavicon = typeof url === "string" && url.length > 0;
  if (size === 24) {
    return hasFavicon ? (
      <img className="favicon favicon--lg" src={url ?? ""} alt="" draggable={false} />
    ) : (
      <span className="favicon favicon--lg favicon--letter" aria-hidden="true">
        {faviconLetter(title)}
      </span>
    );
  }
  return hasFavicon ? (
    <img className="tab-item__favicon" src={url ?? ""} alt="" draggable={false} />
  ) : (
    <span className="tab-item__favicon tab-item__favicon--fallback" aria-hidden="true">
      ◦
    </span>
  );
}

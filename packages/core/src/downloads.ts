/**
 * The pure downloads vocabulary: the download record and its broadcast slice,
 * the reducers main applies to the in-memory list, and the pure filename/url
 * helpers the main-process `will-download` handler reuses. Electron-free and
 * store-free — the desktop SQLite layer, the `will-download` handler, and the
 * suggest ranker all read these, and the SQL itself lives in `apps/desktop`.
 *
 * The reducers are free functions (not store methods) and treat their input as
 * immutable: each returns a NEW {@link DownloadsState} rather than mutating the
 * argument, matching the existing store's immutable-update style.
 */

/**
 * One download record, owned by main and mirrored to the renderer on the
 * broadcast. `totalBytes` is `0` when the origin sent no length; `receivedBytes`
 * never exceeds `totalBytes` once the total is known. `completedAt` is non-null
 * exactly when `state` is finished. `url` carries the source url with any
 * embedded credentials removed (see {@link stripUrlCredentials}). `spaceId`
 * attributes the download to the originating tab's space, or `null` when it
 * maps to no live tab.
 */
export interface Download {
  id: string;
  url: string;
  filename: string;
  path: string;
  totalBytes: number;
  receivedBytes: number;
  state: "progressing" | "paused" | "completed" | "cancelled" | "interrupted";
  startedAt: number;
  completedAt: number | null;
  spaceId: string | null;
}

/** The downloads slice of the broadcast state: the ordered download list. */
export interface DownloadsState {
  items: Download[];
}

/** The maximum number of downloads retained in memory (and on disk). */
export const DOWNLOADS_CAP = 100;

/**
 * Whether `d` is finished: its `state` is `completed`, `cancelled`, or
 * `interrupted`. A finished record is terminal.
 */
export function isFinished(d: Download): boolean {
  return (
    d.state === "completed" ||
    d.state === "cancelled" ||
    d.state === "interrupted"
  );
}

/** Whether `d` is active: its `state` is `progressing` or `paused`. */
export function isActive(d: Download): boolean {
  return d.state === "progressing" || d.state === "paused";
}

/**
 * The single total order used everywhere downloads are listed — the reducers,
 * the SQLite list/prune queries, and `suggest`: by `startedAt` DESCENDING, ties
 * broken by `id` DESCENDING (higher `id` sorts first). Returns a negative number
 * when `a` sorts before `b`.
 */
function compareDownloads(a: Download, b: Download): number {
  if (a.startedAt !== b.startedAt) {
    return b.startedAt - a.startedAt;
  }
  if (a.id < b.id) {
    return 1;
  }
  if (a.id > b.id) {
    return -1;
  }
  return 0;
}

/**
 * Returns a new state with `download` inserted or updated, never mutating the
 * input. When an item with the same `id` exists it is replaced in place
 * (`startedAt`/`id` are immutable, so the order is unchanged); otherwise the
 * record is inserted at its ordered position, and if the resulting length
 * exceeds {@link DOWNLOADS_CAP} the oldest entry (last in the order) is dropped.
 */
export function upsertDownload(
  state: DownloadsState,
  download: Download,
): DownloadsState {
  const others = state.items.filter((item) => item.id !== download.id);
  const items = [...others, download].sort(compareDownloads);
  if (items.length > DOWNLOADS_CAP) {
    items.length = DOWNLOADS_CAP;
  }
  return { items };
}

/**
 * Returns a new state with the item whose `id` is `id` removed. A missing `id`
 * is a no-op returning a shallow-equal state (the same item set).
 */
export function removeDownload(
  state: DownloadsState,
  id: string,
): DownloadsState {
  return { items: state.items.filter((item) => item.id !== id) };
}

/**
 * Returns a new state with every finished item dropped and every active item
 * kept, order preserved. When no item is finished the original `state` is
 * returned unchanged (same reference).
 */
export function clearFinishedDownloads(state: DownloadsState): DownloadsState {
  if (!state.items.some(isFinished)) {
    return state;
  }
  return { items: state.items.filter(isActive) };
}

/**
 * Splits `name` into a stem and an extension at the LAST dot that is not at
 * index 0. A dotless name or a leading-dot name (`.gitignore`) keeps its whole
 * value as the stem and an empty extension; `archive.tar.gz` splits at the
 * final dot only (`archive.tar` / `.gz`).
 */
function splitFilename(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return { stem: name, ext: "" };
  }
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * A pure de-duplicator: returns `name` when `exists(name)` is false; otherwise
 * returns the first `` `${stem} (${n})${ext}` `` (with `stem`/`ext` split at the
 * last non-leading dot) for `n` counting up from 1 for which `exists` is false.
 * Performs no I/O — the caller supplies `exists`.
 */
export function uniqueFilename(
  name: string,
  exists: (candidate: string) => boolean,
): string {
  if (!exists(name)) {
    return name;
  }
  const { stem, ext } = splitFilename(name);
  for (let n = 1; ; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!exists(candidate)) {
      return candidate;
    }
  }
}

/** Bare platform-reserved basenames neutralized by {@link safeFilename}. */
const RESERVED_NAMES = new Set([
  "con",
  "nul",
  "prn",
  "aux",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/** The default basename used when a suggested name reduces to nothing usable. */
const DEFAULT_FILENAME = "download";

/* eslint-disable no-control-regex -- deliberately stripping NUL and control bytes */
/** NUL and other control characters (0x00–0x1F and 0x7F), stripped from a name. */
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g;
/* eslint-enable no-control-regex */

/**
 * Reduces a response-derived suggested filename to a safe basename, pure and
 * I/O-free. It discards everything up to and including the last `/` or `\`,
 * strips NUL and other control characters, trims trailing dots and spaces, and
 * maps an empty, whitespace-only, `.`, or `..` result to `download`. A bare
 * platform-reserved name (`CON`, `NUL`, `PRN`, `AUX`, `COM1`–`COM9`,
 * `LPT1`–`LPT9`, case-insensitive, ignoring an extension) is neutralized with a
 * `_` prefix as defense-in-depth. Relies on no Electron guarantee.
 */
export function safeFilename(name: string): string {
  let base = name;
  const lastSep = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  if (lastSep !== -1) {
    base = base.slice(lastSep + 1);
  }
  base = base.replace(CONTROL_CHARS_RE, "");
  base = base.replace(/[. ]+$/, "");
  if (base === "" || base === "." || base === "..") {
    return DEFAULT_FILENAME;
  }
  const { stem } = splitFilename(base);
  if (RESERVED_NAMES.has(stem.toLowerCase())) {
    return `_${base}`;
  }
  return base;
}

/**
 * Returns `url` with its `user:password@` userinfo component removed, pure and
 * I/O-free. When `url` is not a parseable absolute URL the input is returned
 * unchanged. Query and fragment are retained.
 */
export function stripUrlCredentials(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

/** Binary size units, largest step applied first by {@link formatBytes}. */
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * A compact human-readable byte size, e.g. `0 B`, `512 B`, `1.2 MB`. Scales by
 * 1024 and shows one decimal place for any unit above bytes.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** Human-readable labels for each finished download state. */
const STATE_LABELS: Record<Download["state"], string> = {
  progressing: "Downloading",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

/**
 * A human-readable progress/summary string for `d`, used by the downloads-mode
 * suggestion projector and the sidebar. For an ACTIVE download: the received
 * and total sizes with a percentage (`"1.2 MB / 4.0 MB (30%)"`), or just the
 * received size when the total is `0`/unknown (`"1.2 MB"`). For a FINISHED
 * download: the final size with a state label (`"4.0 MB · Completed"`), or just
 * the state label when no bytes were received (`"Cancelled"`).
 */
export function downloadDetail(d: Download): string {
  if (isActive(d)) {
    if (d.totalBytes > 0) {
      const percent = Math.floor((d.receivedBytes / d.totalBytes) * 100);
      return `${formatBytes(d.receivedBytes)} / ${formatBytes(d.totalBytes)} (${percent}%)`;
    }
    return formatBytes(d.receivedBytes);
  }
  const label = STATE_LABELS[d.state];
  if (d.receivedBytes > 0) {
    return `${formatBytes(d.receivedBytes)} · ${label}`;
  }
  return label;
}

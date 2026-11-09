import { readFile, writeFile } from "node:fs/promises";

const {
  LASTFM_API_KEY,
  LASTFM_USER,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
} = process.env;

const README = "README.md";
const LIMIT = 5;
const START = "<!-- LASTFM:START -->";
const END = "<!-- LASTFM:END -->";

const PLACEHOLDER_ART = "2a96cbd8b46e442fc41c2b86b821562f";

const escapeHtml = (s = "") =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function timeAgo(uts) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(uts));
  if (seconds < 60) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units = [
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (seconds >= size) return rtf.format(-Math.floor(seconds / size), unit);
  }
}

async function fetchRecentTracks(attempts = 3) {
  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  url.search = new URLSearchParams({
    method: "user.getrecenttracks",
    user: LASTFM_USER,
    api_key: LASTFM_API_KEY,
    format: "json",
    limit: String(LIMIT),
  });

  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`Last.fm responded with HTTP ${res.status}`);
      const data = await res.json();
      if (data.error)
        throw new Error(`Last.fm error ${data.error}: ${data.message}`);
      return [].concat(data.recenttracks?.track ?? []);
    } catch (err) {
      lastError = err;
      if (i < attempts) await sleep(2000 * i);
    }
  }
  throw lastError;
}

function renderRow(track) {
  const live = track["@attr"]?.nowplaying === "true";
  const art = track.image?.find((img) => img.size === "large")?.["#text"];
  const hasArt = art && !art.includes(PLACEHOLDER_ART);
  const link = escapeHtml(track.spotifyUrl ?? track.url);

  const cover = hasArt
    ? `<a href="${link}"><img src="${escapeHtml(art)}" width="48" height="48" alt=""></a>`
    : "♬";

  const status = live
    ? "♪ Now playing"
    : track.date?.uts
      ? `<!--t-->${timeAgo(track.date.uts)}<!--/t-->`
      : "";

  return [
    "  <tr>",
    `    <td width="64" align="center">${cover}</td>`,
    `    <td><a href="${link}"><b>${escapeHtml(track.name)}</b></a><br>${escapeHtml(track.artist?.["#text"])}<br><sub>${status}</sub></td>`,
    "  </tr>",
  ].join("\n");
}

function renderBlock(tracks) {
  if (tracks.length === 0) return "_Nothing playing right now._";

  const header = `<h3>Listening History</h3>`;
  const footer = `<sub><a href="https://www.last.fm/user/${encodeURIComponent(LASTFM_USER)}">View full history on Last.fm →</a></sub>`;

  return `${header}\n<table>\n${tracks.slice(0, LIMIT).map(renderRow).join("\n")}\n</table>\n\n${footer}`;
}

async function getSpotifyToken() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return null;
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString(
            "base64",
          ),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).access_token;
  } catch (err) {
    console.warn(
      `Spotify auth failed, falling back to search links: ${err.message}`,
    );
    return null;
  }
}

async function findSpotifyUrl(track, token) {
  const name = (track.name ?? "").replace(/"/g, "");
  const artist = (track.artist?.["#text"] ?? "").replace(/"/g, "");
  const searchLink = `https://open.spotify.com/search/${encodeURIComponent(`${name} ${artist}`)}`;
  if (!token) return searchLink;

  try {
    const url = new URL("https://api.spotify.com/v1/search");
    url.search = new URLSearchParams({
      q: `track:"${name}" artist:"${artist}"`,
      type: "track",
      limit: "1",
    });
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const id = (await res.json()).tracks?.items?.[0]?.id;
    return id ? `https://open.spotify.com/track/${id}` : searchLink;
  } catch (err) {
    console.warn(`Spotify lookup failed for "${name}": ${err.message}`);
    return searchLink;
  }
}

async function main() {
  if (!LASTFM_API_KEY || !LASTFM_USER) {
    throw new Error("LASTFM_API_KEY and LASTFM_USER must be set");
  }

  const tracks = await fetchRecentTracks();
  const token = await getSpotifyToken();
  for (const t of tracks) t.spotifyUrl = await findSpotifyUrl(t, token);
  const readme = await readFile(README, "utf8");

  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Couldn't find ${START} and ${END} in ${README}`);
  }

  const current = readme.slice(start + START.length, end);
  const next = `\n${renderBlock(tracks)}\n`;

  const stripTimes = (s) => s.replace(/<!--t-->.*?<!--\/t-->/g, "").trim();
  if (stripTimes(current) === stripTimes(next)) {
    console.log("No track changes, leaving README alone");
    return;
  }

  await writeFile(
    README,
    readme.slice(0, start + START.length) + next + readme.slice(end),
  );
  console.log("README updated");
}

main().catch((err) => {
  console.error(`::error::${err.message}`);
  process.exit(1);
});

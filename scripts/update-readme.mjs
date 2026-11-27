import { readFile, writeFile } from "node:fs/promises";

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REFRESH_TOKEN,
  LASTFM_USER,
} = process.env;

const README = "README.md";
const LIMIT = 5;
const START = "<!-- NOWPLAYING:START -->";
const END = "<!-- NOWPLAYING:END -->";

const STALE_NOW_PLAYING = 30 * 60;

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
    ["year", 31_536_000],
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

async function withRetry(fn, attempts = 3) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < attempts) await sleep(err.retryAfterMs ?? 2000 * i);
    }
  }
  throw lastError;
}

async function getAccessToken() {
  return withRetry(async () => {
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
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: SPOTIFY_REFRESH_TOKEN,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Spotify token refresh failed: HTTP ${res.status} ${body}`);
    }
    return (await res.json()).access_token;
  });
}

async function spotifyGet(path, token) {
  return withRetry(async () => {
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 204) return null;
    if (!res.ok) {
      const err = new Error(`Spotify ${path} responded with HTTP ${res.status}`);
      const retryAfter = Number(res.headers.get("retry-after"));
      if (res.status === 429 && retryAfter) err.retryAfterMs = retryAfter * 1000;
      throw err;
    }
    return res.json();
  });
}

function pickArt(images = []) {
  // Spotify lists images largest first (640, 300, 64). 300px stays sharp at 48px on retina.
  return (images.find((img) => img.width <= 300) ?? images[0])?.url;
}

function toTrack(item) {
  return {
    id: item.id,
    name: item.name,
    artist: item.artists?.map((a) => a.name).join(", ") ?? "",
    url:
      item.external_urls?.spotify ??
      `https://open.spotify.com/track/${item.id}`,
    art: pickArt(item.album?.images),
  };
}

async function fetchTracks(token) {
  const [current, recent] = await Promise.all([
    spotifyGet("/me/player/currently-playing", token),
    spotifyGet(`/me/player/recently-played?limit=${LIMIT + 1}`, token),
  ]);

  const tracks = (recent?.items ?? []).map((entry) => ({
    ...toTrack(entry.track),
    playedAt: Math.floor(Date.parse(entry.played_at) / 1000),
  }));

  const item = current?.is_playing && current.item?.type === "track" ? current.item : null;
  if (item) {
    const now = Math.floor(Date.now() / 1000);
    const live = {
      ...toTrack(item),
      nowPlaying: true,
      since: now - Math.floor((current.progress_ms ?? 0) / 1000),
    };
    // Looping the same song: don't show it twice.
    if (tracks[0]?.id === live.id) tracks.shift();
    tracks.unshift(live);
  }

  return tracks.slice(0, LIMIT);
}

function renderRow(track) {
  const link = escapeHtml(track.url);
  const cover = track.art
    ? `<a href="${link}"><img src="${escapeHtml(track.art)}" width="48" height="48" alt=""></a>`
    : "♬";

  const status = track.nowPlaying
    ? `♪ Now playing<!--np:${track.since}-->`
    : track.playedAt
      ? timeAgo(track.playedAt)
      : "";

  return [
    "  <tr>",
    `    <td width="64" align="center">${cover}</td>`,
    `    <td><a href="${link}"><b>${escapeHtml(track.name)}</b></a><br>${escapeHtml(track.artist)}<br><sub>${status}</sub></td>`,
    "  </tr>",
  ].join("\n");
}

function renderBlock(tracks) {
  if (tracks.length === 0) return "_Nothing playing right now._";

  const header = `<h3>Listening History</h3>`;
  const table = `<table>\n${tracks.map(renderRow).join("\n")}\n</table>`;
  if (!LASTFM_USER) return `${header}\n${table}`;

  const footer = `<sub><a href="https://www.last.fm/user/${encodeURIComponent(LASTFM_USER)}">View full history on Last.fm →</a></sub>`;
  return `${header}\n${table}\n\n${footer}`;
}

// progress_ms jitters by a second or so between runs. Keep the previous
// start time for the same play so an unchanged song doesn't rewrite the README.
function keepNowPlayingSince(tracks, block) {
  const live = tracks.find((t) => t.nowPlaying);
  if (!live) return;
  const prev = block.match(
    /<a href="([^"]*)"><b>[^]*?<sub>♪ Now playing<!--np:(\d+)-->/,
  );
  if (
    prev &&
    prev[1] === escapeHtml(live.url) &&
    Math.abs(Number(prev[2]) - live.since) <= 10
  ) {
    live.since = Number(prev[2]);
  }
}

function expireNowPlaying(block) {
  const now = Math.floor(Date.now() / 1000);
  return block.replace(/♪ Now playing<!--np:(\d+)-->/g, (match, since) =>
    now - Number(since) >= STALE_NOW_PLAYING ? timeAgo(since) : match,
  );
}

async function main() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REFRESH_TOKEN) {
    throw new Error(
      "SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET and SPOTIFY_REFRESH_TOKEN must be set",
    );
  }

  const readme = await readFile(README, "utf8");
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Couldn't find ${START} and ${END} in ${README}`);
  }

  const current = readme.slice(start + START.length, end);
  const save = (block) =>
    writeFile(
      README,
      readme.slice(0, start + START.length) + block + readme.slice(end),
    );

  let tracks;
  try {
    tracks = await fetchTracks(await getAccessToken());
  } catch (err) {
    const expired = expireNowPlaying(current);
    if (expired !== current) {
      await save(expired);
      console.log("Cleared stale now-playing status");
    }
    throw err;
  }

  keepNowPlayingSince(tracks, current);
  const next = `\n${renderBlock(tracks)}\n`;
  if (current.trim() === next.trim()) {
    console.log("No changes, leaving README alone");
    return;
  }

  await save(next);
  console.log("README updated");
}

main().catch((err) => {
  console.error(`::error::${err.message}`);
  process.exit(1);
});

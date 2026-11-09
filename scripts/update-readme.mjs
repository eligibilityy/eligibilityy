import { readFile, writeFile } from "node:fs/promises";

const { LASTFM_API_KEY, LASTFM_USER } = process.env;

const url = new URL("https://ws.audioscrobbler.com/2.0/");
url.search = new URLSearchParams({
  method: "user.getrecenttracks",
  user: LASTFM_USER,
  api_key: LASTFM_API_KEY,
  format: "json",
  limit: "5",
});

const res = await fetch(url);
if (!res.ok) throw new Error(`Last.fm responded ${res.status}`);
const { recenttracks } = await res.json();

const esc = (s) => s.replace(/([\\`*_{}\[\]()#+!|<>])/g, "\\$1");

const lines = recenttracks.track.slice(0, 5).map((t) => {
  const live = t["@attr"]?.nowplaying === "true";
  return `- ${live ? "🎧 Now playing: " : ""}[${esc(t.name)}](${t.url}) — ${esc(t.artist["#text"])}`;
});

const readme = await readFile("README.md", "utf8");
const next = readme.replace(
  /<!-- LASTFM:START -->[\s\S]*<!-- LASTFM:END -->/,
  `<!-- LASTFM:START -->\n${lines.join("\n")}\n<!-- LASTFM:END -->`
);

if (next !== readme) await writeFile("README.md", next);

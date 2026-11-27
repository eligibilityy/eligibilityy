// One-time helper: log in to Spotify and print a refresh token for the workflow.
//
// 1. In your Spotify app's dashboard settings, add this Redirect URI:
//      http://127.0.0.1:8888/callback
// 2. Run (PowerShell):
//      $env:SPOTIFY_CLIENT_ID="..."; $env:SPOTIFY_CLIENT_SECRET="..."; node scripts/spotify-auth.mjs
// 3. Open the printed URL, approve, and save the printed token as the
//    SPOTIFY_REFRESH_TOKEN repository secret.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } = process.env;
if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  console.error("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET first.");
  process.exit(1);
}

const PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
// Set $env:SPOTIFY_SCOPES="none" to test a login that requests no scopes.
const SCOPES =
  process.env.SPOTIFY_SCOPES === "none"
    ? ""
    : (process.env.SPOTIFY_SCOPES ??
      "user-read-currently-playing user-read-recently-played");
const state = randomBytes(16).toString("hex");

const authUrl = new URL("https://accounts.spotify.com/authorize");
authUrl.search = new URLSearchParams({
  client_id: SPOTIFY_CLIENT_ID,
  response_type: "code",
  redirect_uri: REDIRECT_URI,
  scope: SCOPES,
  state,
  show_dialog: "true",
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }

  const finish = (status, message) => {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(message);
    server.close();
  };

  if (url.searchParams.get("state") !== state) {
    return finish(400, "State mismatch, try again.");
  }
  const error = url.searchParams.get("error");
  if (error) {
    const detail = url.searchParams.get("error_description");
    const message = `Spotify returned an error: ${error}${detail ? ` (${detail})` : ""}`;
    console.error(message);
    return finish(400, message);
  }

  try {
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
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
        grant_type: "authorization_code",
        code: url.searchParams.get("code"),
        redirect_uri: REDIRECT_URI,
      }),
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(JSON.stringify(data));

    console.log("\nSPOTIFY_REFRESH_TOKEN:\n");
    console.log(data.refresh_token);
    console.log("\nSave it as a repository secret, e.g.:");
    console.log("  gh secret set SPOTIFY_REFRESH_TOKEN\n");
    finish(200, "Done! You can close this tab and go back to the terminal.");
  } catch (err) {
    console.error(`Token exchange failed: ${err.message}`);
    finish(500, "Token exchange failed, see the terminal.");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Open this URL in your browser and approve access:\n");
  console.log(authUrl.toString());
});

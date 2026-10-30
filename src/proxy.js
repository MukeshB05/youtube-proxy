// youtube-proxy-v2: all-in-one YouTube live -> HLS (.m3u8) proxy for Cloudflare Workers
//
//   /@abcnews.m3u8            -> live stream of a channel handle
//   /channel/UCxxxxxxxx.m3u8  -> live stream of a channel ID
//   /video/VIDEO_ID.m3u8      -> a specific live video
//   /?url=<encoded url>       -> generic proxy (used internally for playlists and segments)

const ALLOWED_HOSTS = ["googlevideo.com", "youtube.com", "ytimg.com", "googleusercontent.com"];

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type, Origin, Accept",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type",
};

// Tried in order until one returns an HLS manifest.
const CLIENTS = [
  {
    name: "IOS",
    userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    context: {
      clientName: "IOS", clientVersion: "20.10.4", deviceMake: "Apple", deviceModel: "iPhone16,2",
      osName: "iPhone", osVersion: "18.3.2.22D82", hl: "en", gl: "US",
    },
  },
  {
    name: "ANDROID",
    userAgent: "com.google.android.youtube/19.45.36 (Linux; U; Android 11) gzip",
    context: {
      clientName: "ANDROID", clientVersion: "19.45.36", androidSdkVersion: 30,
      osName: "Android", osVersion: "11", hl: "en", gl: "US",
    },
  },
  {
    name: "TV_EMBEDDED",
    userAgent:
      "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15",
    context: { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", clientVersion: "2.0", hl: "en", gl: "US" },
  },
];

function hostAllowed(hostname) {
  return ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith("." + h));
}

function errorResponse(status, message) {
  return new Response(message, {
    status,
    headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function proxify(absUrl, proxyOrigin) {
  return `${proxyOrigin}/?url=${encodeURIComponent(absUrl)}`;
}

// Point every URL inside an HLS playlist back at this proxy.
function rewritePlaylist(text, baseUrl, proxyOrigin) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          try {
            return `URI="${proxify(new URL(uri, baseUrl).href, proxyOrigin)}"`;
          } catch {
            return `URI="${uri}"`;
          }
        });
      }
      try {
        return proxify(new URL(t, baseUrl).href, proxyOrigin);
      } catch {
        return line;
      }
    })
    .join("\n");
}

// ---- Finding the live manifest -------------------------------------------------

async function pageLookup(pageUrl) {
  const res = await fetch(pageUrl, {
    headers: {
      "User-Agent": DESKTOP_UA,
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: "SOCS=CAI; CONSENT=YES+cb",
    },
    redirect: "follow",
  });
  const html = await res.text();

  let manifest = null;
  const m = html.match(/"hlsManifestUrl":"([^"]+)"/);
  if (m) {
    try {
      manifest = JSON.parse(`"${m[1]}"`);
    } catch {
      manifest = m[1].replace(/\\u0026/g, "&");
    }
  }

  const idMatch =
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/) ||
    html.match(/"videoDetails":\{"videoId":"([\w-]{11})"/);

  return { manifest, videoId: idMatch ? idMatch[1] : null, status: res.status };
}

async function playerLookup(videoId) {
  const problems = [];
  for (const client of CLIENTS) {
    try {
      const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": client.userAgent,
          Origin: "https://www.youtube.com",
          Referer: "https://www.youtube.com/",
        },
        body: JSON.stringify({
          context: { client: client.context },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      });
      if (!res.ok) {
        problems.push(`${client.name}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const url = data.streamingData && data.streamingData.hlsManifestUrl;
      if (url) return { url, problems };
      const ps = data.playabilityStatus || {};
      problems.push(`${client.name}: ${ps.status || "no status"}${ps.reason ? " - " + ps.reason : ""}`);
    } catch (e) {
      problems.push(`${client.name}: ${e.message}`);
    }
  }
  return { url: null, problems };
}

async function resolveManifest(spec) {
  let videoId = spec.videoId || null;

  if (spec.pageUrl) {
    const p = await pageLookup(spec.pageUrl);
    if (p.manifest) return p.manifest;
    videoId = p.videoId;
    if (!videoId) {
      throw new Error(
        `No live video found at ${spec.pageUrl} (page status ${p.status}). The channel may not be live right now.`
      );
    }
  }

  const r = await playerLookup(videoId);
  if (r.url) return r.url;
  throw new Error(
    `No HLS manifest for video ${videoId}. It may not be live, or YouTube is blocking this request.\n` +
      r.problems.join("\n")
  );
}

// ---- Fetching and serving ------------------------------------------------------

async function serveUrl(target, request, proxyOrigin) {
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return errorResponse(400, "Only http/https URLs are allowed");
  }
  if (!hostAllowed(target.hostname)) {
    return errorResponse(403, `Host not allowed: ${target.hostname}`);
  }

  const headers = new Headers({
    "User-Agent": DESKTOP_UA,
    Accept: "*/*",
    Referer: "https://www.youtube.com/",
    Origin: "https://www.youtube.com",
  });
  const range = request.headers.get("Range");
  if (range) headers.set("Range", range);

  let upstream;
  try {
    upstream = await fetch(target.href, { method: request.method, headers, redirect: "follow" });
  } catch (err) {
    return errorResponse(502, `Upstream fetch failed: ${err.message}`);
  }

  if (!upstream.ok && upstream.status !== 206) {
    return errorResponse(upstream.status, `Upstream returned ${upstream.status} for ${target.hostname}`);
  }

  const contentType = upstream.headers.get("Content-Type") || "";
  const path = target.pathname.toLowerCase();
  const looksLikePlaylist = /mpegurl/i.test(contentType) || path.endsWith(".m3u8") || path.endsWith(".m3u");

  if (looksLikePlaylist && request.method === "GET") {
    const body = await upstream.text();
    if (body.trimStart().startsWith("#EXTM3U")) {
      return new Response(rewritePlaylist(body, upstream.url || target.href, proxyOrigin), {
        status: 200,
        headers: { ...CORS, "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" },
      });
    }
    return new Response(body, {
      status: upstream.status,
      headers: { ...CORS, "Content-Type": contentType || "text/plain" },
    });
  }

  const out = new Headers(CORS);
  for (const h of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set("Cache-Control", "public, max-age=30");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

// ---- Diagnostics: /debug/@handle or /debug/channel/UC... ------------------------

async function debugLookup(pageUrl) {
  const out = { pageUrl };
  try {
    const p = await pageLookup(pageUrl);
    out.pageStatus = p.status;
    out.manifestFoundInPage = !!p.manifest;
    out.videoId = p.videoId;

    let manifest = p.manifest;
    if (!manifest && p.videoId) {
      const r = await playerLookup(p.videoId);
      out.manifestFoundViaApi = !!r.url;
      out.apiProblems = r.problems;
      manifest = r.url;
    }

    if (manifest) {
      out.manifestHost = new URL(manifest).hostname;
      const res = await fetch(manifest, {
        headers: { "User-Agent": DESKTOP_UA, Referer: "https://www.youtube.com/" },
      });
      out.manifestFetchStatus = res.status;
      const body = await res.text();
      out.manifestLooksValid = body.trimStart().startsWith("#EXTM3U");
      out.manifestPreview = body.slice(0, 120);
    } else {
      out.conclusion = "No manifest found: channel not live, or YouTube is blocking this request.";
    }
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(405, "Method not allowed");
    }

    const url = new URL(request.url);
    const origin = url.origin;

    try {
      let m;

      if (url.pathname.startsWith("/debug/")) {
        const rest = url.pathname.slice(6);
        let pageUrl = null;
        if ((m = rest.match(/^\/@([\w.\-]+?)(?:\.m3u8)?$/))) pageUrl = `https://www.youtube.com/@${m[1]}/live`;
        else if ((m = rest.match(/^\/channel\/([\w\-]+?)(?:\.m3u8)?$/))) pageUrl = `https://www.youtube.com/channel/${m[1]}/live`;
        if (!pageUrl) return errorResponse(400, "Use /debug/@handle or /debug/channel/UC...");
        return new Response(JSON.stringify(await debugLookup(pageUrl), null, 2), {
          headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      if ((m = url.pathname.match(/^\/@([\w.\-]+?)(?:\.m3u8)?$/))) {
        const manifest = await resolveManifest({ pageUrl: `https://www.youtube.com/@${m[1]}/live` });
        return await serveUrl(new URL(manifest), request, origin);
      }

      if ((m = url.pathname.match(/^\/channel\/([\w\-]+?)(?:\.m3u8)?$/))) {
        const manifest = await resolveManifest({ pageUrl: `https://www.youtube.com/channel/${m[1]}/live` });
        return await serveUrl(new URL(manifest), request, origin);
      }

      if ((m = url.pathname.match(/^\/video\/([\w\-]{11})(?:\.m3u8)?$/))) {
        const manifest = await resolveManifest({ videoId: m[1] });
        return await serveUrl(new URL(manifest), request, origin);
      }

      if (url.search.startsWith("?url=")) {
        let raw = url.search.slice(5);
        if (!/^https?:\/\//i.test(raw)) raw = decodeURIComponent(raw);
        return await serveUrl(new URL(raw), request, origin);
      }

      return errorResponse(
        400,
        "Usage:\n  /@channelhandle.m3u8\n  /channel/UCxxxxxxxxxxxxxxxxxxxxxx.m3u8\n  /video/VIDEO_ID.m3u8"
      );
    } catch (err) {
      return errorResponse(502, err.message);
    }
  },
};

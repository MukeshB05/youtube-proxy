// youtube-proxy: HLS (.m3u8) proxy for Cloudflare Workers
// Usage: https://youtube-proxy.mukeshlive.workers.dev/?url=<encoded upstream url>

// Only these hosts can be proxied (prevents your worker being used as an open proxy).
// A host matches if it equals an entry or ends with "." + entry.
const ALLOWED_HOSTS = [
  "mukeshlive.workers.dev",
  "googlevideo.com",
  "youtube.com",
  "ytimg.com",
  "googleusercontent.com",
];

// Host of your m3u8-generator worker. When env.HLS (service binding) exists,
// requests to this host go through the binding instead of the public URL.
const HLS_WORKER_HOST = "youtube-hls-m3u8.mukeshlive.workers.dev";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type, Origin, Accept",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type",
};

function hostAllowed(hostname) {
  return ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith("." + h));
}

function errorResponse(status, message) {
  return new Response(message, {
    status,
    headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function proxify(absUrl, proxyOrigin) {
  return `${proxyOrigin}/?url=${encodeURIComponent(absUrl)}`;
}

// Rewrite every URL in an HLS playlist so it points back through this proxy.
function rewritePlaylist(text, baseUrl, proxyOrigin) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Tag lines: rewrite URI="..." attributes (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, ...)
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          try {
            return `URI="${proxify(new URL(uri, baseUrl).href, proxyOrigin)}"`;
          } catch {
            return `URI="${uri}"`;
          }
        });
      }

      // URL lines: segments or variant playlists (may be relative)
      try {
        return proxify(new URL(trimmed, baseUrl).href, proxyOrigin);
      } catch {
        return line;
      }
    })
    .join("\n");
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(405, "Method not allowed");
    }

    const reqUrl = new URL(request.url);
    const proxyOrigin = reqUrl.origin;

    // Take everything after "?url=" so unencoded "&" or "@" in the target survive.
    const rawQuery = reqUrl.search.startsWith("?url=") ? reqUrl.search.slice(5) : null;
    if (!rawQuery) {
      return errorResponse(400, "Missing ?url= parameter");
    }

    let target;
    try {
      let decoded = rawQuery;
      // Decode only if it looks encoded, so plain URLs also work
      if (!/^https?:\/\//i.test(decoded)) decoded = decodeURIComponent(decoded);
      target = new URL(decoded);
    } catch {
      return errorResponse(400, "Invalid url parameter");
    }

    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return errorResponse(400, "Only http/https URLs are allowed");
    }
    if (!hostAllowed(target.hostname)) {
      return errorResponse(403, `Host not allowed: ${target.hostname}`);
    }

    const upstreamHeaders = new Headers({
      "User-Agent": UA,
      Accept: "*/*",
      Referer: "https://www.youtube.com/",
      Origin: "https://www.youtube.com",
    });
    const range = request.headers.get("Range");
    if (range) upstreamHeaders.set("Range", range);

    const upstreamRequest = new Request(target.href, {
      method: request.method,
      headers: upstreamHeaders,
      redirect: "follow",
    });

    let upstream;
    try {
      // Worker-to-worker fetch on workers.dev fails with error 1042,
      // so use a service binding for your own m3u8 worker.
      if (target.hostname === HLS_WORKER_HOST && env.HLS) {
        upstream = await env.HLS.fetch(upstreamRequest);
      } else {
        upstream = await fetch(upstreamRequest);
      }
    } catch (err) {
      return errorResponse(502, `Upstream fetch failed: ${err.message}`);
    }

    if (!upstream.ok && upstream.status !== 206) {
      return errorResponse(
        upstream.status,
        `Upstream returned ${upstream.status} for ${target.hostname}`
      );
    }

    const contentType = upstream.headers.get("Content-Type") || "";
    const looksLikePlaylist =
      /mpegurl/i.test(contentType) ||
      target.pathname.toLowerCase().endsWith(".m3u8") ||
      target.pathname.toLowerCase().endsWith(".m3u");

    if (looksLikePlaylist && request.method === "GET") {
      const body = await upstream.text();
      if (body.trimStart().startsWith("#EXTM3U")) {
        // upstream.url is the final URL after redirects: the right base for relative paths
        const base = upstream.url || target.href;
        return new Response(rewritePlaylist(body, base, proxyOrigin), {
          status: 200,
          headers: {
            ...CORS,
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": "no-store",
          },
        });
      }
      // Not actually a playlist (e.g. error text): pass through as-is
      return new Response(body, {
        status: upstream.status,
        headers: { ...CORS, "Content-Type": contentType || "text/plain" },
      });
    }

    // Segments and everything else: stream straight through
    const headers = new Headers(CORS);
    for (const h of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"]) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set("Cache-Control", "public, max-age=30");

    return new Response(upstream.body, { status: upstream.status, headers });
  },
};

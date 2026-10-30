export default {
  async fetch(request) {
    const { searchParams } = new URL(request.url);
    const targetUrl = searchParams.get("url");

    if (!targetUrl) {
      return new Response("❌ Missing ?url= parameter", { status: 400 });
    }

    try {
      // YouTube requires these headers to prevent 403 Forbidden errors
      const customHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
        "Origin": "https://www.youtube.com",
        "Referer": "https://www.youtube.com/",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
      };

      const resp = await fetch(targetUrl, { headers: customHeaders });

      if (!resp.ok) {
        return new Response(
          `Proxy Error: ${resp.status} ${resp.statusText}`,
          { status: resp.status }
        );
      }

      const contentType = resp.headers.get("Content-Type") || "";
      
      // 1. If the URL is an M3U8 playlist, rewrite relative paths to absolute paths
      if (contentType.includes("mpegurl") || targetUrl.includes(".m3u8")) {
        let text = await resp.text();
        const baseUrl = new URL(targetUrl);
        
        const rewritten = text.split("\n").map((line) => {
          line = line.trim();
          if (!line || line.startsWith("#")) return line;
          // Convert relative URLs to absolute URLs
          if (!line.startsWith("http://") && !line.startsWith("https://")) {
            return new URL(line, baseUrl).href;
          }
          return line;
        }).join("\n");

        return new Response(rewritten, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
          },
        });
      }

      // 2. If the URL is a video segment (.ts), stream it directly
      return new Response(resp.body, {
        status: resp.status,
        headers: {
          "Content-Type": contentType || "video/mp2t",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      return new Response("Worker Exception: " + err.message, { status: 500 });
    }
  },
};

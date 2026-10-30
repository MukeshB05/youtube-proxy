export default {
  async fetch(request) {
    const { searchParams } = new URL(request.url);
    const targetUrl = searchParams.get("url");

    if (!targetUrl) {
      return new Response("❌ Missing ?url= parameter", { status: 400 });
    }

    try {
      // Required headers to bypass YouTube's 403 protection
      const customHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
        "Origin": "https://www.youtube.com",
        "Referer": "https://www.youtube.com/",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
      };

      // Fetch the target URL (either the m3u8 manifest or a video segment)
      const resp = await fetch(targetUrl, { headers: customHeaders });

      if (!resp.ok) {
        const errorText = await resp.text();
        return new Response(
          `Proxy Error: ${resp.status} ${resp.statusText}\n\nDetails: ${errorText.substring(0, 200)}`,
          { status: resp.status }
        );
      }

      // Check if it's an M3U8 playlist to rewrite relative URLs
      const contentType = resp.headers.get("Content-Type") || "";
      if (contentType.includes("mpegurl") || targetUrl.includes(".m3u8")) {
        let text = await resp.text();
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

        // Rewrite relative segment URLs to absolute URLs
        const rewritten = text
          .split("\n")
          .map((line) => {
            line = line.trim();
            if (!line || line.startsWith("#")) return line;
            if (line.startsWith("http://") || line.startsWith("https://")) return line;
            // Return absolute URL
            return encodeURI(new URL(line, baseUrl).href);
          })
          .join("\n");

        return new Response(rewritten, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
          },
        });
      }

      // For video segments (.ts files), stream them directly
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

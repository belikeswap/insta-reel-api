import puppeteer from "puppeteer";
import removeQueryFromUrl from "../utils/remove-query-from-url.mjs";
import ReelCache from "../schema/reel-cache.schema.mjs";

// Instagram plays reels through MediaSource Extensions, so `video.src` is a
// `blob:` URL wrapping a MediaSource object — NOT a real Blob. `fetch()` on
// that URL always fails, and the media itself is delivered to the player in
// small byte-range chunks, so sniffing a single network response only ever
// yields a tiny partial fragment (this is why we were seeing ~104B files).
//
// The reliable source is the real, direct, progressive CDN URL that
// Instagram embeds in the page's own JSON payload (the same URL the player
// uses to build the MSE stream from). We parse that out of the HTML.
const VIDEO_URL_PATTERNS = [
  /"video_url":"([^"]+)"/,
  /"video_versions":\[\{[^}]*?"url":"([^"]+)"/,
  /"playable_url(?:_quality_hd)?":"([^"]+)"/,
];

function unescapeUrl(raw) {
  return raw
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}

function extractVideoUrlFromHtml(html) {
  for (const pattern of VIDEO_URL_PATTERNS) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return unescapeUrl(match[1]);
    }
  }
  return null;
}

// Fallback: reassemble the video from byte-range network responses in case
// the direct URL isn't embedded in the HTML for some reason.
async function sniffVideoViaNetwork(page) {
  const partsByResource = new Map();

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      page.off("response", onResponse);
      reject(new Error("Timed out waiting for video network traffic"));
    }, 20000);

    function finish(result) {
      clearTimeout(timeout);
      page.off("response", onResponse);
      resolve(result);
    }

    async function onResponse(response) {
      try {
        const req = response.request();
        const respUrl = response.url();
        const contentType = response.headers()["content-type"] || "";
        const looksLikeVideo =
          req.resourceType() === "media" || contentType.startsWith("video/");
        if (!looksLikeVideo || !/\.mp4(\?|$)/.test(respUrl)) return;

        const buffer = await response.buffer();
        const contentRange = response.headers()["content-range"];

        if (!contentRange) {
          if (buffer.length > 20000) {
            finish({ buffer, contentType: contentType || "video/mp4", videoUrl: respUrl });
          }
          return;
        }

        const match = contentRange.match(/bytes (\d+)-(\d+)\/(\d+)/);
        if (!match) return;
        const [, startStr, , totalStr] = match;
        const start = Number(startStr);
        const total = Number(totalStr);
        const key = respUrl.split("?")[0];

        let entry = partsByResource.get(key);
        if (!entry) {
          entry = { total, received: 0, parts: [] };
          partsByResource.set(key, entry);
        }
        entry.parts.push({ start, buffer });
        entry.received += buffer.length;

        if (entry.received >= entry.total) {
          entry.parts.sort((a, b) => a.start - b.start);
          const full = Buffer.concat(entry.parts.map((p) => p.buffer));
          finish({ buffer: full, contentType: contentType || "video/mp4", videoUrl: respUrl });
        }
      } catch {
        // ignore malformed/aborted responses
      }
    }

    page.on("response", onResponse);
  });
}

async function resolveReel(url) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();

  try {
    const networkSniff = sniffVideoViaNetwork(page).catch(() => null);

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("video");

    const html = await page.content();
    const directUrl = extractVideoUrlFromHtml(html);

    if (directUrl) {
      const response = await fetch(directUrl);
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > 20000) {
          const contentType = response.headers.get("content-type") || "video/mp4";
          return { buffer, contentType, videoUrl: directUrl };
        }
      }
    }

    // Fall back to nudging playback and aggregating range-chunked responses.
    await page
      .evaluate(() => {
        const v = document.querySelector("video");
        if (v) {
          v.muted = true;
          v.play().catch(() => {});
        }
      })
      .catch(() => {});

    const sniffed = await networkSniff;
    if (sniffed) return sniffed;

    throw new Error("Could not resolve a direct, downloadable video URL for this reel");
  } finally {
    await page.close();
    await browser.close();
  }
}

export async function getReelVideo(url) {
  const { videoUrl } = await resolveReel(url);
  return videoUrl;
}

// Resolves and downloads the actual video bytes for a reel.
export async function getReelVideoBuffer(url) {
  return await resolveReel(url);
}

export async function cacheReelInfo(url) {
  console.log(`[PROCESSING]: ${url}`);
  const clean_url = removeQueryFromUrl(url);

  let ReelInfo = undefined;
  const ReelData = await ReelCache.findOne({ url: clean_url });

  const reelOpenGraph = await (
    await fetch(
      `${process.env.OPEN_GRAPH_API_URL}?` +
        new URLSearchParams({
          url: clean_url,
        })
    )
  ).json();

  if (ReelData) {
    ReelInfo = {
      title: reelOpenGraph.ogTitle,
      url: clean_url,
      description: reelOpenGraph.ogDescription,
      thumbnail: reelOpenGraph.ogImage,
      download_link: ReelData.download_link,
    };
  } else {
    ReelInfo = {
      title: reelOpenGraph.ogTitle,
      url: clean_url,
      description: reelOpenGraph.ogDescription,
      thumbnail: reelOpenGraph.ogImage,
      download_link: await getReelVideo(clean_url),
    };

    await ReelCache.create({ ...ReelInfo, dateCreated: Date.now() });
  }

  return ReelInfo;
}

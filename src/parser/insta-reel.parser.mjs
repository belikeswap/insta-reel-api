import puppeteer from "puppeteer";
import removeQueryFromUrl from "../utils/remove-query-from-url.mjs";
import ReelCache from "../schema/reel-cache.schema.mjs";

// Instagram plays reels through MediaSource Extensions, so `video.src` is a
// `blob:` URL wrapping a MediaSource object — NOT a real Blob. `fetch()` on
// that URL always fails ("Failed to fetch"), from inside the page or out,
// because fetch only works on blob URLs created from an actual Blob/File.
//
// Instead, we sniff the real network response for the underlying .mp4 file
// that the player requests from Instagram's CDN, which is a normal,
// directly-fetchable, signed URL.
async function resolveReelVideoUrl(url) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();

  let videoUrl;

  page.on("response", (response) => {
    if (videoUrl) return;
    try {
      const req = response.request();
      const respUrl = response.url();
      const contentType = response.headers()["content-type"] || "";
      const looksLikeVideo =
        req.resourceType() === "media" || contentType.startsWith("video/");
      if (looksLikeVideo && /\.mp4(\?|$)/.test(respUrl)) {
        videoUrl = respUrl;
      }
    } catch {
      // ignore malformed/aborted responses
    }
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("video");

    // Nudge playback so the player actually issues the media request.
    await page
      .evaluate(() => {
        const v = document.querySelector("video");
        if (v) {
          v.muted = true;
          v.play().catch(() => {});
        }
      })
      .catch(() => {});

    const deadline = Date.now() + 15000;
    while (!videoUrl && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!videoUrl) {
      throw new Error("Could not locate direct video URL from network traffic");
    }

    return videoUrl;
  } finally {
    await page.close();
    await browser.close();
  }
}

export async function getReelVideo(url) {
  return await resolveReelVideoUrl(url);
}

// Resolves and downloads the actual video bytes for a reel.
export async function getReelVideoBuffer(url) {
  const videoUrl = await resolveReelVideoUrl(url);

  const response = await fetch(videoUrl);
  if (!response.ok) {
    throw new Error(`Failed to download video: ${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "video/mp4";
  const buffer = Buffer.from(await response.arrayBuffer());

  return { buffer, contentType, videoUrl };
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

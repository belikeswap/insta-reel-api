import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import removeQueryFromUrl from "../utils/remove-query-from-url.mjs";
import ReelCache from "../schema/reel-cache.schema.mjs";

async function getHTML(url) {
  // Launch a headless browser instance
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox"],
  });

  // Create a new page
  const page = await browser.newPage();

  // Navigate to a URL
  await page.goto(url);

  // Wait for the video tag to appear
  await page.waitForSelector("video");

  // Get the HTML content
  const html = await page.content();

  // Close the browser
  await page.close();
  await browser.close();

  // Return the HTML content
  return html;
}

export async function getReelVideo(url) {
  const html = await getHTML(url);

  // calls cheerio to process the html received
  const $ = cheerio.load(html);

  // Searches the html for the video tag and get the src atttribute
  const videoDirectLink = $("video").attr("src");

  // returns the direct video link
  return videoDirectLink;
}

// Resolves the actual video bytes for a reel, including the case where the
// <video> src is a `blob:` URL. Blob URLs only exist inside the browser tab
// that created them, so they can't be fetched from Node directly — we have
// to resolve them from inside the page context first.
export async function getReelVideoBuffer(url) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();

  try {
    await page.goto(url);
    await page.waitForSelector("video");

    const videoSrc = await page.$eval("video", (el) => el.src);

    let buffer;
    let contentType = "video/mp4";

    if (videoSrc.startsWith("blob:")) {
      // Fetch the blob and read it back out as a base64 data URL from
      // inside the page, then hand the base64 string back to Node.
      const dataUrl = await page.evaluate(async (blobUrl) => {
        const blob = await fetch(blobUrl).then((r) => r.blob());
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }, videoSrc);

      const match = dataUrl.match(/^data:(.+);base64,(.*)$/);
      if (!match) {
        throw new Error("Failed to resolve blob video data");
      }
      contentType = match[1] || contentType;
      buffer = Buffer.from(match[2], "base64");
    } else {
      // Direct URL, can be fetched straight from Node.
      const response = await fetch(videoSrc);
      if (!response.ok) {
        throw new Error(`Failed to download video: ${response.status}`);
      }
      contentType = response.headers.get("content-type") || contentType;
      buffer = Buffer.from(await response.arrayBuffer());
    }

    return { buffer, contentType };
  } finally {
    await page.close();
    await browser.close();
  }
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

import { cacheReelInfo, getReelVideoBuffer } from "./parser/insta-reel.parser.mjs";

import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import fs from "fs";
import os from "os";
import path from "path";

import * as dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(cors({ origin: "*" }));

app.get("/", async (req, res) => {
  try {
    const url = req.query.url;
    const info = await cacheReelInfo(url);
    console.log(`[GET] ${url}`);
    res.send(info);
  } catch (error) {
    res.send({ message: error.message });
  }
});

app.get("/download", async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).send({ message: "Missing url query param" });
  }

  let tempFilePath;
  try {
    console.log(`[DOWNLOAD] ${url}`);
    const { buffer, contentType } = await getReelVideoBuffer(url);
    const ext = contentType.includes("mp4") ? "mp4" : "bin";

    tempFilePath = path.join(
      os.tmpdir(),
      `reel-${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`
    );
    fs.writeFileSync(tempFilePath, buffer);

    res.download(tempFilePath, `reel.${ext}`, (err) => {
      fs.unlink(tempFilePath, () => {});
      if (err) console.error("[DOWNLOAD ERROR]", err.message);
    });
  } catch (error) {
    if (tempFilePath) fs.unlink(tempFilePath, () => {});
    res.status(500).send({ message: error.message });
  }
});

app.get("/ping", (req, res) => {
  res.send({ health: "fine" });
});

async function startServer() {
  mongoose.connect(process.env.MONGO_DATABASE_URL).then(() => {
    console.log("Connected to Database");
    app.listen(PORT, () => {
      console.log(`Listenning on PORT ${PORT}`);
    });
  });
}

await startServer();

// getReelVideo("https://www.instagram.com/reel/CrQ9TvAAuRe/").then((link) =>
//   console.log(link)
// );

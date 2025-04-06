require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const { exec } = require("child_process");
const axios = require("axios");
const pdfParse = require("pdf-parse");

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

const AUDIO_DIR = path.join(__dirname, "audio");
const UPLOADS_DIR = path.join(__dirname, "uploads");
fs.ensureDirSync(AUDIO_DIR);
fs.ensureDirSync(UPLOADS_DIR);

const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
if (!ASSEMBLYAI_API_KEY) {
  console.error("❌ AssemblyAI API key is missing! Set it in .env");
  process.exit(1);
}

const upload = multer({ dest: UPLOADS_DIR });

// Load Transformers for Summarization
async function loadTransformer() {
  const { pipeline } = await import("@xenova/transformers");
  return pipeline;
}

// Summarization Function
async function summarizeText(text, level) {
  const pipeline = await loadTransformer();
  const summarizer = await pipeline("summarization");

  let maxLen, minLen;
  if (level === "core") {
    maxLen = 100;
    minLen = 50;
  } else if (level === "concise") {
    maxLen = 300;
    minLen = 150;
  } else {
    maxLen = 500;
    minLen = 200;
  }

  const result = await summarizer(text, { max_length: maxLen, min_length: minLen });
  return result[0].summary_text;
}

// 🎙 **Route: Transcribe YouTube Video**
app.post("/transcribe", async (req, res) => {
  try {
    const { videoUrl } = req.body;
    if (!videoUrl) return res.status(400).json({ error: "No video URL provided" });

    const outputFilePath = path.join(AUDIO_DIR, `${Date.now()}.mp3`);
    const ytCommand = `yt-dlp -x --audio-format mp3 -o "${outputFilePath}" "${videoUrl}"`;

    console.log("📥 Downloading audio... command:", ytCommand);

    await new Promise((resolve, reject) => {
      exec(ytCommand, (err, stdout, stderr) => {
        if (err || stderr) {
          console.error("yt-dlp error:", stderr);
          reject(new Error(`Failed to download audio: ${stderr}`));
        } else {
          resolve();
        }
      });
    });

    if (!fs.existsSync(outputFilePath)) throw new Error("Audio file not found after download");

    console.log("🔄 Uploading audio to AssemblyAI...");
    const uploadResponse = await axios.post(
      "https://api.assemblyai.com/v2/upload",
      fs.createReadStream(outputFilePath),
      {
        headers: {
          Authorization: ASSEMBLYAI_API_KEY,
          "Content-Type": "application/octet-stream",
        },
      }
    );

    const audioUrl = uploadResponse.data.upload_url;
    console.log("📤 File uploaded! URL:", audioUrl);

    console.log("📝 Requesting transcription...");
    const transcriptResponse = await axios.post(
      "https://api.assemblyai.com/v2/transcript",
      { audio_url: audioUrl },
      {
        headers: {
          Authorization: ASSEMBLYAI_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    const transcriptId = transcriptResponse.data.id;
    console.log("🆔 Transcript ID:", transcriptId);

    let transcriptResult;
    while (true) {
      const resultResponse = await axios.get(
        `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
        {
          headers: { Authorization: ASSEMBLYAI_API_KEY },
        }
      );

      if (resultResponse.data.status === "completed") {
        transcriptResult = resultResponse.data.text;
        break;
      } else if (resultResponse.data.status === "failed") {
        throw new Error("Transcription failed: " + JSON.stringify(resultResponse.data));
      }

      console.log("⏳ Waiting for transcription...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    console.log("✅ Transcription Complete:", transcriptResult);
    res.json({ transcript: transcriptResult });

    fs.remove(outputFilePath).catch((err) => console.error("❌ Failed to delete file:", err));
  } catch (error) {
    console.error("❌ Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// 📝 **Route: Summarize Transcript**
app.post("/summarize", async (req, res) => {
  try {
    const { transcript, level } = req.body;
    if (!transcript) return res.status(400).json({ error: "No transcript provided" });

    console.log("🔄 Summarizing text...");
    const summary = await summarizeText(transcript, level);
    console.log("✅ Summary Generated:", summary);

    res.json({ summary });
  } catch (error) {
    console.error("❌ Summarization error:", error.message);
    res.status(500).json({ error: "Summarization failed" });
  }
});

// 📂 **Route: Upload File and Summarize**
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const filePath = req.file.path;

    let text = "";
    if (req.file.mimetype === "application/pdf") {
      const data = await pdfParse(fs.readFileSync(filePath));
      text = data.text;
    } else if (req.file.mimetype === "text/plain") {
      text = fs.readFileSync(filePath, "utf-8");
    } else {
      return res.status(400).json({ error: "Unsupported file format" });
    }

    console.log("🔄 Summarizing uploaded file...");
    const summary = await summarizeText(text, "concise");
    console.log("✅ Summary Generated:", summary);

    fs.remove(filePath).catch((err) => console.error("❌ Failed to delete file:", err));
    res.json({ summary });
  } catch (error) {
    console.error("❌ Error processing file:", error.message);
    res.status(500).json({ error: "File processing failed" });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
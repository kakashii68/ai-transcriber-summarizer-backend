// Backend (server.js - or your main server file)
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const mime = require("mime-types");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { exec } = require("child_process");
const axios = require("axios");
const FormData = require('form-data');
const pdfParse = require('pdf-parse'); // Import pdf-parse

console.log("Current PATH at runtime:", process.env.PATH); // Added log

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

const UPLOADS_DIR = "uploads";
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;

if (!GEMINI_API_KEY) {
    console.error("❌ Gemini API key is missing! Set it in .env");
    process.exit(1);
}

if (!ASSEMBLYAI_API_KEY) {
    console.error("❌ AssemblyAI API key is missing! Set it in .env");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const storage = multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
        const ext = mime.extension(file.mimetype);
        cb(null, `${Date.now()}.${ext}`);
    },
});

const upload = multer({ storage: storage });

const generationConfig = {
    temperature: 1,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    responseMimeType: "text/plain",
};

async function processGeminiResponse(result) {
    const candidates = result.response.candidates;
    let textOutput = result.response.text();
    let fileOutputs = [];

    for (let candidate_index = 0; candidate_index < candidates.length; candidate_index++) {
        for (let part_index = 0; part_index < candidates[candidate_index].content.parts.length; part_index++) {
            const part = candidates[candidate_index].content.parts[part_index];
            if (part.inlineData) {
                try {
                    const filename = `output_${candidate_index}_${part_index}.${mime.extension(part.inlineData.mimeType)}`;
                    const filePath = `${UPLOADS_DIR}/${filename}`;
                    fs.writeFileSync(filePath, Buffer.from(part.inlineData.data, "base64"));
                    console.log(`Output written to: ${filePath}`);
                    fileOutputs.push({ filename: filename, path: filePath });
                } catch (err) {
                    console.error(err);
                }
            }
        }
    }

    return { text: textOutput, files: fileOutputs };
}

async function transcribeAudioAssemblyAI(audioFilePath) {
    const headers = {
        authorization: ASSEMBLYAI_API_KEY,
        "Content-Type": "multipart/form-data",
    };

    const formData = new FormData();
    try {
        const fileStream = fs.createReadStream(audioFilePath);
        formData.append("audio_file", fileStream, {
            filename: 'audio.mp3',
            contentType: 'audio/mpeg'
        });
        console.log(`Uploading file to AssemblyAI: ${audioFilePath}`);
        console.log(`File size: ${fs.statSync(audioFilePath).size} bytes`);
        console.log("Form Data Headers:", formData.getHeaders());
    } catch (err) {
        console.error("Error reading file:", err);
        throw err;
    }

    try {
        // Upload the audio file
        const response = await axios.post("https://api.assemblyai.com/v2/upload", formData, {
            headers: formData.getHeaders({ authorization: ASSEMBLYAI_API_KEY }),
        });

        console.log("AssemblyAI upload response:", response.data);

        const uploadUrl = response.data.upload_url;

        // Request transcription
        const transcriptData = {
            audio_url: uploadUrl,
        };

        const transcriptResponse = await axios.post(
            "https://api.assemblyai.com/v2/transcript",
            transcriptData,
            { headers: { authorization: ASSEMBLYAI_API_KEY } }
        );

        const transcriptId = transcriptResponse.data.id;
        console.log(`AssemblyAI Transcript ID: ${transcriptId}`);

        let transcriptResult = null;
        let attempts = 0;
        const maxAttempts = 40; // Increased attempts
        const interval = 5000; // Increased interval

        // Poll for the transcription result
        while (!transcriptResult && attempts < maxAttempts) {
            const getTranscriptResponse = await axios.get(
                `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
                { headers: { authorization: ASSEMBLYAI_API_KEY } }
            );

            console.log(
                `AssemblyAI transcript status (Attempt ${attempts + 1}): ${getTranscriptResponse.data.status}`
            );

            if (getTranscriptResponse.data.status === "completed") {
                transcriptResult = getTranscriptResponse.data.text;
                console.log("AssemblyAI transcript received successfully.");
                console.log("Transcript: ", transcriptResult);
            } else if (getTranscriptResponse.data.status === "error") {
                console.error(
                    "AssemblyAI transcription error:",
                    getTranscriptResponse.data.error
                );
                throw new Error(
                    `AssemblyAI transcription failed: ${getTranscriptResponse.data.error}`
                );
            } else {
                await new Promise((resolve) => setTimeout(resolve, interval));
                attempts++;
            }
        }

        if (!transcriptResult) {
            throw new Error("AssemblyAI transcription timed out");
        }

        return transcriptResult;
    } catch (error) {
        console.error("AssemblyAI transcription error:", error);
        throw error;
    }
}

app.post("/summarize-youtube", async (req, res) => {
    try {
        const { videoUrl, level } = req.body;
        if (!videoUrl) return res.status(400).json({ error: "No video URL provided" });

        const outputFilePath = `${UPLOADS_DIR}/${Date.now()}.wav`;
        // Using explicit path to yt-dlp
        const ytCommand = `yt-dlp -x --audio-format wav -o "${outputFilePath}" --audio-quality 0 "${videoUrl}"`;
        // Using explicit path to ffmpeg
        const ffmpegCommand = `/opt/render/project/src/bin/ffmpeg -i "${outputFilePath}" "${outputFilePath}.fixed.mp3"`;

        const ytStartTime = Date.now();
        await new Promise((resolve, reject) => {
            exec(ytCommand, (err, stdout, stderr) => {
                if (err) {
                    console.error("yt-dlp error:", stderr);
                    reject(new Error(`Failed to download audio: ${stderr}`));
                } else {
                    console.log(`yt-dlp successful (${Date.now() - ytStartTime}ms)`);
                    resolve();
                }
            });
        });

        const ffmpegStartTime = Date.now();
        await new Promise((resolve, reject) => {
            exec(ffmpegCommand, (err, stdout, stderr) => {
                if (err) {
                    console.error("ffmpeg error:", stderr);
                    reject(new Error(`ffmpeg conversion failed: ${stderr}`));
                } else {
                    console.log(`ffmpeg successful (${Date.now() - ffmpegStartTime}ms)`);
                    resolve();
                }
            });
        });

        fs.unlinkSync(outputFilePath);
        fs.renameSync(`${outputFilePath}.fixed.mp3`, outputFilePath);

        const assemblyStartTime = Date.now();
        const transcript = await transcribeAudioAssemblyAI(outputFilePath);
        console.log(`AssemblyAI transcription done (${Date.now() - assemblyStartTime}ms)`);

        fs.unlinkSync(outputFilePath);

        console.log("Transcript received, processing with gemini");

        const geminiStartTime = Date.now();
        const chatSession = model.startChat({
            generationConfig,
            history: [],
        });

        const prompt = `Provide a concise summary of the following text only, ensuring the output contains only the summary and no extra introductory phrases: ${transcript}. ${level === "core" ? "Make the summary very short and concise" : level === "concise" ? "Make a detailed summary" : "Make the summary in bullet points"}`;

        const result = await chatSession.sendMessage(prompt);
        console.log(`Gemini response received (${Date.now() - geminiStartTime}ms)`);

        const geminiResponse = await processGeminiResponse(result);
        res.json({ transcript: transcript, summary: geminiResponse.text });
    } catch (error) {
        console.error("YouTube summarization error:", error);
        res.status(500).json({ error: "Summarization failed" });
    }
});

app.post("/summarize", async (req, res) => {
    try {
        const { transcript, level } = req.body;
        if (!transcript) return res.status(400).json({ error: "No text provided" });

        const chatSession = model.startChat({
            generationConfig,
            history: [],
        });

        const prompt = `Provide a concise summary of the following text only, ensuring the output contains only the summary and no extra introductory phrases: ${transcript}. ${level === "core" ? "Make the summary very short and concise" : level === "concise" ? "Make a detailed summary" : "Make the summary in bullet points"}`;

        const result = await chatSession.sendMessage(prompt);
        const geminiResponse = await processGeminiResponse(result);
        res.json(geminiResponse);
    } catch (error) {
        console.error("Gemini summarization error:", error);
        res.status(500).json({ error: "Summarization failed" });
    }
});

app.post("/transcribe-video", upload.single("video"), async (req, res) => {
    try {
        console.log("Received video upload request.");

        if (!req.file) {
            console.log("No file received.");
            return res.status(400).json({ error: "No video file uploaded" });
        }

        console.log("Received file:", req.file.originalname);

        const audioFilePath = req.file.path;
        const outputAudioPath = `${UPLOADS_DIR}/${Date.now()}.mp3`;

        await new Promise((resolve, reject) => {
            // Using explicit path to ffmpeg
            exec(
                `/opt/render/project/src/bin/ffmpeg -i "${audioFilePath}" -acodec mp3 "${outputAudioPath}"`,
                (err, stdout, stderr) => {
                    if (err) {
                        console.error("ffmpeg error:", stderr);
                        reject(new Error(`ffmpeg conversion failed: ${stderr}`));
                    } else {
                        console.log("ffmpeg successful");
                        resolve();
                    }
                }
            );
        });

        const transcript = await transcribeAudioAssemblyAI(outputAudioPath);
        fs.unlinkSync(audioFilePath);
        fs.unlinkSync(outputAudioPath);
        res.json({ transcript });
    } catch (error) {
        console.error("Video transcription error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post("/upload", upload.single("file"), async (req, res) => {
    try {
        const { level } = req.body;
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        const filePath = req.file.path;
        let fileContent = "";

        if (req.file.mimetype === 'application/pdf') {
            const dataBuffer = fs.readFileSync(filePath);
            const pdfData = await pdfParse(dataBuffer);
            fileContent = pdfData.text;
            console.log("Successfully parsed PDF content.");
        } else {
            fileContent = fs.readFileSync(filePath, "utf-8");
        }

        const chatSession = model.startChat({
            generationConfig,
            history: [],
        });

        const prompt = `Provide a concise summary of the following content only, ensuring the output contains only the summary and no extra introductory phrases: ${fileContent}. ${level === "core" ? "Make the summary very short and concise" : level === "concise" ? "Make a detailed summary" : "Make the summary in bullet points"}`;

        const result = await chatSession.sendMessage(prompt);
        const geminiResponse = await processGeminiResponse(result);

        // Send back the original file content in the response
        res.json({ text: geminiResponse.text, originalContent: fileContent });

    } catch (error) {
        console.error("Gemini file processing error:", error);
        res.status(500).json({ error: "File processing failed" });
    } finally {
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }
    }
});

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3000;

// Directories
const SITES_DIR = path.join(__dirname, "sites");
const PUBLIC_DIR = path.join(__dirname, "public");

if (!fs.existsSync(SITES_DIR)) fs.mkdirSync(SITES_DIR, { recursive: true });

// Middleware
app.use(cors());
app.use(express.json());

// Serve frontend
app.use(express.static(PUBLIC_DIR));

// Multer — memory storage (no temp file)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === "application/zip" ||
      file.mimetype === "application/x-zip-compressed" ||
      file.originalname.endsWith(".zip")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only .zip files allowed"), false);
    }
  },
});

// ─── Upload Route ────────────────────────────────────────────
app.post("/upload", upload.single("zipfile"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No ZIP file provided" });
  }

  try {
    const siteId = uuidv4().split("-")[0]; // short ID e.g. "a3f7b2c1"
    const siteDir = path.join(SITES_DIR, siteId);
    fs.mkdirSync(siteDir, { recursive: true });

    // Extract ZIP
    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();

    // Detect if there's a single root folder wrapping everything
    const topDirs = new Set(
      entries
        .map((e) => e.entryName.split("/")[0])
        .filter(Boolean)
    );
    const hasSingleRoot =
      topDirs.size === 1 &&
      entries.some((e) => e.entryName.includes("/"));
    const rootFolder = hasSingleRoot ? [...topDirs][0] : null;

    let hasIndex = false;
    const fileList = [];

    entries.forEach((entry) => {
      if (entry.isDirectory) return;

      let entryPath = entry.entryName;

      // Strip root folder if present
      if (rootFolder && entryPath.startsWith(rootFolder + "/")) {
        entryPath = entryPath.slice(rootFolder.length + 1);
      }

      if (!entryPath) return;

      const outPath = path.join(siteDir, entryPath);
      const outDir = path.dirname(outPath);

      // Security: prevent path traversal
      if (!outPath.startsWith(siteDir)) return;

      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outPath, entry.getData());
      fileList.push(entryPath);

      if (entryPath === "index.html") hasIndex = true;
    });

    if (!hasIndex) {
      // Cleanup and reject
      fs.rmSync(siteDir, { recursive: true, force: true });
      return res.status(400).json({
        error: "index.html not found in ZIP. Please include an index.html at the root.",
      });
    }

    const siteUrl = `http://localhost:${PORT}/sites/${siteId}/`;

    return res.json({
      success: true,
      siteId,
      url: siteUrl,
      files: fileList,
      fileCount: fileList.length,
    });
  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ error: "Failed to process ZIP: " + err.message });
  }
});

// ─── Serve Deployed Sites ─────────────────────────────────────
app.use("/sites/:siteId", (req, res, next) => {
  const { siteId } = req.params;

  // Validate siteId (alphanumeric only)
  if (!/^[a-f0-9]{8}$/.test(siteId)) {
    return res.status(404).send("Site not found");
  }

  const siteDir = path.join(SITES_DIR, siteId);
  if (!fs.existsSync(siteDir)) {
    return res.status(404).send("Site not found");
  }

  // Get the file path after /sites/:siteId/
  let filePath = req.path.replace(`/${siteId}`, "") || "/";
  if (filePath === "/" || filePath === "") filePath = "/index.html";

  const fullPath = path.join(siteDir, filePath);

  // Security check
  if (!fullPath.startsWith(siteDir)) {
    return res.status(403).send("Forbidden");
  }

  if (!fs.existsSync(fullPath)) {
    // Try index.html for SPA routing
    const indexPath = path.join(siteDir, "index.html");
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    return res.status(404).send("File not found");
  }

  res.sendFile(fullPath);
});

// ─── List all sites ───────────────────────────────────────────
app.get("/api/sites", (req, res) => {
  try {
    const sites = fs.readdirSync(SITES_DIR).map((siteId) => {
      const siteDir = path.join(SITES_DIR, siteId);
      const stat = fs.statSync(siteDir);
      const files = fs.readdirSync(siteDir).length;
      return {
        siteId,
        url: `http://localhost:${PORT}/sites/${siteId}/`,
        createdAt: stat.birthtime,
        files,
      };
    });
    res.json(sites.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
  } catch {
    res.json([]);
  }
});

// ─── Delete a site ────────────────────────────────────────────
app.delete("/api/sites/:siteId", (req, res) => {
  const { siteId } = req.params;
  if (!/^[a-f0-9]{8}$/.test(siteId)) return res.status(400).json({ error: "Invalid ID" });

  const siteDir = path.join(SITES_DIR, siteId);
  if (!fs.existsSync(siteDir)) return res.status(404).json({ error: "Not found" });

  fs.rmSync(siteDir, { recursive: true, force: true });
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`\n🚀 ZipHost running at http://localhost:${PORT}\n`);
});

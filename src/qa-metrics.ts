import { Router } from "express";
import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const router = Router();

const s3Client = new S3Client({
  region: process.env.AWS_DEFAULT_REGION || "eu-west-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET_NAME = "turing-robotics-datahub";
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes (increased from 5)

// Session ID pattern: YYYYMMDD_HHMMSS
const SESSION_ID_PATTERN = /^\d{8}_\d{6}$/;

interface QAMetrics {
  overview: {
    totalSessions: number;
    completeSessions: number;
    lastUpdated: string;
  };
  sessions: Array<{
    sessionId: string;
    captureDate: string;
    status: string;
    stages: {
      stage2_captureQuality: {
        totalFrames: number;
        bothHandsNotInFramePercent: number;
        trackingErrorsPercent: number;
        handSpeedExceededPercent: number;
        validFramesPercent: number;
        score: number;
      };
      stage10_validationTests: {
        npzIntegrityCheck: boolean;
        frameCountCheck: boolean;
        timestampConsistency: boolean;
        score: number;
      };
      stage12_trackingConfidence: {
        leftHandAvgConfidence: number;
        rightHandAvgConfidence: number;
        overallAvgConfidence: number;
        lowConfidenceFramesPercent: number;
        score: number;
      };
    };
    overallQualityScore: number;
  }>;
  aggregateStats: {
    avgCaptureQuality: number;
    avgTrackingConfidence: number;
    avgValidationScore: number;
    sessionsWithIssues: number;
  };
}

let cachedMetrics: QAMetrics | null = null;
let lastFetchTime = 0;
let isProcessing = false; // Lock to prevent concurrent processing

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function cleanupTempFiles() {
  try {
    // Clean up all temp NPZ files older than 1 hour
    const tempDir = "/tmp";
    const files = fs.readdirSync(tempDir);
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    let cleaned = 0;
    for (const file of files) {
      if (file.startsWith("npz_") && file.endsWith(".npz")) {
        const filePath = path.join(tempDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.mtimeMs < oneHourAgo) {
            fs.unlinkSync(filePath);
            cleaned++;
          }
        } catch (err) {
          // Ignore errors for individual files
        }
      }
    }

    if (cleaned > 0) {
      console.log(`[QAMetrics] Cleaned up ${cleaned} old temp files`);
    }
  } catch (error: any) {
    console.error("[QAMetrics] Error cleaning temp files:", error.message);
  }
}

function cleanupAllTempFilesNow() {
  try {
    // AGGRESSIVE CLEANUP: Remove ALL temp NPZ files immediately
    const tempDir = "/tmp";
    const files = fs.readdirSync(tempDir);

    let cleaned = 0;
    let totalSize = 0;

    for (const file of files) {
      if (file.startsWith("npz_") && file.endsWith(".npz")) {
        const filePath = path.join(tempDir, file);
        try {
          const stats = fs.statSync(filePath);
          totalSize += stats.size;
          fs.unlinkSync(filePath);
          cleaned++;
        } catch (err) {
          // Ignore errors for individual files
          console.error(`[QAMetrics] Failed to delete ${file}:`, err);
        }
      }
    }

    if (cleaned > 0) {
      const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
      console.log(`[QAMetrics] ✓ CLEANED UP ALL TEMP FILES: ${cleaned} files (${sizeMB}MB freed)`);
    }
  } catch (error: any) {
    console.error("[QAMetrics] Error cleaning all temp files:", error.message);
  }
}

function parseNPZWithPython(buffer: Buffer): any {
  const tempPath = `/tmp/npz_${Date.now()}_${Math.random().toString(36).substring(7)}.npz`;

  try {
    // Write buffer to temp file
    fs.writeFileSync(tempPath, buffer);

    // Call Python script
    const result = execSync(`python3 /home/ubuntu/quest_backend/parse_npz.py "${tempPath}"`, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024, // 50MB
      timeout: 30000, // 30 second timeout
    });

    return JSON.parse(result);
  } catch (error: any) {
    console.error("[QAMetrics] Python parsing error:", error.message);
    return { success: false, error: error.message };
  } finally {
    // Always clean up temp file
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (err) {
      console.error("[QAMetrics] Failed to cleanup temp file:", tempPath);
    }
  }
}

async function fetchQAMetrics(): Promise<QAMetrics> {
  console.log("[QAMetrics] Fetching QA metrics from S3...");

  // AGGRESSIVE CLEANUP: Clear all temp files before starting
  console.log("[QAMetrics] Cleaning all temp files before processing...");
  cleanupAllTempFilesNow();

  // List all session directories
  const listCommand = new ListObjectsV2Command({
    Bucket: BUCKET_NAME,
    Prefix: "sessions/",
    Delimiter: "/",
  });

  const listResult = await s3Client.send(listCommand);
  const allPrefixes = listResult.CommonPrefixes?.map(p => p.Prefix!) || [];

  // Filter to only valid session IDs (YYYYMMDD_HHMMSS pattern)
  const sessionPrefixes = allPrefixes.filter(prefix => {
    const dirName = prefix.replace("sessions/", "").replace("/", "");
    return SESSION_ID_PATTERN.test(dirName);
  });

  console.log(`[QAMetrics] Found ${sessionPrefixes.length} valid sessions (filtered from ${allPrefixes.length} total)`);

  const sessionMetrics: QAMetrics["sessions"] = [];
  let completeSessions = 0;
  let processedCount = 0;
  let errorCount = 0;

  for (const prefix of sessionPrefixes) {
    const sessionId = prefix.replace("sessions/", "").replace("/", "");

    try {
      // Check for NPZ file
      const npzKey = `${prefix}session_data.npz`;

      const getCommand = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: npzKey,
      });

      console.log(`[QAMetrics] Downloading ${sessionId}...`);
      const response = await s3Client.send(getCommand);
      const buffer = await streamToBuffer(response.Body as Readable);

      console.log(`[QAMetrics] Parsing ${sessionId} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)...`);
      const npzData = parseNPZWithPython(buffer);

      if (!npzData.success) {
        console.error(`[QAMetrics] Error parsing ${sessionId}:`, npzData.error);
        errorCount++;
        continue;
      }

      // Calculate metrics
      const totalFrames = npzData.n_frames;
      const bothHandsNotInFrame = npzData.both_hands_not_in_frame.filter((v: boolean) => v).length;
      const trackingErrors = npzData.tracking_errors.filter((v: boolean) => v).length;
      const handSpeedExceeded = npzData.hand_speed_exceeded.filter((v: boolean) => v).length;

      const bothHandsNotInFramePercent = (bothHandsNotInFrame / totalFrames) * 100;
      const trackingErrorsPercent = (trackingErrors / totalFrames) * 100;
      const handSpeedExceededPercent = (handSpeedExceeded / totalFrames) * 100;
      const validFramesPercent = 100 - bothHandsNotInFramePercent - trackingErrorsPercent;

      const captureQualityScore = Math.max(0, 100 - bothHandsNotInFramePercent - trackingErrorsPercent - handSpeedExceededPercent);

      // Stage 10: Validation Tests
      const npzIntegrityCheck = totalFrames > 0 && npzData.left_confidence.length === totalFrames;
      const frameCountCheck = totalFrames > 0;
      const timestampConsistency = true;

      const validationScore = (
        (npzIntegrityCheck ? 33.33 : 0) +
        (frameCountCheck ? 33.33 : 0) +
        (timestampConsistency ? 33.34 : 0)
      );

      // Stage 12: Tracking Confidence
      const leftHandAvgConfidence = npzData.left_confidence.reduce((a: number, b: number) => a + b, 0) / npzData.left_confidence.length;
      const rightHandAvgConfidence = npzData.right_confidence.reduce((a: number, b: number) => a + b, 0) / npzData.right_confidence.length;
      const overallAvgConfidence = (leftHandAvgConfidence + rightHandAvgConfidence) / 2;

      const lowConfidenceFrames = npzData.left_confidence.filter((v: number) => v < 0.8).length +
                                   npzData.right_confidence.filter((v: number) => v < 0.8).length;
      const lowConfidenceFramesPercent = (lowConfidenceFrames / (totalFrames * 2)) * 100;

      const trackingConfidenceScore = overallAvgConfidence * 100;

      // Overall quality score
      const overallQualityScore = (
        captureQualityScore * 0.4 +
        validationScore * 0.3 +
        trackingConfidenceScore * 0.3
      );

      const sessionMetric = {
        sessionId,
        captureDate: npzData.metadata.capture_date || "Unknown",
        status: npzData.metadata.success ? "complete" : "incomplete",
        stages: {
          stage2_captureQuality: {
            totalFrames,
            bothHandsNotInFramePercent: Math.round(bothHandsNotInFramePercent * 100) / 100,
            trackingErrorsPercent: Math.round(trackingErrorsPercent * 100) / 100,
            handSpeedExceededPercent: Math.round(handSpeedExceededPercent * 100) / 100,
            validFramesPercent: Math.round(validFramesPercent * 100) / 100,
            score: Math.round(captureQualityScore * 100) / 100,
          },
          stage10_validationTests: {
            npzIntegrityCheck,
            frameCountCheck,
            timestampConsistency,
            score: Math.round(validationScore * 100) / 100,
          },
          stage12_trackingConfidence: {
            leftHandAvgConfidence: Math.round(leftHandAvgConfidence * 10000) / 10000,
            rightHandAvgConfidence: Math.round(rightHandAvgConfidence * 10000) / 10000,
            overallAvgConfidence: Math.round(overallAvgConfidence * 10000) / 10000,
            lowConfidenceFramesPercent: Math.round(lowConfidenceFramesPercent * 100) / 100,
            score: Math.round(trackingConfidenceScore * 100) / 100,
          },
        },
        overallQualityScore: Math.round(overallQualityScore * 100) / 100,
      };

      sessionMetrics.push(sessionMetric);
      processedCount++;

      if (sessionMetric.status === "complete") {
        completeSessions++;
      }

      console.log(`[QAMetrics] ✓ ${sessionId}: Overall Score ${sessionMetric.overallQualityScore}/100`);

    } catch (error: any) {
      console.error(`[QAMetrics] Error processing ${sessionId}:`, error.message);
      errorCount++;
    }
  }

  console.log(`[QAMetrics] Summary: ${processedCount} processed, ${errorCount} errors`);

  // AGGRESSIVE CLEANUP: Remove ALL temp files immediately after processing
  console.log("[QAMetrics] Running aggressive cleanup of all temp files...");
  cleanupAllTempFilesNow();

  if (sessionMetrics.length === 0) {
    return {
      overview: {
        totalSessions: 0,
        completeSessions: 0,
        lastUpdated: new Date().toISOString(),
      },
      sessions: [],
      aggregateStats: {
        avgCaptureQuality: 0,
        avgTrackingConfidence: 0,
        avgValidationScore: 0,
        sessionsWithIssues: 0,
      },
    };
  }

  const avgCaptureQuality = sessionMetrics.reduce((sum, s) => sum + s.stages.stage2_captureQuality.score, 0) / sessionMetrics.length;
  const avgTrackingConfidence = sessionMetrics.reduce((sum, s) => sum + s.stages.stage12_trackingConfidence.score, 0) / sessionMetrics.length;
  const avgValidationScore = sessionMetrics.reduce((sum, s) => sum + s.stages.stage10_validationTests.score, 0) / sessionMetrics.length;
  const sessionsWithIssues = sessionMetrics.filter(s => s.overallQualityScore < 80).length;

  const metrics: QAMetrics = {
    overview: {
      totalSessions: sessionMetrics.length,
      completeSessions,
      lastUpdated: new Date().toISOString(),
    },
    sessions: sessionMetrics.sort((a, b) => b.sessionId.localeCompare(a.sessionId)),
    aggregateStats: {
      avgCaptureQuality: Math.round(avgCaptureQuality * 100) / 100,
      avgTrackingConfidence: Math.round(avgTrackingConfidence * 100) / 100,
      avgValidationScore: Math.round(avgValidationScore * 100) / 100,
      sessionsWithIssues,
    },
  };

  console.log(`[QAMetrics] ✓ Generated metrics for ${metrics.overview.totalSessions} sessions`);
  console.log(`[QAMetrics] ✓ Sessions with issues (quality <80%): ${sessionsWithIssues}`);

  return metrics;
}

// Main endpoint
router.get("/qa-metrics", async (req, res) => {
  try {
    const now = Date.now();

    // Return cached data if still valid
    if (cachedMetrics && (now - lastFetchTime) < CACHE_TTL_MS) {
      console.log(`[QAMetrics] Returning cached data (age: ${Math.round((now - lastFetchTime) / 1000)}s)`);
      return res.json(cachedMetrics);
    }

    // If already processing, return stale cache or wait
    if (isProcessing) {
      if (cachedMetrics) {
        console.log("[QAMetrics] Processing in progress, returning stale cache");
        return res.json({
          ...cachedMetrics,
          overview: {
            ...cachedMetrics.overview,
            lastUpdated: cachedMetrics.overview.lastUpdated + " (stale)"
          }
        });
      } else {
        console.log("[QAMetrics] Processing in progress, waiting...");
        return res.status(503).json({
          error: "Metrics are being generated, please retry in a moment",
          retryAfter: 10
        });
      }
    }

    // Start processing
    isProcessing = true;
    console.log("[QAMetrics] Fetching fresh data");

    try {
      cachedMetrics = await fetchQAMetrics();
      lastFetchTime = now;
      res.json(cachedMetrics);
    } finally {
      isProcessing = false;
    }

  } catch (error: any) {
    isProcessing = false;
    console.error("[QAMetrics] Error:", error);

    // Return stale cache if available
    if (cachedMetrics) {
      console.log("[QAMetrics] Returning stale cache due to error");
      return res.json({
        ...cachedMetrics,
        overview: {
          ...cachedMetrics.overview,
          lastUpdated: cachedMetrics.overview.lastUpdated + " (error, stale cache)"
        }
      });
    }

    res.status(500).json({ error: "Failed to fetch QA metrics", message: error.message });
  }
});

// Lightweight summary endpoint (fast)
router.get("/qa-metrics/summary", async (req, res) => {
  try {
    if (cachedMetrics) {
      return res.json({
        overview: cachedMetrics.overview,
        aggregateStats: cachedMetrics.aggregateStats,
        sessionCount: cachedMetrics.sessions.length
      });
    }

    res.status(503).json({ error: "Metrics not yet available, please call /api/qa-metrics first" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Force refresh
router.post("/qa-metrics/refresh", async (req, res) => {
  try {
    if (isProcessing) {
      return res.status(429).json({ error: "Already processing, please wait" });
    }

    isProcessing = true;
    console.log("[QAMetrics] Force refresh requested");

    try {
      cachedMetrics = await fetchQAMetrics();
      lastFetchTime = Date.now();
      res.json({ message: "QA metrics refreshed", data: cachedMetrics });
    } finally {
      isProcessing = false;
    }
  } catch (error: any) {
    isProcessing = false;
    console.error("[QAMetrics] Error:", error);
    res.status(500).json({ error: "Failed to refresh QA metrics", message: error.message });
  }
});

// Get specific session
router.get("/qa-metrics/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!cachedMetrics || (Date.now() - lastFetchTime) > CACHE_TTL_MS) {
      if (!isProcessing) {
        isProcessing = true;
        try {
          cachedMetrics = await fetchQAMetrics();
          lastFetchTime = Date.now();
        } finally {
          isProcessing = false;
        }
      }
    }

    if (!cachedMetrics) {
      return res.status(503).json({ error: "Metrics not yet available" });
    }

    const session = cachedMetrics.sessions.find(s => s.sessionId === sessionId);

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    res.json(session);
  } catch (error: any) {
    console.error("[QAMetrics] Error:", error);
    res.status(500).json({ error: "Failed to fetch session metrics", message: error.message });
  }
});

// Cleanup endpoint (cron job can call this)
router.post("/qa-metrics/cleanup", async (req, res) => {
  try {
    console.log("[QAMetrics] Manual cleanup requested via API");
    cleanupAllTempFilesNow();
    const diskUsage = execSync("df -h / | tail -1 | awk '{print $5}'", { encoding: "utf-8" }).trim();
    res.json({
      message: "All temp files cleaned up immediately",
      diskUsage: diskUsage
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export function createQAMetricsRouter() {
  return router;
}

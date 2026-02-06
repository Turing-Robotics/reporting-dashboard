/**
 * S3 Statistics API Endpoint
 * Provides comprehensive S3 bucket analytics for Grafana dashboard
 */

import { Router, Request, Response } from "express";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

interface S3Stats {
  overview: {
    totalFiles: number;
    totalSizeGB: number;
    totalSizeBytes: number;
    averageFileSizeMB: number;
    lastUpdated: string;
  };
  byType: {
    [key: string]: {
      count: number;
      sizeGB: number;
      percentage: number;
    };
  };
  sessions: {
    total: number;
    complete: number;
    incomplete: number;
    sessions: Array<{
      id: string;
      files: number;
      sizeGB: number;
      hasMp4: boolean;
      hasNpz: boolean;
      status: string;
    }>;
  };
  processedOutputs: {
    count: number;
    sizeGB: number;
    files: Array<{
      name: string;
      sizeGB: number;
      date: string;
    }>;
  };
  timeline: Array<{
    date: string;
    files: number;
    sizeGB: number;
    mp4Count: number;
    npzCount: number;
    zipCount: number;
  }>;
  costs: {
    currentMonthly: number;
    intelligentTiering: number;
    glacierDeepArchive: number;
    costPerSession: number;
  };
  insights: {
    videoStats: {
      count: number;
      minGB: number;
      maxGB: number;
      avgGB: number;
      medianGB: number;
    };
    npzStats: {
      count: number;
      minMB: number;
      maxMB: number;
      avgMB: number;
      medianMB: number;
    };
  };
}

// Cache to avoid hitting S3 API too frequently
let cachedStats: S3Stats | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchS3Statistics(): Promise<S3Stats> {
  const now = Date.now();
  
  // Return cached data if still fresh
  if (cachedStats && (now - lastFetchTime) < CACHE_TTL_MS) {
    return cachedStats;
  }

  console.log("[S3Stats] Fetching fresh data from S3...");

  const s3Client = new S3Client({
    region: process.env.AWS_REGION || "eu-west-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });

  const bucketName = process.env.S3_BUCKET_NAME || "turing-robotics-datahub";

  // List all objects
  const command = new ListObjectsV2Command({ Bucket: bucketName });
  const response = await s3Client.send(command);
  const files = response.Contents || [];

  // Calculate overall stats
  const totalFiles = files.length;
  const totalSizeBytes = files.reduce((sum, f) => sum + (f.Size || 0), 0);
  const totalSizeGB = totalSizeBytes / (1024 ** 3);
  const averageFileSizeMB = (totalSizeBytes / totalFiles) / (1024 ** 2);

  // By file type
  const byType: { [key: string]: { count: number; size: number } } = {};
  files.forEach((f) => {
    const ext = f.Key?.split(".").pop()?.toLowerCase() || "other";
    if (!byType[ext]) byType[ext] = { count: 0, size: 0 };
    byType[ext].count++;
    byType[ext].size += f.Size || 0;
  });

  const byTypeFormatted: S3Stats["byType"] = {};
  Object.entries(byType).forEach(([ext, data]) => {
    byTypeFormatted[ext] = {
      count: data.count,
      sizeGB: data.size / (1024 ** 3),
      percentage: (data.size / totalSizeBytes) * 100,
    };
  });

  // Sessions analysis
  const sessions: { [key: string]: any } = {};
  files.forEach((f) => {
    if (f.Key?.includes("sessions/") && !f.Key.includes("client_output")) {
      const parts = f.Key.split("/");
      if (parts.length >= 3) {
        const sessionId = parts[1];
        if (!sessions[sessionId]) {
          sessions[sessionId] = {
            files: [],
            size: 0,
            hasMp4: false,
            hasNpz: false,
          };
        }
        sessions[sessionId].files.push(f);
        sessions[sessionId].size += f.Size || 0;
        if (f.Key.endsWith(".mp4")) sessions[sessionId].hasMp4 = true;
        if (f.Key.endsWith(".npz")) sessions[sessionId].hasNpz = true;
      }
    }
  });

  const sessionsList = Object.entries(sessions).map(([id, data]) => ({
    id,
    files: data.files.length,
    sizeGB: data.size / (1024 ** 3),
    hasMp4: data.hasMp4,
    hasNpz: data.hasNpz,
    status: data.hasMp4 && data.hasNpz ? "complete" : "incomplete",
  }));

  const completeSessions = sessionsList.filter((s) => s.status === "complete");

  // Processed outputs
  const processedFiles = files.filter(
    (f) => f.Key?.includes("client_output") && f.Key.endsWith(".zip")
  );
  const processedOutputs = {
    count: processedFiles.length,
    sizeGB: processedFiles.reduce((sum, f) => sum + (f.Size || 0), 0) / (1024 ** 3),
    files: processedFiles.map((f) => ({
      name: f.Key?.split("/").pop() || "",
      sizeGB: (f.Size || 0) / (1024 ** 3),
      date: f.LastModified?.toISOString().split("T")[0] || "",
    })),
  };

  // Timeline
  const timelineMap: { [date: string]: any } = {};
  files.forEach((f) => {
    const date = f.LastModified?.toISOString().split("T")[0] || "";
    if (!timelineMap[date]) {
      timelineMap[date] = { files: 0, size: 0, mp4: 0, npz: 0, zip: 0 };
    }
    timelineMap[date].files++;
    timelineMap[date].size += f.Size || 0;
    if (f.Key?.endsWith(".mp4")) timelineMap[date].mp4++;
    if (f.Key?.endsWith(".npz")) timelineMap[date].npz++;
    if (f.Key?.endsWith(".zip")) timelineMap[date].zip++;
  });

  const timeline = Object.entries(timelineMap)
    .map(([date, data]) => ({
      date,
      files: data.files,
      sizeGB: data.size / (1024 ** 3),
      mp4Count: data.mp4,
      npzCount: data.npz,
      zipCount: data.zip,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Costs
  const costStandard = totalSizeGB * 0.023;
  const costIntelligent = totalSizeGB * 0.0195;
  const costGlacier = totalSizeGB * 0.00099;
  const costPerSession = completeSessions.length > 0 ? costStandard / completeSessions.length : 0;

  // Video and NPZ stats
  const videoSizes = sessionsList
    .map((s) => s.sizeGB * 0.87) // Approximate video portion
    .filter((s) => s > 0);
  const npzSizes = sessionsList
    .map((s) => s.sizeGB * 0.13 * 1024) // Approximate NPZ portion in MB
    .filter((s) => s > 0);

  const median = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  const stats: S3Stats = {
    overview: {
      totalFiles,
      totalSizeGB,
      totalSizeBytes,
      averageFileSizeMB,
      lastUpdated: new Date().toISOString(),
    },
    byType: byTypeFormatted,
    sessions: {
      total: sessionsList.length,
      complete: completeSessions.length,
      incomplete: sessionsList.length - completeSessions.length,
      sessions: sessionsList,
    },
    processedOutputs,
    timeline,
    costs: {
      currentMonthly: costStandard,
      intelligentTiering: costIntelligent,
      glacierDeepArchive: costGlacier,
      costPerSession,
    },
    insights: {
      videoStats: {
        count: videoSizes.length,
        minGB: Math.min(...videoSizes),
        maxGB: Math.max(...videoSizes),
        avgGB: videoSizes.reduce((a, b) => a + b, 0) / videoSizes.length,
        medianGB: median(videoSizes),
      },
      npzStats: {
        count: npzSizes.length,
        minMB: Math.min(...npzSizes),
        maxMB: Math.max(...npzSizes),
        avgMB: npzSizes.reduce((a, b) => a + b, 0) / npzSizes.length,
        medianMB: median(npzSizes),
      },
    },
  };

  cachedStats = stats;
  lastFetchTime = now;

  console.log(`[S3Stats] Fetched ${totalFiles} files, ${totalSizeGB.toFixed(2)} GB`);
  return stats;
}

export function createS3StatsRouter(): Router {
  const router = Router();

  // Main endpoint - returns all statistics
  router.get("/s3-stats", async (req: Request, res: Response) => {
    try {
      const stats = await fetchS3Statistics();
      res.json(stats);
    } catch (error) {
      console.error("[S3Stats] Error fetching statistics:", error);
      res.status(500).json({ error: "Failed to fetch S3 statistics" });
    }
  });

  // Grafana-specific endpoints for different panels
  router.get("/s3-stats/overview", async (req: Request, res: Response) => {
    try {
      const stats = await fetchS3Statistics();
      res.json(stats.overview);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch overview" });
    }
  });

  router.get("/s3-stats/sessions", async (req: Request, res: Response) => {
    try {
      const stats = await fetchS3Statistics();
      res.json(stats.sessions);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch sessions" });
    }
  });

  router.get("/s3-stats/timeline", async (req: Request, res: Response) => {
    try {
      const stats = await fetchS3Statistics();
      res.json(stats.timeline);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch timeline" });
    }
  });

  // Force refresh cache
  router.post("/s3-stats/refresh", async (req: Request, res: Response) => {
    try {
      lastFetchTime = 0; // Invalidate cache
      const stats = await fetchS3Statistics();
      res.json({ success: true, stats });
    } catch (error) {
      res.status(500).json({ error: "Failed to refresh statistics" });
    }
  });

  return router;
}

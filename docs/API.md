# Quest VR Backend API Documentation

**Version:** 2.3
**Server Port:** 3200
**Last Updated:** 2026-02-06

---

## Table of Contents

1. [Authentication](#authentication)
2. [REST API Endpoints](#rest-api-endpoints)
   - [Health & Metrics](#health--metrics)
   - [Authentication Routes](#authentication-routes)
   - [Device Management](#device-management)
   - [Session Management](#session-management)
   - [File Upload](#file-upload)
   - [S3 Statistics (Admin)](#s3-statistics-admin)
   - [QA Metrics (Admin)](#qa-metrics-admin)
3. [Socket.IO Events](#socketio-events)
   - [Headset Events](#headset-events)
   - [Tablet Events](#tablet-events)
   - [Dashboard Events](#dashboard-events)
   - [Session Events](#session-events)
4. [Prometheus Metrics](#prometheus-metrics)
5. [Rate Limiting](#rate-limiting)
6. [Error Handling](#error-handling)

---

## Authentication

### JWT Authentication

The server uses JWT tokens for authentication. All Socket.IO connections and protected REST endpoints require valid JWT tokens.

**Token Expiry:** 24 hours

**Header Format (REST):**
```
Authorization: Bearer <jwt_token>
```

**Socket.IO Auth:**
```javascript
const socket = io('http://server:3200', {
  auth: {
    token: '<jwt_token>'
  }
});
```

### Admin API Key

Admin endpoints require an API key in the `X-API-Key` header:
```
X-API-Key: <admin_api_key>
```

---

## REST API Endpoints

### Health & Metrics

#### GET /test
Health check endpoint.

**Rate Limit:** 60 requests/minute
**Authentication:** None

**Response:**
```json
{
  "ok": true,
  "message": "Turing Backend v2.2 - Secure Multi-Device Support",
  "time": "2026-02-06T12:00:00.000Z"
}
```

---

#### GET /health
System health with memory metrics.

**Authentication:** None

**Response:**
```json
{
  "ok": true,
  "uptime": 123456.789,
  "memoryUsage": {
    "rss": 123456789,
    "heapTotal": 12345678,
    "heapUsed": 1234567,
    "external": 12345
  },
  "timestamp": "2026-02-06T12:00:00.000Z"
}
```

---

#### GET /metrics
Prometheus metrics endpoint.

**Rate Limit:** 30 requests/minute
**Authentication:** None
**Content-Type:** `text/plain; version=0.0.4; charset=utf-8`

Returns Prometheus-formatted metrics (see [Prometheus Metrics](#prometheus-metrics)).

---

### Authentication Routes

#### POST /auth/device-token
Request a JWT token for device authentication.

**Rate Limit:** 20 requests/minute
**Authentication:** None (public endpoint)

**Request Body:**
```json
{
  "deviceId": "QUEST_001",
  "deviceType": "headset"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `deviceId` | string | Yes | Unique identifier (8-64 alphanumeric chars) |
| `deviceType` | string | Yes | One of: `headset`, `tablet`, `dashboard` |

**Response:**
```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "deviceId": "QUEST_001",
  "deviceType": "headset",
  "expiresIn": "24h"
}
```

---

#### POST /auth/verify-token
Verify if a JWT token is valid.

**Authentication:** None

**Request Body:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response (valid):**
```json
{
  "ok": true,
  "valid": true,
  "deviceId": "QUEST_001",
  "deviceType": "headset"
}
```

**Response (invalid):**
```json
{
  "ok": true,
  "valid": false
}
```

---

#### POST /auth/generate-token
Generate a token for a device (admin only).

**Authentication:** Admin API Key (`X-API-Key`)

**Request Body:**
```json
{
  "deviceId": "QUEST_001",
  "deviceType": "headset"
}
```

**Response:**
```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "deviceId": "QUEST_001",
  "deviceType": "headset",
  "expiresIn": "24h"
}
```

---

### Device Management

#### GET /api/devices
Get all devices in the fleet.

**Rate Limit:** 100 requests/minute
**Authentication:** None

**Response:**
```json
{
  "ok": true,
  "count": 5,
  "devices": [
    {
      "deviceId": "QUEST_001",
      "isOnline": true,
      "lastSeen": "2026-02-06T12:00:00.000Z",
      "connectionTime": "2026-02-06T10:00:00.000Z",
      "telemetry": { ... },
      "isLocked": true,
      "lockedByTabletId": "socket_abc123"
    }
  ]
}
```

---

#### GET /api/devices/:deviceId
Get details for a specific device.

**Response:**
```json
{
  "ok": true,
  "device": {
    "deviceId": "QUEST_001",
    "isOnline": true,
    "lastSeen": "2026-02-06T12:00:00.000Z",
    "connectionTime": "2026-02-06T10:00:00.000Z",
    "telemetry": {
      "batteryLevel": 0.85,
      "batteryState": 2,
      "storageUsedBytes": 5368709120,
      "storageTotalBytes": 128849018880,
      "wifiSignalLevel": -45,
      "wifiSSID": "Lab-Network",
      "appVersion": "1.2.3",
      "osVersion": "62.0",
      "isRecording": false,
      "leftHandTracked": true,
      "rightHandTracked": true,
      "bodyTracked": true,
      "trackingConfidence": 0.95
    },
    "isLocked": false,
    "lockedByTabletId": null
  }
}
```

**Error (404):**
```json
{
  "ok": false,
  "error": "Device not found"
}
```

---

#### GET /api/devices/:deviceId/history
Get telemetry history for a device (for charts).

**Response:**
```json
{
  "ok": true,
  "deviceId": "QUEST_001",
  "count": 288,
  "history": [
    {
      "timestamp": 1707235200000,
      "batteryLevel": 0.95,
      "trackingConfidence": 0.92,
      ...
    }
  ]
}
```

---

#### POST /api/devices/:deviceId/name
Set a custom name for a device.

**Request Body:**
```json
{
  "customName": "Lab Quest #1"
}
```

**Response:**
```json
{
  "ok": true,
  "customName": "Lab Quest #1"
}
```

---

#### GET /api/fleet/summary
Get fleet summary statistics.

**Response:**
```json
{
  "ok": true,
  "summary": {
    "totalDevices": 10,
    "onlineDevices": 8,
    "offlineDevices": 2,
    "recordingDevices": 3,
    "lowBatteryDevices": 1,
    "lockedDevices": 4,
    "avgBatteryLevel": 0.72,
    "totalProductiveTime": 86400,
    "appVersions": ["1.2.3", "1.2.4"]
  }
}
```

---

### Session Management

#### GET /api/sessions
Get all capture sessions.

**Response:**
```json
{
  "ok": true,
  "count": 5,
  "sessions": [
    {
      "sessionId": "session_1707235200000_abc123",
      "status": "completed",
      "deviceCount": 3,
      "createdAt": "2026-02-06T10:00:00.000Z",
      "startedAt": "2026-02-06T10:01:00.000Z",
      "endedAt": "2026-02-06T11:00:00.000Z"
    }
  ]
}
```

---

#### GET /api/sessions/:sessionId
Get details for a specific session.

**Response:**
```json
{
  "ok": true,
  "session": {
    "sessionId": "session_1707235200000_abc123",
    "status": "recording",
    "deviceIds": ["QUEST_001", "QUEST_002"],
    "deviceStatuses": [
      {
        "deviceId": "QUEST_001",
        "isRecording": true,
        "frameCount": 5400,
        "uploadProgress": 0,
        "uploadStatus": "pending",
        "deviceInfo": { ... }
      }
    ],
    "createdAt": "2026-02-06T10:00:00.000Z",
    "startedAt": "2026-02-06T10:01:00.000Z",
    "endedAt": null,
    "metadata": {
      "participantName": "John Doe",
      "studyId": "STUDY_001"
    }
  }
}
```

---

### File Upload

#### POST /upload-session
Upload session files (video and data) in a single request.

**Rate Limit:** 10 requests/15 minutes
**Content-Type:** `multipart/form-data`
**Max File Size:** 20 GB per file

**Form Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `timestamp` | string | Yes | Session timestamp (e.g., `20260206_120000`) |
| `sessionId` | string | No | Optional session identifier |
| `video` | file | Yes | MP4 video file |
| `data` | file | Yes | NPZ data file |

**Response:**
```json
{
  "ok": true,
  "sessionId": "1707235200000",
  "timestamp": "20260206_120000",
  "mp4": {
    "bucket": "turing-robotics-datahub",
    "key": "sessions/20260206_120000/recording.mp4",
    "location": "https://s3.eu-west-1.amazonaws.com/...",
    "etag": "\"abc123...\""
  },
  "npz": {
    "bucket": "turing-robotics-datahub",
    "key": "sessions/20260206_120000/session_data.npz",
    "location": "https://s3.eu-west-1.amazonaws.com/...",
    "etag": "\"def456...\""
  }
}
```

---

#### POST /chunked-upload/start
Start a chunked multipart upload for large files.

**Request Body:**
```json
{
  "timestamp": "20260206_120000",
  "fileType": "video",
  "fileSize": 5368709120,
  "fileName": "recording.mp4"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `timestamp` | string | Yes | Session timestamp |
| `fileType` | string | Yes | `video` or `data` |
| `fileSize` | number | Yes | Total file size in bytes |
| `fileName` | string | No | Original filename |

**Response:**
```json
{
  "ok": true,
  "uploadId": "abc123xyz...",
  "s3Key": "sessions/20260206_120000/recording.mp4",
  "totalParts": 512,
  "chunkSize": 10485760,
  "presignedUrls": [
    { "partNumber": 1, "url": "https://s3.amazonaws.com/...?X-Amz-Signature=..." },
    { "partNumber": 2, "url": "https://s3.amazonaws.com/...?X-Amz-Signature=..." }
  ]
}
```

---

#### GET /chunked-upload/status
Get upload progress for resuming uploads.

**Query Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `uploadId` | string | Yes | The upload ID from start |
| `s3Key` | string | Yes | The S3 key from start |

**Response:**
```json
{
  "ok": true,
  "uploadId": "abc123xyz...",
  "s3Key": "sessions/20260206_120000/recording.mp4",
  "uploadedParts": [
    { "partNumber": 1, "etag": "\"abc...\"", "size": 10485760 },
    { "partNumber": 2, "etag": "\"def...\"", "size": 10485760 }
  ]
}
```

---

#### POST /chunked-upload/presign-part
Get a presigned URL for a single part (for retries).

**Request Body:**
```json
{
  "uploadId": "abc123xyz...",
  "s3Key": "sessions/20260206_120000/recording.mp4",
  "partNumber": 5
}
```

**Response:**
```json
{
  "ok": true,
  "partNumber": 5,
  "url": "https://s3.amazonaws.com/...?X-Amz-Signature=..."
}
```

---

#### POST /chunked-upload/complete
Complete a chunked upload.

**Request Body:**
```json
{
  "uploadId": "abc123xyz...",
  "s3Key": "sessions/20260206_120000/recording.mp4",
  "parts": [
    { "partNumber": 1, "etag": "\"abc123...\"" },
    { "partNumber": 2, "etag": "\"def456...\"" }
  ]
}
```

**Response:**
```json
{
  "ok": true,
  "s3Key": "sessions/20260206_120000/recording.mp4",
  "bucket": "turing-robotics-datahub",
  "location": "https://s3.eu-west-1.amazonaws.com/...",
  "etag": "\"final-etag...\""
}
```

---

#### POST /chunked-upload/abort
Abort a chunked upload.

**Request Body:**
```json
{
  "uploadId": "abc123xyz...",
  "s3Key": "sessions/20260206_120000/recording.mp4"
}
```

**Response:**
```json
{
  "ok": true,
  "message": "Upload aborted successfully"
}
```

---

### S3 Statistics (Admin)

All `/api/s3-stats/*` endpoints require Admin API Key authentication.

#### GET /api/s3-stats
Get comprehensive S3 bucket statistics.

**Response:**
```json
{
  "overview": {
    "totalFiles": 1234,
    "totalSizeGB": 456.78,
    "totalSizeBytes": 490584735744,
    "averageFileSizeMB": 389.5,
    "lastUpdated": "2026-02-06T12:00:00.000Z"
  },
  "byType": {
    "mp4": { "count": 200, "sizeGB": 400, "percentage": 87.5 },
    "npz": { "count": 200, "sizeGB": 50, "percentage": 10.9 },
    "zip": { "count": 34, "sizeGB": 6.78, "percentage": 1.6 }
  },
  "sessions": {
    "total": 200,
    "complete": 180,
    "incomplete": 20,
    "sessions": [...]
  },
  "processedOutputs": {
    "count": 34,
    "sizeGB": 6.78,
    "files": [...]
  },
  "timeline": [...],
  "costs": {
    "currentMonthly": 10.51,
    "intelligentTiering": 8.91,
    "glacierDeepArchive": 0.45,
    "costPerSession": 0.058
  },
  "insights": {
    "videoStats": { "count": 180, "minGB": 0.5, "maxGB": 5.2, "avgGB": 2.2, "medianGB": 2.0 },
    "npzStats": { "count": 180, "minMB": 50, "maxMB": 500, "avgMB": 280, "medianMB": 260 }
  }
}
```

---

#### GET /api/s3-stats/overview
Get only the overview section.

#### GET /api/s3-stats/sessions
Get only the sessions section.

#### GET /api/s3-stats/timeline
Get only the timeline section.

#### POST /api/s3-stats/refresh
Force refresh the cached S3 statistics.

---

### QA Metrics (Admin)

All `/api/qa-metrics/*` endpoints require Admin API Key authentication.

#### GET /api/qa-metrics
Get comprehensive QA metrics for all sessions.

**Response:**
```json
{
  "overview": {
    "totalSessions": 180,
    "completeSessions": 175,
    "lastUpdated": "2026-02-06T12:00:00.000Z"
  },
  "sessions": [
    {
      "sessionId": "20260206_120000",
      "captureDate": "2026-02-06",
      "status": "complete",
      "stages": {
        "stage2_captureQuality": {
          "totalFrames": 5400,
          "bothHandsNotInFramePercent": 2.5,
          "trackingErrorsPercent": 1.2,
          "handSpeedExceededPercent": 0.8,
          "validFramesPercent": 95.5,
          "score": 95.5
        },
        "stage10_validationTests": {
          "npzIntegrityCheck": true,
          "frameCountCheck": true,
          "timestampConsistency": true,
          "score": 100
        },
        "stage12_trackingConfidence": {
          "leftHandAvgConfidence": 0.92,
          "rightHandAvgConfidence": 0.94,
          "overallAvgConfidence": 0.93,
          "lowConfidenceFramesPercent": 3.5,
          "score": 93
        }
      },
      "overallQualityScore": 95.65
    }
  ],
  "aggregateStats": {
    "avgCaptureQuality": 92.5,
    "avgTrackingConfidence": 91.8,
    "avgValidationScore": 98.5,
    "sessionsWithIssues": 12
  }
}
```

---

#### GET /api/qa-metrics/summary
Get lightweight summary (fast, no processing).

#### GET /api/qa-metrics/:sessionId
Get QA metrics for a specific session.

#### POST /api/qa-metrics/refresh
Force refresh QA metrics (CPU intensive).

#### POST /api/qa-metrics/cleanup
Clean up temporary NPZ files on server.

---

## Socket.IO Events

### Connection

```javascript
const socket = io('http://server:3200', {
  transports: ['websocket', 'polling'],
  auth: { token: 'your-jwt-token' }
});
```

---

### Headset Events

#### headset-identify
**Direction:** Client -> Server
**Purpose:** Register a headset with the server

**Payload:**
```javascript
socket.emit('headset-identify', 'QUEST_001');
```

**Server Response Events:**
- `on-headset-connected` - Sent to the headset room

---

#### headset-frame
**Direction:** Client -> Server
**Purpose:** Send camera frame data for preview

**Payload:**
```javascript
socket.emit('headset-frame', 'data:image/jpeg;base64,...');
```

**Notes:**
- Rate limited to 120 frames/sec
- Throttled at 16ms intervals (60fps max)
- Max size: 1MB per frame

---

#### headset-status
**Direction:** Client -> Server
**Purpose:** Send status JSON updates (1fps)

**Payload:**
```javascript
socket.emit('headset-status', JSON.stringify({ tracking: 'active', fps: 72 }));
```

**Server Broadcasts:**
- `on-headset-status-updated` - To the headset room

---

#### device-telemetry
**Direction:** Client -> Server
**Purpose:** Send comprehensive device telemetry

**Payload:**
```javascript
socket.emit('device-telemetry', JSON.stringify({
  deviceId: 'QUEST_001',
  deviceName: 'Quest 3',
  timestamp: Date.now(),
  batteryLevel: 0.85,
  batteryState: 2,
  storageUsedBytes: 5368709120,
  storageTotalBytes: 128849018880,
  wifiSignalLevel: -45,
  wifiSSID: 'Lab-Network',
  appVersion: '1.2.3',
  osVersion: '62.0',
  sdkVersion: '60.0',
  leftHandTracked: true,
  rightHandTracked: true,
  bodyTracked: true,
  trackingConfidence: 0.95,
  isRecording: false,
  sessionDuration: 3600,
  productiveTime: 3200,
  frameCount: 216000,
  droppedFrames: 12,
  cpuTemperature: 42.5,
  gpuTemperature: 45.0,
  memoryUsedMB: 2048,
  memoryTotalMB: 6144
}));
```

---

#### headset-recording-state
**Direction:** Client -> Server
**Purpose:** Report recording state changes

**Payload:**
```javascript
socket.emit('headset-recording-state', true); // or false
```

**Server Broadcasts:**
- `on-headset-recording-active` - When recording starts
- `on-headset-recording-inactive` - When recording stops
- `on-device-recording-changed` - `{ deviceId, isRecording }`

---

#### headset-logs-processed
**Direction:** Client -> Server
**Purpose:** Notify that logs have been processed

**Server Broadcasts:**
- `on-headset-logs-processed` - To the headset room

---

### Server -> Headset Events

| Event | Payload | Description |
|-------|---------|-------------|
| `on-headset-connected` | none | Headset successfully registered |
| `on-headset-disconnected` | none | Headset disconnected |
| `on-tablet-recording-toggled` | none | Tablet requested recording toggle |
| `on-tablet-start-recording` | none | Tablet requested start recording |
| `on-tablet-stop-recording` | none | Tablet requested stop recording |
| `on-tablet-metadata-synced` | string (JSON) | Metadata from tablet |
| `on-session-ended` | `{ sessionId }` | Session ended |

---

### Tablet Events

#### tablet-lock-device
**Direction:** Client -> Server
**Purpose:** Lock a single device for exclusive control

**Payload:**
```javascript
socket.emit('tablet-lock-device', 'QUEST_001');
```

**Server Response Events:**
- `on-device-locked` - `{ deviceId }` on success
- `on-device-lock-failed` - `{ deviceId, reason }` on failure

---

#### tablet-unlock-device
**Direction:** Client -> Server
**Purpose:** Unlock a device

**Payload:**
```javascript
socket.emit('tablet-unlock-device', 'QUEST_001');
```

**Server Response:**
- `on-device-unlocked` - `{ deviceId }`

---

#### tablet-lock-devices
**Direction:** Client -> Server
**Purpose:** Lock multiple devices atomically

**Payload:**
```javascript
socket.emit('tablet-lock-devices', ['QUEST_001', 'QUEST_002', 'QUEST_003']);
```

**Server Response:**
- `on-devices-locked` - `{ locked: string[], failed: string[] }`

---

#### tablet-unlock-all-devices
**Direction:** Client -> Server
**Purpose:** Unlock all devices held by this tablet

**Payload:**
```javascript
socket.emit('tablet-unlock-all-devices');
```

**Server Response:**
- `on-all-devices-unlocked` - `{ unlocked: string[] }`

---

#### tablet-start-recording
**Direction:** Client -> Server
**Purpose:** Start recording on a specific device

**Payload:**
```javascript
socket.emit('tablet-start-recording', 'QUEST_001');
```

**Server Response on failure:**
- `on-recording-denied` - `{ deviceId }`

---

#### tablet-stop-recording
**Direction:** Client -> Server
**Purpose:** Stop recording on a specific device

**Payload:**
```javascript
socket.emit('tablet-stop-recording', 'QUEST_001');
```

---

#### tablet-start-all-recording
**Direction:** Client -> Server
**Purpose:** Start recording on all locked devices

**Payload:**
```javascript
socket.emit('tablet-start-all-recording');
```

---

#### tablet-stop-all-recording
**Direction:** Client -> Server
**Purpose:** Stop recording on all locked devices

**Payload:**
```javascript
socket.emit('tablet-stop-all-recording');
```

---

#### tablet-sync-metadata
**Direction:** Client -> Server
**Purpose:** Sync metadata to headset(s)

**Payload:**
```javascript
socket.emit('tablet-sync-metadata', JSON.stringify({
  participant: 'John Doe',
  session: 1,
  notes: 'Test session'
}), 'QUEST_001'); // optional targetDeviceId
```

---

#### tablet-connect-headset (Legacy)
**Direction:** Client -> Server
**Purpose:** Connect to a single headset (backwards compatible)

**Payload:**
```javascript
socket.emit('tablet-connect-headset', 'QUEST_001');
```

---

#### tablet-disconnect-headset (Legacy)
**Direction:** Client -> Server
**Purpose:** Disconnect from a headset

**Payload:**
```javascript
socket.emit('tablet-disconnect-headset', 'QUEST_001');
```

---

#### tablet-get-recording-status
**Direction:** Client -> Server
**Purpose:** Check if a headset is recording

**Payload:**
```javascript
socket.emit('tablet-get-recording-status', 'QUEST_001');
```

**Server Response:**
- `on-recording-active` or `on-recording-inactive`

---

### Server -> Tablet Events

| Event | Payload | Description |
|-------|---------|-------------|
| `on-device-locked` | `{ deviceId }` | Device locked successfully |
| `on-device-lock-failed` | `{ deviceId, reason }` | Lock failed |
| `on-device-unlocked` | `{ deviceId }` | Device unlocked |
| `on-devices-locked` | `{ locked[], failed[] }` | Batch lock result |
| `on-all-devices-unlocked` | `{ unlocked[] }` | All devices unlocked |
| `on-recording-denied` | `{ deviceId }` | Recording action denied |
| `on-device-disconnected` | `{ deviceId }` | Locked device disconnected |
| `on-headset-frame-updated` | string (base64) | Camera frame from headset |
| `on-headset-status-updated` | string (JSON) | Status from headset |

---

### Dashboard Events

#### dashboard-subscribe
**Direction:** Client -> Server
**Purpose:** Subscribe to fleet telemetry updates

**Payload:**
```javascript
socket.emit('dashboard-subscribe');
```

**Server Immediately Sends:**
- `on-fleet-status-updated` - Array of all device states

---

#### dashboard-unsubscribe
**Direction:** Client -> Server
**Purpose:** Unsubscribe from fleet updates

**Payload:**
```javascript
socket.emit('dashboard-unsubscribe');
```

---

### Server -> Dashboard Events

| Event | Payload | Description |
|-------|---------|-------------|
| `on-fleet-status-updated` | `DeviceState[]` | Full fleet status on subscribe |
| `on-device-telemetry-updated` | `DeviceState` | Individual device update |
| `on-device-locks-updated` | `LockStatus[]` | Lock status changes |

---

### Session Events

#### tablet-create-session
**Direction:** Client -> Server
**Purpose:** Create a new capture session with selected devices

**Payload:**
```javascript
socket.emit('tablet-create-session', {
  deviceIds: ['QUEST_001', 'QUEST_002'],
  metadata: {
    participantName: 'John Doe',
    studyId: 'STUDY_001',
    notes: 'Initial capture session'
  }
});
```

**Server Response:**
- `on-session-created` - `{ sessionId, deviceIds, unavailable? }`
- `on-session-error` - `{ error, unavailable? }`

---

#### tablet-start-session
**Direction:** Client -> Server
**Purpose:** Start recording on all session devices

**Payload:**
```javascript
socket.emit('tablet-start-session', 'session_1707235200000_abc123');
```

**Server Response:**
- `on-session-started` - `{ sessionId, startedAt }`
- `on-session-error` - `{ error, sessionId }`

---

#### tablet-pause-session
**Direction:** Client -> Server
**Purpose:** Pause recording on all session devices

**Payload:**
```javascript
socket.emit('tablet-pause-session', 'session_1707235200000_abc123');
```

**Server Response:**
- `on-session-paused` - `{ sessionId }`

---

#### tablet-end-session
**Direction:** Client -> Server
**Purpose:** End the session and stop all devices

**Payload:**
```javascript
socket.emit('tablet-end-session', 'session_1707235200000_abc123');
```

**Server Response:**
- `on-session-ended` - `{ sessionId, endedAt, duration }`

---

#### tablet-get-session
**Direction:** Client -> Server
**Purpose:** Get session status

**Payload:**
```javascript
socket.emit('tablet-get-session', 'session_1707235200000_abc123');
```

**Server Response:**
- `on-session-status` - Full session object
- `on-session-error` - `{ error, sessionId }`

---

#### tablet-get-active-session
**Direction:** Client -> Server
**Purpose:** Get the active session for this tablet

**Payload:**
```javascript
socket.emit('tablet-get-active-session');
```

**Server Response:**
- `on-active-session` - Session object or `null`

---

### Broadcast Events (All Clients)

| Event | Payload | Description |
|-------|---------|-------------|
| `on-headsets-updated` | `string[]` | Device IDs of online headsets |
| `on-headsets-with-lock-status-updated` | `HeadsetInfo[]` | Headsets with lock status |
| `on-device-locks-updated` | `LockStatus[]` | All device lock statuses |

---

## Prometheus Metrics

All metrics are prefixed with `turing_`.

### Device Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `turing_connected_devices_total` | Gauge | `type` | Connected devices by type (headset/tablet) |
| `turing_locked_devices_total` | Gauge | - | Devices locked by tablets |
| `turing_recording_devices_total` | Gauge | - | Devices currently recording |
| `turing_device_connections_total` | Counter | `type`, `event` | Connection events (connect/disconnect) |
| `turing_device_lock_operations_total` | Counter | `operation`, `success` | Lock/unlock operations |
| `turing_fleet_battery_level` | Gauge | `device_id` | Battery level (0-100) |
| `turing_low_battery_devices_total` | Gauge | - | Devices with battery < 20% |

### Session Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `turing_sessions_active_total` | Gauge | - | Active capture sessions |
| `turing_sessions_created_total` | Counter | - | Total sessions created |
| `turing_session_duration_seconds` | Histogram | - | Session duration distribution |

### Upload Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `turing_uploads_in_progress` | Gauge | - | Current uploads |
| `turing_upload_duration_seconds` | Histogram | `file_type` | Upload duration |
| `turing_upload_size_bytes` | Histogram | `file_type` | Upload file sizes |
| `turing_upload_bytes_total` | Counter | `file_type` | Total bytes uploaded |
| `turing_upload_errors_total` | Counter | `error_type` | Upload errors |

### Socket.IO Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `turing_socket_messages_total` | Counter | `event_type`, `direction` | Socket messages |
| `turing_socket_events_total` | Counter | `event` | Events by type |
| `turing_frame_batch_size` | Histogram | - | Frames per batch |
| `turing_frames_dropped_total` | Counter | - | Dropped frames |
| `turing_socket_connection_duration_seconds` | Histogram | `type` | Connection duration |
| `turing_dashboard_subscribers_total` | Gauge | - | Dashboard subscribers |

### HTTP Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `turing_http_requests_total` | Counter | `method`, `route`, `status_code` | HTTP requests |
| `turing_http_request_duration_seconds` | Histogram | `method`, `route`, `status_code` | Request duration |

### Node.js Metrics

Standard `prom-client` default metrics with `turing_` prefix (CPU, memory, event loop, etc.).

---

## Rate Limiting

### REST API Rate Limits

| Endpoint | Window | Max Requests | Notes |
|----------|--------|--------------|-------|
| `/api/*` | 1 minute | 100 | General API |
| `/upload-session` | 15 minutes | 10 | File uploads |
| `/auth/*` | 1 minute | 20 | Authentication |
| `/metrics` | 1 minute | 30 | Prometheus |
| `/health`, `/test` | 1 minute | 60 | Health checks |

**Rate Limit Response (429):**
```json
{
  "ok": false,
  "error": "Too many requests...",
  "retryAfter": 60
}
```

### Socket.IO Rate Limits

| Event | Window | Max Events |
|-------|--------|------------|
| `headset-frame` | 1 second | 120 |
| `headset-status` | 1 second | 10 |
| `headset-identify` | 5 seconds | 3 |
| `device-telemetry` | 1 second | 5 |
| `tablet-lock-devices` | 5 seconds | 5 |
| `tablet-create-session` | 5 seconds | 3 |
| `dashboard-subscribe` | 5 seconds | 5 |
| Default | 1 second | 50 |

Exceeded Socket.IO events are silently dropped with a warning logged.

---

## Error Handling

### Standard Error Response

```json
{
  "ok": false,
  "error": "Error description",
  "retryAfter": 60
}
```

### HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Bad Request - Invalid input |
| 401 | Unauthorized - Missing/invalid token |
| 403 | Forbidden - Invalid API key |
| 404 | Not Found - Resource doesn't exist |
| 413 | Payload Too Large - File too big |
| 429 | Too Many Requests - Rate limited |
| 500 | Internal Server Error |
| 503 | Service Unavailable - Processing |

### Socket.IO Error Events

Most Socket.IO operations emit error events on failure:
- `on-session-error` - `{ error: string, sessionId?: string }`
- `on-device-lock-failed` - `{ deviceId: string, reason: string }`
- `on-recording-denied` - `{ deviceId: string }`

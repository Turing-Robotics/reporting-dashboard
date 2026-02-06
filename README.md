# Capture Backend Server

Real-time data capture and fleet management system for Quest VR headsets. Handles multi-device coordination, video streaming, file uploads, and monitoring.

---

## System Architecture

```mermaid
flowchart TB
    subgraph clients["Client Devices"]
        direction LR
        quest["🥽 Quest VR Headsets"]
        tablet["📱 Tablet Controller"]
        dashboard["🖥️ Dashboard Web UI"]
    end

    subgraph internet["Public Internet"]
        dns["DNS: quest.apidataupload.com"]
    end

    subgraph aws["AWS Cloud (eu-west-1)"]
        subgraph ec2["EC2 Instance (t3.small)"]
            subgraph nginx["Nginx Reverse Proxy"]
                ssl["SSL/TLS Termination\n443 → 3200"]
            end

            subgraph app["Node.js Application"]
                express["Express.js\nREST API"]
                socketio["Socket.IO\nWebSocket Server"]
                pm2["PM2 Process Manager"]
            end

            subgraph monitoring["Monitoring Stack"]
                prometheus["Prometheus\n:9090"]
                grafana["Grafana\n:3000"]
            end
        end

        s3["S3 Bucket\nturing-robotics-datahub"]
    end

    quest -->|"WebSocket\nframes, telemetry"| dns
    tablet -->|"WebSocket\ncontrol, sessions"| dns
    dashboard -->|"REST + WebSocket"| dns

    dns --> ssl
    ssl --> express
    ssl --> socketio

    express --> prometheus
    socketio --> prometheus
    prometheus --> grafana

    express -->|"Upload sessions"| s3
    socketio -->|"Store recordings"| s3
```

---

## Data Flow

```mermaid
sequenceDiagram
    participant H as Quest Headset
    participant T as Tablet
    participant S as Server
    participant DB as S3 Storage

    T->>S: tablet-create-session
    S-->>T: session-created (sessionId)
    S-->>H: on-session-created

    T->>S: tablet-lock-device (headsetId)
    S-->>T: lock-success
    S-->>H: on-locked

    T->>S: tablet-start-recording
    S-->>H: start-recording
    H-->>S: headset-recording-state (started)

    loop Every Frame (30fps)
        H->>S: headset-frame (video data)
        H->>S: device-telemetry (battery, tracking)
        S-->>T: on-device-telemetry-updated
    end

    T->>S: tablet-stop-recording
    S-->>H: stop-recording
    H-->>S: headset-recording-state (stopped)

    H->>S: POST /upload-session
    S->>DB: Store video + NPZ
    S-->>H: upload-complete

    T->>S: tablet-end-session
    S-->>T: session-ended
```

---

## Network Architecture

```mermaid
flowchart LR
    subgraph external["External Network"]
        client["Clients\n(Headsets, Tablets)"]
    end

    subgraph dmz["DMZ Layer"]
        nginx["Nginx\n:80/:443"]
    end

    subgraph internal["Internal Network"]
        backend["Node.js Backend\n:3200"]
        prom["Prometheus\n:9090"]
        graf["Grafana\n:3000"]
    end

    subgraph storage["Cloud Storage"]
        s3["AWS S3"]
    end

    client -->|"HTTPS/WSS"| nginx
    nginx -->|"HTTP/WS"| backend
    nginx -->|"/grafana/"| graf
    backend -->|"/metrics"| prom
    prom -->|"data source"| graf
    backend -->|"S3 API"| s3
```

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js v20 LTS |
| Framework | Express.js + Socket.IO |
| Language | TypeScript |
| Process Manager | PM2 |
| Reverse Proxy | Nginx |
| Storage | AWS S3 |
| Monitoring | Prometheus + Grafana |
| Logging | Pino (JSON) |

---

## Features

- **Multi-device control** - Tablet locks and controls headsets exclusively
- **Real-time streaming** - 30fps video frames via WebSocket
- **Chunked uploads** - Files up to 20GB with resume support
- **Fleet monitoring** - Battery, storage, tracking status for all devices
- **Session management** - Create, start, pause, end recording sessions
- **Metrics** - 40+ Prometheus metrics for observability

---

## Quick Start

```bash
# Clone
git clone https://github.com/Turing-Robotics/capture-backend.git
cd capture-backend

# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your AWS keys and JWT secret

# Build
npm run build

# Run
npm start
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AWS_ACCESS_KEY_ID` | Yes | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | Yes | AWS secret key |
| `AWS_REGION` | Yes | AWS region (eu-west-1) |
| `S3_BUCKET_NAME` | Yes | S3 bucket name |
| `JWT_SECRET` | Yes | Secret for JWT tokens |
| `ADMIN_API_KEY` | Yes | API key for admin endpoints |
| `NODE_ENV` | No | production or development |
| `PORT` | No | Server port (default: 3200) |

Generate secure secrets:
```bash
# JWT Secret
openssl rand -base64 48

# Admin API Key
openssl rand -base64 32
```

---

## API Endpoints

### REST

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/test` | Health check |
| GET | `/metrics` | Prometheus metrics |
| POST | `/upload-session` | Upload video + data |
| POST | `/chunked-upload/start` | Start multipart upload |
| POST | `/chunked-upload/complete` | Complete upload |
| GET | `/api/devices` | List all devices |
| GET | `/api/fleet/summary` | Fleet statistics |
| GET | `/api/sessions` | List sessions |

### WebSocket Events

**From Headset:**
- `headset-identify` - Register device
- `headset-frame` - Video frame data
- `device-telemetry` - Device status

**From Tablet:**
- `tablet-lock-device` / `tablet-unlock-device`
- `tablet-start-recording` / `tablet-stop-recording`
- `tablet-create-session` / `tablet-end-session`

**Broadcasts:**
- `on-headsets-updated` - Device list changed
- `on-device-telemetry-updated` - New telemetry
- `on-session-created` / `on-session-ended`

See [docs/API.md](docs/API.md) for complete API documentation.

---

## Project Structure

```
capture-backend/
├── src/
│   ├── app.ts              # Main server (Express + Socket.IO)
│   ├── auth.ts             # JWT authentication
│   ├── metrics.ts          # Prometheus metrics
│   ├── rateLimiter.ts      # Rate limiting
│   ├── validation.ts       # Input validation (Zod)
│   ├── redis.ts            # Redis for scaling
│   ├── logger.ts           # Pino logging
│   ├── qa-metrics.ts       # QA metrics API
│   ├── s3-stats.ts         # S3 statistics API
│   └── multidevice_complete.ts  # Multi-device logic
├── grafana/
│   └── dashboards/         # Grafana dashboard JSON
├── nginx/
│   └── nginx.conf.template # Nginx config template
├── scripts/
│   ├── parse_npz.py        # NPZ parsing utility
│   └── generate-nginx-config.sh
├── docs/
│   ├── API.md              # API documentation
│   ├── SETUP.md            # Setup guide
│   └── SCHEMA.md           # Data schemas
├── package.json
├── tsconfig.json
└── .env.example
```

---

## Production Deployment

### Server Requirements

- Ubuntu 22.04+ LTS
- Node.js v20 LTS
- 2GB RAM minimum
- PM2 process manager

### Deploy Steps

```bash
# 1. Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Install PM2
sudo npm install -g pm2

# 3. Clone and setup
git clone https://github.com/Turing-Robotics/capture-backend.git
cd capture-backend
npm install
npm run build

# 4. Configure environment
cp .env.example .env
nano .env

# 5. Start with PM2
pm2 start app.js --name capture-backend
pm2 save
pm2 startup
```

### Nginx Setup

```bash
# Install nginx
sudo apt install nginx

# Copy config
sudo cp nginx/nginx.conf.template /etc/nginx/sites-available/default
# Edit with your domain

# Get SSL certificate
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com

# Reload
sudo nginx -t && sudo systemctl reload nginx
```

See [docs/SETUP.md](docs/SETUP.md) for detailed deployment instructions.

---

## Monitoring

### Grafana Dashboards

Three pre-built dashboards in `grafana/dashboards/`:

1. **System Overview** - Device connections, session activity, system health
2. **S3 Analytics** - Storage usage, upload stats, cost tracking
3. **QA Monitoring** - Capture quality metrics, validation results

### Prometheus Metrics

Server exposes metrics at `/metrics`:

```
turing_connected_devices_total
turing_recording_devices_total
turing_sessions_active_total
turing_uploads_in_progress
turing_http_request_duration_seconds
```

---

## S3 Data Structure

```
s3://turing-robotics-datahub/
├── sessions/
│   ├── 20260206_143052/
│   │   ├── recording.mp4       # H.264 video
│   │   └── session_data.npz    # NumPy tracking data
│   └── 20260206_151230/
│       ├── recording.mp4
│       └── session_data.npz
└── client_output/
    └── processed_files.zip
```

---

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run in development
npm run dev

# Run tests
npm test
```

---

## Documentation

- [Setup Guide](docs/SETUP.md) - Installation and deployment
- [API Reference](docs/API.md) - Endpoints and events
- [Data Schemas](docs/SCHEMA.md) - Data structures

---

## License

Proprietary - Turing Robotics

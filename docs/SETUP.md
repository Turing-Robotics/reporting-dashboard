# Quest VR Backend Server - Setup and Deployment Guide

This guide covers everything needed to set up, configure, and deploy the Quest VR Backend Server.

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Local Development Setup](#local-development-setup)
4. [Environment Configuration](#environment-configuration)
5. [Building the TypeScript Code](#building-the-typescript-code)
6. [Running Locally](#running-locally)
7. [Production Deployment on AWS EC2](#production-deployment-on-aws-ec2)
8. [Nginx Configuration](#nginx-configuration)
9. [SSL Certificate Setup with Certbot](#ssl-certificate-setup-with-certbot)
10. [PM2 Process Management](#pm2-process-management)
11. [Monitoring Setup](#monitoring-setup)
12. [Troubleshooting](#troubleshooting)

---

## Overview

The Quest VR Backend Server is a real-time data capture and fleet management system for Quest VR headsets.

**Tech Stack:**
- Runtime: Node.js v20 LTS
- Framework: Express.js + Socket.IO
- Language: TypeScript (compiled to JavaScript)
- Process Manager: PM2
- Reverse Proxy: Nginx with SSL
- Storage: AWS S3
- Monitoring: Prometheus + Grafana
- Logging: Pino (structured JSON logging)

**Key Features:**
- Multi-device tablet control with exclusive device locking
- Real-time frame streaming (30fps optimized)
- Chunked file uploads (up to 20GB)
- JWT authentication for all connections
- Rate limiting and input validation
- Prometheus metrics endpoint at `/metrics`
- Fleet dashboard telemetry

---

## Prerequisites

### 1. Node.js v20 LTS

**macOS (Homebrew):**
```bash
brew install node@20
```

**Ubuntu/Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Verify installation:**
```bash
node --version   # Should show v20.x.x
npm --version    # Should show 10.x.x or higher
```

### 2. PM2 (Process Manager)

Install PM2 globally:
```bash
npm install -g pm2
```

Verify:
```bash
pm2 --version
```

### 3. AWS CLI

**macOS:**
```bash
brew install awscli
```

**Ubuntu:**
```bash
sudo apt-get install awscli
```

**Configure AWS credentials:**
```bash
aws configure
```

Enter your:
- AWS Access Key ID
- AWS Secret Access Key
- Default region (e.g., `eu-west-1`)
- Default output format (`json`)

### 4. TypeScript (Development Only)

TypeScript is installed as a dev dependency, but you can install it globally:
```bash
npm install -g typescript
```

---

## Local Development Setup

### 1. Clone and Install Dependencies

```bash
# Navigate to the backend directory
cd /path/to/quest_backend

# Install all dependencies
npm install
```

### 2. Create Environment File

Copy the example below and save as `.env` in the `quest_backend` directory:

```bash
# Required: AWS Configuration
AWS_ACCESS_KEY_ID=your_aws_access_key_id
AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key
AWS_REGION=eu-west-1
S3_BUCKET_NAME=your-s3-bucket-name

# Required: Security
JWT_SECRET=your_64_character_random_secret_here
ADMIN_API_KEY=your_admin_api_key_here

# Environment
NODE_ENV=development

# Optional: Logging
LOG_LEVEL=info

# Optional: CORS (comma-separated origins)
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001
```

### 3. Generate Secure Secrets

Generate a secure JWT secret:
```bash
openssl rand -base64 48
```

Generate an admin API key:
```bash
openssl rand -base64 32
```

---

## Environment Configuration

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `AWS_ACCESS_KEY_ID` | AWS IAM access key | `AKIAIOSFODNN7EXAMPLE` |
| `AWS_SECRET_ACCESS_KEY` | AWS IAM secret key | `wJalrXUtnFEMI/K7MDENG...` |
| `AWS_REGION` | AWS region for S3 | `eu-west-1` |
| `S3_BUCKET_NAME` | S3 bucket for uploads | `my-vr-data-bucket` |
| `JWT_SECRET` | Secret for JWT tokens (min 32 chars) | `openssl rand -base64 48` |
| `ADMIN_API_KEY` | API key for admin endpoints | `openssl rand -base64 32` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `LOG_LEVEL` | Logging verbosity | `info` |
| `ALLOWED_ORIGINS` | CORS allowed origins | `http://localhost:3000,http://localhost:3001` |

### Production Environment

For production, always set:
```bash
NODE_ENV=production
```

This enables:
- Strict CORS origin checking
- Production-optimized logging (JSON format, no colors)
- WebSocket compression

---

## Building the TypeScript Code

### Build Command

Compile TypeScript to JavaScript:
```bash
npm run build
```

This runs `tsc` and generates `.js` files in the same directory as the `.ts` files.

### Build Output

After building, you will have:
```
quest_backend/
  app.ts          # Source
  app.js          # Compiled output (run this)
  auth.ts
  auth.js
  logger.ts
  logger.js
  metrics.ts
  metrics.js
  rateLimiter.ts
  rateLimiter.js
  validation.ts
  validation.js
  ...
```

### TypeScript Configuration

The `tsconfig.json` is configured with:
- Target: ES2016
- Module: CommonJS
- Strict mode enabled
- ES module interop enabled

---

## Running Locally

### Development Mode

Build and run in one command:
```bash
npm run dev
```

This executes `tsc && node app.js`.

### Production Mode (Local Test)

```bash
# Build first
npm run build

# Run the server
npm start
```

### Verify Server is Running

The server listens on port 3200 by default.

**Test the health endpoint:**
```bash
curl http://localhost:3200/test
```

**Expected response:**
```json
{
  "ok": true,
  "message": "Turing Backend v2.2 - Secure Multi-Device Support",
  "time": "2026-02-06T12:00:00.000Z"
}
```

**Test the metrics endpoint:**
```bash
curl http://localhost:3200/metrics
```

---

## Production Deployment on AWS EC2

### 1. Launch EC2 Instance

**Recommended specs:**
- Instance type: `t3.medium` (2 vCPU, 4GB RAM) minimum
- AMI: Ubuntu 22.04 LTS
- Storage: 30GB gp3 SSD
- Security group: Allow ports 22 (SSH), 80 (HTTP), 443 (HTTPS)

### 2. Connect to Instance

```bash
ssh -i your-key.pem ubuntu@your-ec2-public-ip
```

### 3. Install System Dependencies

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install build tools (for native modules)
sudo apt-get install -y build-essential

# Install PM2
sudo npm install -g pm2

# Install Nginx
sudo apt-get install -y nginx

# Install Certbot for SSL
sudo apt-get install -y certbot python3-certbot-nginx
```

### 4. Create Application Directory

```bash
sudo mkdir -p /opt/quest-backend
sudo chown $USER:$USER /opt/quest-backend
```

### 5. Deploy Application Code

**Option A: Git Clone**
```bash
cd /opt/quest-backend
git clone your-repo-url .
npm install --production
npm run build
```

**Option B: Direct Upload (rsync)**
```bash
# From your local machine
rsync -avz --exclude='node_modules' \
  ./quest_backend/ \
  ubuntu@your-server:/opt/quest-backend/

# On the server
cd /opt/quest-backend
npm install --production
npm run build
```

### 6. Create Production Environment File

```bash
sudo nano /opt/quest-backend/.env
```

Add your production configuration:
```bash
NODE_ENV=production
AWS_ACCESS_KEY_ID=your_production_key
AWS_SECRET_ACCESS_KEY=your_production_secret
AWS_REGION=eu-west-1
S3_BUCKET_NAME=your-production-bucket
JWT_SECRET=your_production_jwt_secret
ADMIN_API_KEY=your_production_admin_key
LOG_LEVEL=info
ALLOWED_ORIGINS=https://yourdomain.com,https://dashboard.yourdomain.com
```

Secure the file:
```bash
chmod 600 /opt/quest-backend/.env
```

---

## Nginx Configuration

### 1. Create Nginx Site Configuration

```bash
sudo nano /etc/nginx/sites-available/quest-backend
```

Add the following configuration:

```nginx
# Rate limiting zone
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;

upstream quest_backend {
    server 127.0.0.1:3200;
    keepalive 64;
}

server {
    listen 80;
    server_name yourdomain.com;

    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    # SSL configuration (Certbot will add this)
    # ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # SSL security settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Logging
    access_log /var/log/nginx/quest-backend-access.log;
    error_log /var/log/nginx/quest-backend-error.log;

    # Max upload size (20GB for chunked uploads)
    client_max_body_size 20G;

    # Timeouts for large uploads
    proxy_connect_timeout 300;
    proxy_send_timeout 300;
    proxy_read_timeout 300;
    send_timeout 300;

    # REST API endpoints
    location / {
        limit_req zone=api_limit burst=20 nodelay;

        proxy_pass http://quest_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket endpoint (Socket.IO)
    location /socket.io/ {
        proxy_pass http://quest_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket timeouts
        proxy_connect_timeout 7d;
        proxy_send_timeout 7d;
        proxy_read_timeout 7d;
    }

    # Metrics endpoint (restrict to internal network or monitoring IPs)
    location /metrics {
        # Allow Prometheus server IP
        # allow 10.0.0.0/8;
        # deny all;

        proxy_pass http://quest_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Health check endpoint
    location /health {
        proxy_pass http://quest_backend;
        proxy_http_version 1.1;
    }
}
```

### 2. Enable the Site

```bash
# Create symlink
sudo ln -s /etc/nginx/sites-available/quest-backend /etc/nginx/sites-enabled/

# Remove default site
sudo rm /etc/nginx/sites-enabled/default

# Test configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

---

## SSL Certificate Setup with Certbot

### 1. Obtain SSL Certificate

```bash
sudo certbot --nginx -d yourdomain.com
```

Follow the prompts:
- Enter your email address
- Agree to terms of service
- Choose whether to redirect HTTP to HTTPS (recommended)

### 2. Verify Auto-Renewal

Certbot sets up automatic renewal. Test it:
```bash
sudo certbot renew --dry-run
```

### 3. Certificate Renewal Cron Job

Certbot adds this automatically, but verify:
```bash
sudo systemctl status certbot.timer
```

---

## PM2 Process Management

### 1. Create PM2 Ecosystem File

```bash
nano /opt/quest-backend/ecosystem.config.js
```

Add the following:

```javascript
module.exports = {
  apps: [{
    name: 'quest-backend',
    script: 'app.js',
    cwd: '/opt/quest-backend',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    env_file: '/opt/quest-backend/.env',
    error_file: '/var/log/quest-backend/error.log',
    out_file: '/var/log/quest-backend/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true
  }]
};
```

### 2. Create Log Directory

```bash
sudo mkdir -p /var/log/quest-backend
sudo chown $USER:$USER /var/log/quest-backend
```

### 3. Start the Application

```bash
cd /opt/quest-backend
pm2 start ecosystem.config.js
```

### 4. Save PM2 Process List

```bash
pm2 save
```

### 5. Setup PM2 Startup Script

```bash
pm2 startup systemd
```

Follow the command output to execute the generated command.

### 6. Common PM2 Commands

```bash
# View running processes
pm2 list

# View logs
pm2 logs quest-backend

# Monitor resources
pm2 monit

# Restart application
pm2 restart quest-backend

# Stop application
pm2 stop quest-backend

# Reload with zero downtime
pm2 reload quest-backend

# View detailed process info
pm2 show quest-backend
```

---

## Monitoring Setup

### Prometheus Configuration

The server exposes Prometheus metrics at `/metrics`.

#### 1. Install Prometheus

```bash
# Download Prometheus
wget https://github.com/prometheus/prometheus/releases/download/v2.48.0/prometheus-2.48.0.linux-amd64.tar.gz
tar xvfz prometheus-2.48.0.linux-amd64.tar.gz
sudo mv prometheus-2.48.0.linux-amd64 /opt/prometheus
```

#### 2. Configure Prometheus

Create `/opt/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'quest-backend'
    static_configs:
      - targets: ['localhost:3200']
    metrics_path: '/metrics'
    scheme: 'http'

  - job_name: 'node-exporter'
    static_configs:
      - targets: ['localhost:9100']
```

#### 3. Create Prometheus Service

```bash
sudo nano /etc/systemd/system/prometheus.service
```

```ini
[Unit]
Description=Prometheus
Wants=network-online.target
After=network-online.target

[Service]
User=prometheus
Group=prometheus
Type=simple
ExecStart=/opt/prometheus/prometheus \
  --config.file=/opt/prometheus/prometheus.yml \
  --storage.tsdb.path=/opt/prometheus/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --no-create-home --shell /bin/false prometheus
sudo chown -R prometheus:prometheus /opt/prometheus
sudo systemctl daemon-reload
sudo systemctl enable prometheus
sudo systemctl start prometheus
```

### Grafana Setup

#### 1. Install Grafana

```bash
sudo apt-get install -y software-properties-common
sudo wget -q -O - https://packages.grafana.com/gpg.key | sudo apt-key add -
echo "deb https://packages.grafana.com/oss/deb stable main" | sudo tee /etc/apt/sources.list.d/grafana.list
sudo apt-get update
sudo apt-get install grafana
sudo systemctl enable grafana-server
sudo systemctl start grafana-server
```

#### 2. Access Grafana

- URL: `http://your-server:3000`
- Default credentials: `admin` / `admin`

#### 3. Add Prometheus Data Source

1. Go to Configuration > Data Sources
2. Click "Add data source"
3. Select "Prometheus"
4. URL: `http://localhost:9090`
5. Click "Save & Test"

#### 4. Import Dashboard

Create a dashboard with these key metrics:

| Metric | Description |
|--------|-------------|
| `turing_connected_devices_total` | Connected devices by type |
| `turing_recording_devices_total` | Devices currently recording |
| `turing_upload_bytes_total` | Total uploaded data |
| `turing_socket_events_total` | Socket.IO event counts |
| `turing_http_requests_total` | HTTP request counts |
| `turing_fleet_battery_level` | Device battery levels |

### Available Metrics

The server exposes these Prometheus metrics:

**Device Metrics:**
- `turing_connected_devices_total{type}` - Connected device count
- `turing_locked_devices_total` - Locked device count
- `turing_recording_devices_total` - Recording device count
- `turing_device_connections_total{type,event}` - Connection events

**Session Metrics:**
- `turing_sessions_active_total` - Active sessions
- `turing_sessions_created_total` - Total sessions created
- `turing_session_duration_seconds` - Session durations

**Upload Metrics:**
- `turing_uploads_in_progress` - Current uploads
- `turing_upload_bytes_total{file_type}` - Total bytes uploaded
- `turing_upload_errors_total{error_type}` - Upload errors

**HTTP Metrics:**
- `turing_http_requests_total{method,route,status_code}` - Request counts
- `turing_http_request_duration_seconds` - Request latency

**System Metrics (Node.js defaults):**
- `turing_nodejs_eventloop_lag_seconds` - Event loop lag
- `turing_nodejs_heap_size_used_bytes` - Memory usage
- `turing_process_cpu_seconds_total` - CPU usage

---

## Troubleshooting

### Server Won't Start

**Error: `JWT_SECRET environment variable must be set`**

The server requires a JWT secret. Add it to your `.env` file:
```bash
JWT_SECRET=$(openssl rand -base64 48)
```

**Error: `Cannot find module './auth'`**

Build the TypeScript first:
```bash
npm run build
```

### Socket.IO Connection Issues

**Symptoms:** Clients connect but immediately disconnect.

**Check:**
1. Nginx WebSocket configuration is correct
2. Firewall allows WebSocket upgrades
3. Client is providing valid JWT token

**Debug:**
```bash
# Check server logs
pm2 logs quest-backend --lines 100

# Test WebSocket connectivity
wscat -c wss://yourdomain.com/socket.io/?EIO=4&transport=websocket
```

### Upload Failures

**Error: `File too large`**

Check Nginx `client_max_body_size` setting:
```nginx
client_max_body_size 20G;
```

**Error: `S3 access denied`**

Verify AWS credentials:
```bash
aws s3 ls s3://your-bucket-name
```

Check IAM permissions for the bucket.

### High Memory Usage

**Symptoms:** Server memory grows over time.

**Check PM2 memory:**
```bash
pm2 monit
```

**Solution:** The server has memory cleanup tasks, but you can restart:
```bash
pm2 restart quest-backend
```

The `max_memory_restart: '1G'` in ecosystem.config.js auto-restarts if memory exceeds 1GB.

### SSL Certificate Issues

**Error: `SSL certificate expired`**

Force renewal:
```bash
sudo certbot renew --force-renewal
sudo systemctl reload nginx
```

**Error: `Certificate not trusted`**

Ensure you're using the fullchain certificate:
```nginx
ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
```

### Database/State Issues

The server uses in-memory state. On restart, all sessions and device states are lost. This is by design for simplicity.

For persistent state, consider adding:
- Redis for session storage
- PostgreSQL for device registry

### Checking Server Health

```bash
# Health endpoint
curl https://yourdomain.com/health

# Test endpoint
curl https://yourdomain.com/test

# Metrics endpoint
curl https://yourdomain.com/metrics

# PM2 status
pm2 list
pm2 show quest-backend
```

### Log Analysis

**View recent logs:**
```bash
pm2 logs quest-backend --lines 200
```

**Search for errors:**
```bash
grep -i error /var/log/quest-backend/error.log | tail -50
```

**Real-time log monitoring:**
```bash
pm2 logs quest-backend --follow
```

---

## Quick Reference

### Start/Stop Commands

```bash
# Start server
pm2 start ecosystem.config.js

# Stop server
pm2 stop quest-backend

# Restart server
pm2 restart quest-backend

# Zero-downtime reload
pm2 reload quest-backend
```

### Deployment Checklist

- [ ] Node.js v20 installed
- [ ] Dependencies installed (`npm install`)
- [ ] TypeScript compiled (`npm run build`)
- [ ] `.env` file created with all required variables
- [ ] PM2 ecosystem file created
- [ ] Nginx configured with WebSocket support
- [ ] SSL certificate obtained
- [ ] Firewall ports 80, 443 open
- [ ] PM2 startup configured
- [ ] Prometheus/Grafana configured (optional)

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/test` | GET | Health check |
| `/health` | GET | Detailed health info |
| `/metrics` | GET | Prometheus metrics |
| `/auth/device-token` | POST | Get JWT token |
| `/api/devices` | GET | List all devices |
| `/api/fleet/summary` | GET | Fleet statistics |
| `/upload-session` | POST | Upload session files |
| `/chunked-upload/start` | POST | Start chunked upload |

### Socket.IO Events

**Client to Server:**
- `headset-identify` - Register headset
- `device-telemetry` - Send telemetry
- `tablet-lock-device` - Lock a device
- `tablet-start-recording` - Start recording

**Server to Client:**
- `on-headsets-updated` - Headset list changed
- `on-device-locked` - Device locked
- `on-device-telemetry-updated` - Telemetry update

---

## Support

For issues specific to this server:
1. Check the troubleshooting section above
2. Review PM2 logs: `pm2 logs quest-backend`
3. Check Nginx error logs: `/var/log/nginx/quest-backend-error.log`

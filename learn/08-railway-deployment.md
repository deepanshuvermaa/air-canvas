# Railway Deployment

## What Is Railway?

Railway is a Platform-as-a-Service (PaaS) for deploying applications. Think of it as a modern Heroku: you push code, Railway builds it, runs it, and manages the infrastructure. You do not provision servers, configure load balancers, or manage SSL certificates.

For AirDraw, Railway is relevant in two scenarios:

1. **Landing page / marketing site:** A Next.js or static site explaining what AirDraw does, with a link to the Chrome Web Store listing.
2. **Backend API (if needed):** A Node.js server for analytics, user accounts, or a WebSocket relay for collaborative drawing sessions.

The Chrome extension itself does not run on Railway — it runs entirely in the user's browser. But supporting infrastructure (websites, APIs) deploys well on Railway.

---

## How Railway Detects and Builds Projects (Nixpacks)

Railway uses **Nixpacks** as its default build system. Nixpacks automatically detects your project type and generates a build plan. No Dockerfile required.

### Detection Examples

| Project Type | Detected By | Build Command | Start Command |
|---|---|---|---|
| Node.js | `package.json` | `npm install && npm run build` | `npm start` |
| Next.js | `next.config.js` or `next.config.ts` | `npm install && npm run build` | `npm start` |
| Python | `requirements.txt` or `pyproject.toml` | `pip install -r requirements.txt` | Detected from Procfile or main.py |
| Go | `go.mod` | `go build` | Runs the binary |
| Rust | `Cargo.toml` | `cargo build --release` | Runs the binary |
| Static HTML | `index.html` | None | Served via Caddy |

### How It Works Under the Hood

1. You push code to a GitHub repository (or use `railway up` from the CLI)
2. Railway detects the project type via Nixpacks
3. Nixpacks generates a Nix environment with the right language runtime, package manager, and system dependencies
4. The project is built inside a container
5. The container is deployed to Railway's infrastructure
6. Railway assigns a URL (e.g., `your-app.up.railway.app`)

You can override any step by providing a `nixpacks.toml`, a `Dockerfile`, or Railway-specific configuration.

---

## Deploying a Static Site

### Plain HTML/CSS/JS

If your landing page is plain HTML:

```
landing-page/
  index.html
  style.css
  script.js
  images/
    hero.png
```

Push this to a GitHub repo, connect it to Railway, and Railway serves it automatically via a built-in static file server (Caddy).

### Next.js App

For a Next.js landing page:

```bash
npx create-next-app@latest airdraw-landing
cd airdraw-landing
```

Railway detects Next.js and handles everything:

```jsonc
// package.json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  }
}
```

Push to GitHub, connect the repo to Railway, and it deploys. Railway runs `npm install`, then `npm run build`, then `npm start`.

### Configuring the Build

If Railway's auto-detection does not work (rare), configure it in the Railway dashboard or via `railway.json`:

```jsonc
// railway.json (optional — place in repo root)
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "npm install && npm run build"
  },
  "deploy": {
    "startCommand": "npm start",
    "healthcheckPath": "/",
    "restartPolicyType": "ON_FAILURE"
  }
}
```

---

## Deploying a Node.js Backend

If AirDraw needs a backend (e.g., for storing shared drawings or user settings), here is how to deploy a simple Express server:

```typescript
// server.ts
import express from "express";
import cors from "cors";

const app = express();
const PORT = parseInt(process.env.PORT || "3000");

app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/api/drawings", (req, res) => {
  // Save drawing data
  const { userId, strokes } = req.body;
  // ... save to database
  res.json({ success: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
```

### Critical: Use process.env.PORT

Railway dynamically assigns a port. Your app **must** listen on `process.env.PORT`, not a hardcoded port:

```typescript
// WRONG
app.listen(3000);

// RIGHT
app.listen(parseInt(process.env.PORT || "3000"), "0.0.0.0");
```

Also bind to `0.0.0.0`, not `localhost` or `127.0.0.1`. Railway's networking requires binding to all interfaces.

### package.json for the Backend

```jsonc
{
  "name": "airdraw-api",
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "dev": "tsx watch server.ts"
  },
  "dependencies": {
    "express": "^4.18.0",
    "cors": "^2.8.5"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/express": "^4.17.0",
    "@types/cors": "^2.8.0",
    "tsx": "^4.0.0"
  }
}
```

---

## Environment Variables and Secrets

### Setting Variables in Railway

In the Railway dashboard:
1. Select your service
2. Go to the "Variables" tab
3. Add key-value pairs

Or use the CLI:

```bash
railway variables set DATABASE_URL="postgresql://user:pass@host/db"
railway variables set JWT_SECRET="your-secret-here"
railway variables set NODE_ENV="production"
```

### Accessing Variables in Code

Railway injects environment variables into your process automatically:

```typescript
const dbUrl = process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET;

if (!dbUrl || !jwtSecret) {
  throw new Error("Missing required environment variables");
}
```

### Shared Variables

If you have multiple services (frontend + backend) that need the same variable:

1. Create a **Shared Variable** in the Railway project settings
2. Reference it in each service with `${{shared.VARIABLE_NAME}}`

### Variable References

Railway supports referencing other variables and service metadata:

```
# Reference another service's URL
API_URL=${{backend.RAILWAY_PUBLIC_DOMAIN}}

# Reference a database plugin's URL
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

---

## Custom Domains

### Default Domain

Every Railway service gets a default domain: `your-app-production-xxxx.up.railway.app`

### Custom Domain Setup

1. In the Railway dashboard, go to your service's "Settings" → "Networking"
2. Click "Generate Domain" for a Railway subdomain, or "Custom Domain"
3. For a custom domain (e.g., `airdraw.app`):
   - Add the domain in Railway
   - Railway gives you a CNAME record to add to your DNS provider
   - Add the CNAME record (e.g., `airdraw.app CNAME xxxx.railway.app`)
   - Railway automatically provisions an SSL certificate via Let's Encrypt

```
DNS Configuration:
Type:  CNAME
Name:  @  (or your subdomain, e.g., "api")
Value: xxxx.railway.app  (provided by Railway)
```

For apex domains (no subdomain), some DNS providers require an ALIAS or ANAME record instead of CNAME. Cloudflare supports "CNAME flattening" which makes this work.

---

## Railway CLI

### Installation

```bash
# macOS/Linux
brew install railway

# Windows (via npm)
npm install -g @railway/cli

# Or via the install script
curl -fsSL https://railway.app/install.sh | sh
```

### Authentication

```bash
railway login
# Opens a browser for OAuth login
```

### Common Commands

```bash
# Link your local project to a Railway project
railway link

# Deploy the current directory
railway up

# View logs
railway logs

# Open the Railway dashboard for this project
railway open

# Run a command with Railway environment variables injected
railway run node scripts/seed.js

# Set environment variables
railway variables set KEY=value

# View current environment variables
railway variables

# Check deployment status
railway status
```

### Local Development with Railway Variables

Use `railway run` to inject production environment variables into your local development server:

```bash
# Run your dev server with production DATABASE_URL, etc.
railway run npm run dev
```

This is useful for testing against a Railway-hosted database without copying credentials into a `.env` file.

---

## Dockerfile vs Nixpacks

### When Nixpacks Is Sufficient (Most Cases)

Nixpacks works well for standard projects:
- Node.js with npm/yarn/pnpm
- Python with pip/poetry
- Go, Rust, Java, etc.
- Next.js, Remix, SvelteKit

You do not need a Dockerfile for AirDraw's landing page or API server.

### When You Need a Dockerfile

- **Custom system dependencies:** Your app needs a specific version of ffmpeg, imagemagick, or other system libraries that Nixpacks does not include
- **Multi-stage builds:** You want to optimize the final image size
- **Exact reproduction:** You need the build to be identical across environments
- **Non-standard build process:** Your build steps do not follow the conventional pattern

### Example Dockerfile for AirDraw's API

```dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

EXPOSE $PORT
CMD ["node", "dist/server.js"]
```

### Overriding Nixpacks with nixpacks.toml

If you want to stick with Nixpacks but customize the build:

```toml
# nixpacks.toml
[phases.setup]
nixPkgs = ["nodejs_20", "npm"]

[phases.install]
cmds = ["npm ci"]

[phases.build]
cmds = ["npm run build"]

[start]
cmd = "npm start"
```

---

## Deploying AirDraw's Supporting Infrastructure

### Project Structure on Railway

```
Railway Project: "airdraw"
  │
  ├── Service: "landing" (Next.js)
  │   ├── Source: github.com/you/airdraw-landing
  │   ├── Domain: airdraw.app
  │   └── Variables: NEXT_PUBLIC_EXTENSION_URL=...
  │
  ├── Service: "api" (Node.js/Express)
  │   ├── Source: github.com/you/airdraw-api
  │   ├── Domain: api.airdraw.app
  │   └── Variables: DATABASE_URL, JWT_SECRET
  │
  └── Plugin: "postgres" (Railway-managed)
      └── Provides: DATABASE_URL to "api" service
```

### Deployment Workflow

```bash
# Initial setup
cd airdraw-landing
railway login
railway init        # Creates a new Railway project
railway up          # Deploys

# Subsequent deploys (if connected to GitHub)
git push origin main   # Railway auto-deploys on push

# Or manual deploys
railway up
```

### GitHub Integration

The recommended workflow:

1. Connect your GitHub repo to Railway
2. Enable auto-deploy on push to `main`
3. Railway builds and deploys automatically on every push
4. Preview deployments are created for pull requests

```
Push to main → Railway detects → Nixpacks builds → Deploy → Live
```

### Monitoring

Railway provides:
- **Logs:** Real-time log streaming in the dashboard or via `railway logs`
- **Metrics:** CPU, memory, and network usage graphs
- **Alerts:** Configure notifications for deploy failures or high resource usage
- **Restart policies:** Auto-restart on crash

```bash
# View live logs
railway logs --follow

# View deployment history
railway deployments
```

---

## Cost Considerations

Railway's pricing (as of the time of writing):

- **Trial plan:** $5 of free usage (one-time, no credit card required)
- **Hobby plan:** $5/month subscription + usage-based pricing
- **Pro plan:** $20/month per team member + usage-based pricing

Usage-based pricing covers:
- **Compute:** ~$0.000463/min for 1 vCPU, 512 MB RAM
- **Network egress:** $0.10/GB after 100 GB free
- **Storage:** $0.25/GB/month

For AirDraw's landing page (low traffic), expect to spend $5-10/month. For an API server with moderate traffic, $10-30/month. Railway is not the cheapest option for high-traffic apps, but it is hard to beat for development speed and simplicity.

### Comparison with Alternatives

| Platform | Strengths | Weaknesses |
|---|---|---|
| **Railway** | Fast deploys, great DX, easy DB plugins | Higher cost at scale |
| **Vercel** | Best for Next.js, generous free tier | Only frontend/serverless |
| **Fly.io** | Global edge deployment, Docker-native | More complex setup |
| **Render** | Similar to Railway, free tier | Slower builds |
| **Cloudflare Pages** | Free static hosting, edge network | Limited server-side |

For AirDraw, the recommendation is:
- **Landing page:** Vercel (free for Next.js) or Railway
- **API server:** Railway (easy DB integration) or Fly.io (if you need global latency)
- **The extension itself:** Distributed via Chrome Web Store, not deployed on any server

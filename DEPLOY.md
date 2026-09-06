# Deploying Turret Trouble to Azure

A step-by-step manual. Follow it top to bottom once; after that, every push to
`main` deploys itself.

There is **no build step and no npm dependencies**. Any method that copies the
files and runs `npm start` works. That makes this simpler than most Node
deployments — most of the steps below are Azure paperwork, not packaging.

---

## 0. What you need before you start

- An Azure subscription (Free F1 is enough to see it running; B1 if you want it
  to stay warm).
- This repo pushed to GitHub — `https://github.com/Pakspul/turret-trouble`.
- Optional: the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
  if you prefer the terminal over the portal. Both paths are given below.

Check it runs locally first, so a failure later is definitely Azure's fault:

```bash
npm run check   # syntax-checks every module
npm test        # boots the server, hits /healthz and /
npm start       # then open http://localhost:8080
```

---

## 1. Create the Web App

The app name becomes `https://<name>.azurewebsites.net`, so it must be
**globally unique**. If `turret-trouble` is taken, pick something else and
remember it — step 3 depends on it.

### Portal

1. **Create a resource → Web App**.
2. Fill in:
   - **Resource Group**: `turret-trouble-rg` (create new)
   - **Name**: `turret-trouble`
   - **Publish**: `Code`
   - **Runtime stack**: `Node 20 LTS`
   - **Operating System**: `Linux`
   - **Region**: whatever is nearest, e.g. `West Europe`
   - **Pricing plan**: `Free F1` or `Basic B1`
3. **Review + create → Create**, then wait for "Your deployment is complete".

### Or the CLI

```bash
RG=turret-trouble-rg
APP=turret-trouble          # must be globally unique
LOC=westeurope

az group create -n $RG -l $LOC
az appservice plan create -g $RG -n turret-plan --is-linux --sku B1
az webapp create -g $RG -p turret-plan -n $APP --runtime "NODE:20-lts"
```

---

## 2. Configure the Web App

Three settings. None are strictly required to boot, but each prevents a
specific annoyance.

### Portal

- **Configuration → General settings**
  - **Startup Command**: leave blank — App Service sees `package.json` and runs
    `npm start`. Set it to `node server.js` if you prefer it explicit.
  - **HTTPS Only**: `On`.
- **Configuration → Application settings → New application setting**
  - `SCM_DO_BUILD_DURING_DEPLOYMENT` = `false` — there is nothing to build, and
    letting Oryx try only slows the deploy down. (`.deployment` in the repo says
    the same thing; setting it here covers deploy methods that ignore that file.)
- **Monitoring → Health check**
  - Enable it, path `/healthz`.

### Or the CLI

```bash
az webapp config set -g $RG -n $APP --startup-file "node server.js"
az webapp config set -g $RG -n $APP --health-check-path "/healthz"
az webapp update  -g $RG -n $APP --https-only true
az webapp config appsettings set -g $RG -n $APP --settings \
  SCM_DO_BUILD_DURING_DEPLOYMENT=false WEBSITE_NODE_DEFAULT_VERSION=~20
```

---

## 3. Point the workflow at your app

Open [.github/workflows/azure-webapp.yml](.github/workflows/azure-webapp.yml)
and set `AZURE_WEBAPP_NAME` to the name you chose in step 1:

```yaml
env:
  AZURE_WEBAPP_NAME: turret-trouble    # <- your app name here
  NODE_VERSION: '20.x'
```

If they do not match, the deploy fails with a "resource not found"-style error.

---

## 4. Enable basic auth publishing (the step everyone misses)

The workflow authenticates with a **publish profile**, and new Azure Web Apps
now ship with SCM basic authentication **disabled**. Leave it off and the
publish profile you download in step 5 arrives without usable credentials, and
the GitHub job fails with something like *"Basic authentication is disabled"* or
*"Failed to fetch Kudu App Settings"*.

**Portal**: your Web App → **Settings → Configuration → General settings →
SCM Basic Auth Publishing Credentials → On** → **Save**.

**CLI**:

```bash
az resource update -g $RG --namespace Microsoft.Web \
  --resource-type basicPublishingCredentialsPolicies \
  --name scm --parent sites/$APP --set properties.allow=true
```

> Prefer not to enable basic auth at all? See
> [Alternative: deploy without a publish profile](#alternative-deploy-without-a-publish-profile).

---

## 5. Get the publish profile into GitHub

1. **Azure portal** → your Web App → **Overview → Download publish profile**
   (or **Deployment Center → Manage publish profile**). You get a small
   `.PublishSettings` XML file.

   From the CLI instead:

   ```bash
   az webapp deployment list-publishing-profiles -g $RG -n $APP --xml
   ```

2. **GitHub** → the repo → **Settings → Secrets and variables → Actions →
   New repository secret**.
   - **Name**: `AZURE_WEBAPP_PUBLISH_PROFILE` — exactly this, the workflow reads
     it by name.
   - **Secret**: the **entire** contents of the file, XML declaration and all.
3. **Add secret**.

Treat that file like a password: it grants deploy rights to the app. Delete your
local copy afterwards. If it ever leaks, hit **Reset publish profile
credentials** in the portal and repeat this step.

---

## 6. Create the `production` environment (optional, 30 seconds)

The workflow declares `environment: production`, which GitHub creates
implicitly. Creating it yourself under **Settings → Environments → New
environment → `production`** lets you add a required-reviewer gate, so deploys
wait for a click instead of going out on every push.

---

## 7. Deploy

Push to `main`:

```bash
git add -A
git commit -m "Configure Azure deployment"
git push origin main
```

Then watch **GitHub → Actions → Deploy to Azure Web App**. The job:

1. checks out the repo,
2. runs `npm run check` — syntax-checks every module,
3. runs `npm test` — boots the server and hits `/healthz`,
4. zips the repo minus `.git`, `archive/`, `test/`, `node_modules/`,
5. pushes the zip to App Service.

A broken commit fails at step 2 or 3 and never reaches Azure.

You can also trigger it by hand: **Actions → Deploy to Azure Web App → Run
workflow**. That is what `workflow_dispatch` in the workflow is for.

---

## 8. Verify

```bash
curl https://<app-name>.azurewebsites.net/healthz
# {"status":"ok","uptime":12.34}
```

Then open the site in a browser and play a wave. The first request after a
deploy is slow — Azure is cold-starting Node.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Deploy step fails with a credentials / Kudu error | Basic auth publishing is off — step 4. Then re-download the publish profile and update the secret; the old one is useless. |
| `Error: Resource ... not found` | `AZURE_WEBAPP_NAME` does not match the real app name — step 3. |
| "Application Error" / HTTP 503 | Check **Log stream** in the portal. Usually the runtime stack is not Node 20, or the startup command was set to something other than `node server.js`. |
| Page loads but stays blank | Open the browser console. The game is served as native ES modules, so every `.js` must come back as `text/javascript` — `server.js` and `web.config` both set that, so this is usually a 404 on a module path. |
| Deploy succeeds but the old version is served | Hard-reload. HTML is served `no-cache` and other assets with a one-hour max-age, so stale assets clear within the hour. |
| All progress "lost" | It is not — progress lives in `localStorage`, which is per-origin. Moving between `http://` and `https://`, or to a custom domain, starts fresh. See Notes. |

Live logs, any time:

```bash
az webapp log tail -g $RG -n $APP
```

---

## Alternative: deploy without a publish profile

If you would rather not enable basic auth, use OIDC federated credentials — no
long-lived secret at all:

```bash
az ad sp create-for-rbac --name turret-trouble-deploy \
  --role contributor \
  --scopes /subscriptions/<sub-id>/resourceGroups/$RG \
  --json-auth
```

Then in the workflow: add `id-token: write` to `permissions`, insert an
`azure/login@v2` step using `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` /
`AZURE_SUBSCRIPTION_ID` secrets, and drop the `publish-profile` input from
`azure/webapps-deploy@v3`.

## Alternative: let Azure write the workflow

**Deployment Center → GitHub** in the portal wires up GitHub Actions for you and
commits its own workflow file. If you do that, **delete
`.github/workflows/azure-webapp.yml`** — otherwise two workflows race to deploy
the same app.

## Alternative: one-off zip deploy, no CI

```bash
zip -r release.zip . -x '*.git*' -x 'archive/*' -x 'test/*' -x 'node_modules/*'
az webapp deploy -g $RG -n $APP --src-path release.zip --type zip
```

## Windows App Service

Works too, if you picked Windows in step 1. `web.config` routes static files
straight out of `public/` and everything else to `server.js` through iisnode.
Set the runtime stack to **Node 20 LTS**; nothing else changes. On Linux,
`web.config` is simply ignored.

---

## What each file in the repo does

| File | Purpose |
|---|---|
| `server.js` | Zero-dependency static server. Binds `process.env.PORT`, which App Service sets. |
| `package.json` | `start` script and `engines.node >= 20`. No dependencies. |
| `web.config` | IIS/iisnode routing. Only read on a **Windows** plan; Linux ignores it. |
| `.deployment` | Turns off the Oryx build (`SCM_DO_BUILD_DURING_DEPLOYMENT=false`) — there is nothing to build. |
| `.github/workflows/azure-webapp.yml` | Build-and-deploy pipeline on push to `main`. |
| `/healthz` | Returns `{"status":"ok"}` — the health check path from step 2. |

## Notes

- **No database.** Player progress is stored per-browser in `localStorage`, so a
  single instance is fine and scale-out needs no session affinity.
- **HTTPS.** Turn on "HTTPS Only". Nothing in the game depends on the origin
  beyond `localStorage`, which is per-origin — switching between `http://` and
  `https://` will look like a lost profile.
- **Custom domain.** Same caveat: progress is tied to the exact origin, so
  moving from `*.azurewebsites.net` to a custom domain starts players fresh.
- **Free tier.** F1 has no Always On, so the app sleeps and the first visit after
  it idles takes a few seconds. B1 and up can enable **Always On**.

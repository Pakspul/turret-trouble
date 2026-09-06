# Deploying Turret Trouble to Azure

The game is **entirely client-side** — plain ES modules, `localStorage`, no
API calls, no build step, no npm dependencies. That means it fits either of two
Azure hosts, and the repo is wired for both:

| | [Azure Static Web Apps](#azure-static-web-apps-default) | [Azure App Service](#alternative-azure-app-service) |
|---|---|---|
| Serves | `public/` straight off a CDN | `server.js` on a Node process |
| Cost | Free tier, no cold start | F1 sleeps; B1+ for Always On |
| Config | `public/staticwebapp.config.json` | `web.config`, `.deployment` |
| Workflow | `azure-static-web-apps.yml` (on push) | `azure-webapp.yml` (manual only) |
| `/healthz` | not available | available |
| PR previews | yes, one per PR | no |

**Static Web Apps is the default** and the shorter path — start there. App
Service is kept for the case where you later want real server-side code.

Either way, check it runs locally first, so a failure later is definitely
Azure's fault:

```bash
npm run check   # syntax-checks every module
npm test        # boots the server, hits /healthz and /
npm start       # then open http://localhost:8080
```

`server.js` stays in the repo regardless — on Static Web Apps it is never
deployed, it is just the local dev server.

---

# Azure Static Web Apps (default)

## 1. Create the Static Web App

### Portal

1. **Create a resource → Static Web App**.
2. Fill in:
   - **Resource Group**: `turret-trouble-rg` (create new)
   - **Name**: `turret-trouble`
   - **Plan type**: `Free`
   - **Region**: whatever is nearest, e.g. `West Europe`
   - **Deployment source**: **Other** — pick this, not GitHub. The repo already
     contains its workflow; letting Azure generate a second one means two
     workflows racing to deploy the same commit.
3. **Review + create → Create**.

### Or the CLI

```bash
RG=turret-trouble-rg
APP=turret-trouble
LOC=westeurope

az group create -n $RG -l $LOC
az staticwebapp create -g $RG -n $APP -l $LOC --sku Free
```

## 2. Put the deployment token into GitHub

1. **Azure portal** → the Static Web App → **Overview → Manage deployment
   token** → copy it. From the CLI instead:

   ```bash
   az staticwebapp secrets list -g $RG -n $APP --query "properties.apiKey" -o tsv
   ```

2. **GitHub** → the repo → **Settings → Secrets and variables → Actions → New
   repository secret**.
   - **Name**: `AZURE_STATIC_WEB_APPS_API_TOKEN` — exactly this, the workflow
     reads it by name.
   - **Secret**: the token.

Treat it like a password; it grants deploy rights. **Reset deployment token** in
the portal invalidates a leaked one.

There is no app name to configure in the workflow — the token identifies the
target. Nothing else needs editing.

## 3. Deploy

Push to `main`:

```bash
git push origin main
```

Then watch **GitHub → Actions → Deploy to Azure Static Web Apps**. The job:

1. checks out the repo,
2. runs `npm run check` — syntax-checks every module,
3. runs `npm test` — the headless simulation,
4. uploads `public/` only.

A broken commit fails at step 2 or 3 and never reaches Azure.

Because `app_location` is `public`, everything outside it — `archive/`,
`test/`, `server.js`, `web.config`, `package.json` — is never uploaded. That is
the same isolation `ROOT` gives `server.js` locally, for free.

## 4. Verify

Open `https://<name>.azurestaticapps.net` (the exact URL is on the app's
Overview blade, and in the GitHub deployment summary) and play a wave.

There is no `/healthz` here — nothing is running to answer it. The check that
matters is the browser console being clean.

## 5. Pull request previews

Every PR against `main` gets its own staging URL, posted as a comment on the PR.
Closing or merging the PR tears it down — that is the `close-preview` job in the
workflow.

PRs **from forks** cannot read the deployment token, so their preview job fails
by design. That is GitHub's secret policy, not a misconfiguration.

## What `staticwebapp.config.json` does

It lives in `public/` because Static Web Apps reads it from the app root. It is
consumed at deploy time and never served to visitors.

- **`mimeTypes`** — `.webmanifest` is not in the default table, so without the
  mapping the PWA manifest is served as `application/octet-stream` and the
  browser ignores it.
- **`globalHeaders`** — `X-Content-Type-Options: nosniff`, matching what
  `server.js` sends.
- **`routes`** — re-creates the caching policy from `server.js`: the HTML shell
  and the manifest `no-cache`, everything else one hour. Routes match in order,
  first one wins.
- **`navigationFallback`** — an unknown path serves the game instead of a 404.
  The `exclude` list is the important half: without it a mistyped module path
  returns `index.html` as `text/html`, and the browser reports a confusing MIME
  error rather than a plain 404.
- `/js/package.json` is 404'd. It exists only to mark the folder as ESM for
  Node tooling and has no business being fetchable.

## Static Web Apps troubleshooting

| Symptom | Cause and fix |
|---|---|
| Deploy fails with `deployment_token was not provided` | The `AZURE_STATIC_WEB_APPS_API_TOKEN` secret is missing or misnamed — step 2. |
| Deploy succeeds, site 404s | `app_location` must be `public`. If Azure generated its own workflow in **Deployment source → GitHub**, delete that file — see step 1. |
| Page loads but stays blank | Browser console. The game is native ES modules, so a 404 on a module path breaks the whole graph. |
| Manifest ignored / no install prompt | The `mimeTypes` entry for `.webmanifest` is missing from `public/staticwebapp.config.json`. |
| Two deploys per push | `azure-webapp.yml` got its `push` trigger back. It is meant to be `workflow_dispatch` only. |
| All progress "lost" | It is not — progress lives in `localStorage`, which is per-origin. Moving from `*.azurewebsites.net` to `*.azurestaticapps.net`, or to a custom domain, starts fresh. See Notes. |

---

# Alternative: Azure App Service

Use this if you want `server.js` actually running — a health probe, real
response headers, or room for server-side code later. It is more steps: the
rest of this document is that path, and `azure-webapp.yml` runs it, but only
when triggered by hand from **Actions → Run workflow**.

## 0. What you need before you start

- An Azure subscription (Free F1 is enough to see it running; B1 if you want it
  to stay warm).
- This repo pushed to GitHub — `https://github.com/Pakspul/turret-trouble`.
- Optional: the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
  if you prefer the terminal over the portal. Both paths are given below.
- The local check from the top of this document, run and passing.

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

This workflow is **manual**: pushing to `main` deploys to Static Web Apps, not
here. Trigger it from **Actions → Deploy to Azure Web App (manual) → Run
workflow**, and watch it there. The job:

1. checks out the repo,
2. runs `npm run check` — syntax-checks every module,
3. runs `npm test` — boots the server and hits `/healthz`,
4. zips the repo minus `.git`, `archive/`, `test/`, `node_modules/`,
5. pushes the zip to App Service.

A broken commit fails at step 2 or 3 and never reaches Azure.

To make App Service the automatic target instead, add a `push` trigger back to
`azure-webapp.yml` — and remove one from `azure-static-web-apps.yml`, or both
will deploy the same commit to two places.

---

## 8. Verify

```bash
curl https://<app-name>.azurewebsites.net/healthz
# {"status":"ok","uptime":12.34}
```

Then open the site in a browser and play a wave. The first request after a
deploy is slow — Azure is cold-starting Node.

---

## App Service troubleshooting

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

| File | Used by | Purpose |
|---|---|---|
| `public/` | both | The whole game. On Static Web Apps this is the entire deployment. |
| `public/staticwebapp.config.json` | SWA | MIME types, headers, caching, navigation fallback. Consumed at deploy time, never served. |
| `.github/workflows/azure-static-web-apps.yml` | SWA | Check, test, deploy on push to `main`; PR previews. |
| `server.js` | App Service, local dev | Zero-dependency static server. Binds `process.env.PORT`, which App Service sets. Not deployed to SWA. |
| `package.json` | both | `start` script and `engines.node >= 20`. No dependencies. |
| `web.config` | App Service (Windows) | IIS/iisnode routing. Only read on a **Windows** plan; Linux ignores it. |
| `.deployment` | App Service | Turns off the Oryx build (`SCM_DO_BUILD_DURING_DEPLOYMENT=false`) — there is nothing to build. |
| `.github/workflows/azure-webapp.yml` | App Service | Same pipeline, zip-deployed. Manual trigger only. |
| `/healthz` | App Service | Returns `{"status":"ok"}` — the health check path from step 2. Does not exist on SWA. |

## Notes

- **No database.** Player progress is stored per-browser in `localStorage`, so a
  single instance is fine and scale-out needs no session affinity.
- **HTTPS.** Turn on "HTTPS Only". Nothing in the game depends on the origin
  beyond `localStorage`, which is per-origin — switching between `http://` and
  `https://` will look like a lost profile.
- **Custom domain.** Same caveat: progress is tied to the exact origin, so
  moving off `*.azurestaticapps.net` or `*.azurewebsites.net` starts players
  fresh. Both hosts support custom domains with a free managed certificate.
- **Free tier.** Static Web Apps Free has no cold start — the files sit on a
  CDN. App Service F1 has no Always On, so the app sleeps and the first visit
  after it idles takes a few seconds; B1 and up can enable **Always On**.
- **HTTPS on SWA** is enforced by the platform; there is no switch to forget.

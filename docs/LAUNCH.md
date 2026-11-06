# Launch checklist

The code for every gap is in the app. These are the steps that need your accounts. Do them in order; each one works without the later ones.

## 1. Email (Postmark), needed for everything

1. In Postmark, create a server named `CanWeUseIt` and add the sender domain `canweuseit.com`.
2. At your domain registrar, add the two DNS records Postmark shows you:
   - a **TXT** record for DKIM (host like `20240101pm._domainkey`, value from Postmark)
   - a **CNAME** for the return path: host `pm-bounces`, value `pm.mtasv.net`
3. Add a DMARC record if you don't have one: TXT at `_dmarc`, value `v=DMARC1; p=none; rua=mailto:you@canweuseit.com`
4. Click Verify in Postmark (DNS can take up to an hour).
5. Put the server token in Secret Manager and on the service as `POSTMARK_TOKEN`. Optional: `MAIL_FROM`, `MAIL_REPLY_TO`.

## 2. Production database and service

```
gcloud sql databases create canweuseit_prod --instance=canweuseit-pg
gcloud sql instances patch canweuseit-pg --backup-start-time=07:00 --enable-point-in-time-recovery --retained-backups-count=14
```

Make `cwui_owner` the owner of the new database (as the `postgres` user in Cloud SQL Studio: `ALTER DATABASE canweuseit_prod OWNER TO cwui_owner;`), then run the migrations against it the same way as staging, with `DB_NAME=canweuseit_prod`.

Secrets (one per value, never in the command history):

```
printf %s "$(openssl rand -base64 48)" | gcloud secrets create cwui-session-prod --data-file=-
```

Deploy:

```
gcloud run deploy cwui-api-prod --source . --region us-east4 --min-instances 1 \
  --add-cloudsql-instances canweuseit-app:us-east4:canweuseit-pg \
  --set-env-vars NODE_ENV=production,APP_URL=https://canweuseit.com,DB_HOST=/cloudsql/canweuseit-app:us-east4:canweuseit-pg,DB_NAME=canweuseit_prod,DB_USER=cwui_app,PLATFORM_ADMIN_EMAILS=you@example.com \
  --set-secrets SESSION_SECRET=cwui-session-prod:latest,DB_PASSWORD=cwui-app-password:latest,POSTMARK_TOKEN=postmark-token:latest
```

Then point `canweuseit.com` at the service. us-east4 supports Cloud Run domain mapping (a Google preview feature; a global load balancer is the heavier option):

```
gcloud domains verify canweuseit.com          # Search Console: add the TXT record it gives you, choose Domain
gcloud beta run domain-mappings create --service cwui-api-prod --domain canweuseit.com --region us-east4
gcloud beta run domain-mappings create --service cwui-api-prod --domain www.canweuseit.com --region us-east4
gcloud beta run domain-mappings describe --domain canweuseit.com --region us-east4
```

Add the A and AAAA records it lists at `@`, and a CNAME `www` → `ghs.googlehosted.com`. On Cloudflare set each one to **DNS only** (grey cloud) and turn off **Always Use HTTPS** until the certificate is issued (15 minutes to 24 hours).

Legal pages (`/privacy`, `/terms`, `/dpa`, `/accessibility`) are drafts. Set `LEGAL_ENTITY`, `LEGAL_CONTACT` and `LEGAL_STATE`, and have a lawyer read them before the first paying customer.

## 3. Card payments (Stripe Connect)

1. In Stripe, turn on Connect (Express accounts) and set your platform profile.
2. Add two webhook endpoints, both to `https://canweuseit.com/stripe/webhook`:
   - **Your account**: events `checkout.session.completed`, `checkout.session.async_payment_succeeded`
   - **Connected accounts**: event `account.updated`
3. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_CONNECT_WEBHOOK_SECRET` on the service. Use test keys on staging.
4. CanWeUseIt takes no fee on card payments (`tenant.platform_fee_bps` is 0). Card payments come with the Community and League plans.

## 4. Text alerts (Twilio)

1. Buy a number, or better, create a Messaging Service. US texting needs A2P 10DLC brand and campaign registration in Twilio, which can take a few days.
2. Set the number's (or service's) incoming message webhook to `https://canweuseit.com/sms/inbound` (HTTP POST).
3. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_MESSAGING_SERVICE_SID` (or `TWILIO_FROM`).

## 5. Satellite map

The map uses Esri World Imagery by default. Check Esri's terms for commercial use and, if needed, get an ArcGIS Location Platform key. Or switch providers with `MAP_TILE_URL` and `MAP_ATTRIBUTION` (for example Mapbox satellite with your token in the URL). Add the tile host to nothing else: the content policy reads it from `MAP_TILE_URL`.

## 6. Club app imports

TeamSnap, SportsEngine and LeagueApps files follow each platform's published import format. Three templates could not be downloaded to double-check column order (TeamSnap team template, SportsEngine upload template, LeagueApps events template). Do one test import into each before telling clubs about it.
